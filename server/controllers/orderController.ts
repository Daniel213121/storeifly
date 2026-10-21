import { Request, Response } from "express";
import { randomBytes } from "node:crypto";
import { prisma } from "../config/prisma.js";
import { Prisma } from "../generated/prisma/client.js";

const { Decimal } = Prisma;
import { AuthenticatedRequest } from "../middleware/auth.js";
import { isNeonEmailVerified } from "../services/neonUser.js";

const ORDER_STATUSES = ["placed", "pending", "processing", "shipped", "delivered", "cancelled"];
const MAX_LINE_ITEMS = 50;
const MAX_QUANTITY = 100;

// Thrown inside the checkout transaction to roll it back with a 400 message
class CheckoutError extends Error {}

const parseId = (value: unknown) => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
}

const isEmail = (value: unknown): value is string =>
    typeof value === "string" && value.length <= 255 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

// e.g. "ORD-7K2QX9MBT4WZ": random, so receipts can't be found by guessing
const generateOrderNumber = () => {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const bytes = randomBytes(12);
    return "ORD-" + Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

// The address can be one line of text or an object of text fields
const parseShippingAddress = (value: unknown): string | Record<string, string> | null => {
    if (typeof value === "string") {
        return value.trim() && value.length <= 500 ? value.trim() : null;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
        const entries = Object.entries(value);
        if (entries.length === 0 || entries.length > 10) return null;
        if (!entries.every(([, v]) => typeof v === "string" && v.length <= 200)) return null;
        return Object.fromEntries(entries.map(([k, v]) => [k.slice(0, 50), (v as string).trim()]));
    }
    return null;
}

// Combines duplicate products and checks quantities: [{ productId, quantity }]
const parseItems = (value: unknown): Map<number, number> | null => {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_LINE_ITEMS) return null;
    const items = new Map<number, number>();
    for (const item of value) {
        const productId = parseId(item?.productId ?? item?.product_id);
        const quantity = Number(item?.quantity);
        if (!productId || !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) return null;
        items.set(productId, (items.get(productId) ?? 0) + quantity);
    }
    for (const qty of items.values()) if (qty > MAX_QUANTITY) return null;
    return items;
}


// Checkout: anyone can place an order. Logged-in customers get it linked to their account.
// Prices always come from the database, never from the request.
export const createOrder = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
        const body = req.body ?? {};
        const storeId = parseId(body.storeId ?? body.store_id);
        const customerName = typeof body.customerName === "string" ? body.customerName.trim() : "";
        const customerEmail = typeof body.customerEmail === "string" ? body.customerEmail.trim().toLowerCase() : "";
        const customerPhone = typeof body.customerPhone === "string" ? body.customerPhone.trim() : undefined;
        const shippingAddress = parseShippingAddress(body.shippingAddress);
        const items = parseItems(body.items);

        if (!storeId) { res.status(400).json({ success: false, message: "A valid storeId is required" }); return; }
        if (!customerName || customerName.length > 255) { res.status(400).json({ success: false, message: "Customer name is required" }); return; }
        if (!isEmail(customerEmail)) { res.status(400).json({ success: false, message: "A valid customer email is required" }); return; }
        if (customerPhone !== undefined && customerPhone.length > 50) { res.status(400).json({ success: false, message: "Phone number is too long" }); return; }
        if (!shippingAddress) { res.status(400).json({ success: false, message: "A shipping address is required" }); return; }
        if (!items) { res.status(400).json({ success: false, message: `items must be a list of 1-${MAX_LINE_ITEMS} { productId, quantity } with quantity 1-${MAX_QUANTITY}` }); return; }

        const store = await prisma.stores.findUnique({
            where: { id: storeId },
            select: { id: true, status: true, shipping_fee: true, free_shipping_threshold: true, payment_methods: true },
        });
        if (!store || store.status !== "active") {
            res.status(404).json({ success: false, message: "Store not found" });
            return;
        }

        const paymentMethod = body.paymentMethod ?? body.payment_method ?? store.payment_methods[0];
        if (!store.payment_methods.includes(paymentMethod)) {
            res.status(400).json({ success: false, message: `This store accepts: ${store.payment_methods.join(", ")}` });
            return;
        }

        const order = await prisma.$transaction(async (tx) => {
            const products = await tx.products.findMany({
                where: { id: { in: [...items.keys()] }, store_id: store.id, status: "active" },
                select: { id: true, name: true, price: true, images: true },
            });
            if (products.length !== items.size) throw new CheckoutError("One or more products are unavailable");

            let subtotal = new Decimal(0);
            const lineItems = products.map((p) => {
                const quantity = items.get(p.id)!;
                const lineTotal = p.price.mul(quantity);
                subtotal = subtotal.add(lineTotal);
                const images = Array.isArray(p.images) ? p.images : [];
                return {
                    product_id: p.id,
                    name: p.name,
                    price: p.price.toFixed(2),
                    quantity,
                    line_total: lineTotal.toFixed(2),
                    image: typeof images[0] === "string" ? images[0] : null,
                };
            });

            // Reserve stock: only succeeds if enough is left, so two buyers can't both take the last one
            for (const [productId, quantity] of items) {
                const updated = await tx.products.updateMany({
                    where: { id: productId, stock: { gte: quantity } },
                    data: { stock: { decrement: quantity } },
                });
                if (updated.count === 0) {
                    const name = products.find((p) => p.id === productId)?.name ?? "A product";
                    throw new CheckoutError(`${name} is out of stock or doesn't have enough left`);
                }
            }

            const shippingFee = store.shipping_fee ?? new Decimal(0);
            const freeFrom = store.free_shipping_threshold ?? new Decimal(0);
            const shippingCost = freeFrom.gt(0) && subtotal.gte(freeFrom) ? new Decimal(0) : shippingFee;

            return tx.orders.create({
                data: {
                    order_number: generateOrderNumber(),
                    store_id: store.id,
                    customer_id: req.user?.id ?? null,
                    customer_name: customerName,
                    customer_email: customerEmail,
                    customer_phone: customerPhone || null,
                    shipping_address: shippingAddress,
                    items: lineItems,
                    subtotal,
                    shipping_cost: shippingCost,
                    discount: 0,
                    total: subtotal.add(shippingCost),
                    payment_method: paymentMethod,
                },
            });
        });

        res.status(201).json({ success: true, message: "Order placed successfully", order });
    } catch (error) {
        if (error instanceof CheckoutError) {
            res.status(400).json({ success: false, message: error.message });
            return;
        }
        console.error("createOrder error:", error);
        res.status(500).json({ success: false, message: "Failed to place order" });
    }
}

// Merchant: orders for their store, optionally filtered with ?status=
export const getMerchantOrders = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
        const store = await prisma.stores.findFirst({ where: { merchant_id: req.user!.id }, select: { id: true } });
        if (!store) {
            res.status(404).json({ success: false, message: "You have not created a store yet" });
            return;
        }

        const { status } = req.query;
        if (status !== undefined && (typeof status !== "string" || !ORDER_STATUSES.includes(status))) {
            res.status(400).json({ success: false, message: `status must be one of: ${ORDER_STATUSES.join(", ")}` });
            return;
        }

        const orders = await prisma.orders.findMany({
            where: { store_id: store.id, ...(status ? { order_status: status as string } : {}) },
            orderBy: { created_at: "desc" },
        });
        res.status(200).json({ success: true, orders });
    } catch (error) {
        console.error("getMerchantOrders error:", error);
        res.status(500).json({ success: false, message: "Failed to fetch orders" });
    }
}

// Merchant: change an order's status. Cancelling puts the stock back.
export const updateOrderStatus = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
        const id = parseId(req.params.id);
        if (!id) {
            res.status(400).json({ success: false, message: "Invalid order id" });
            return;
        }

        const status = req.body?.status;
        if (!ORDER_STATUSES.includes(status)) {
            res.status(400).json({ success: false, message: `status must be one of: ${ORDER_STATUSES.join(", ")}` });
            return;
        }

        const store = await prisma.stores.findFirst({ where: { merchant_id: req.user!.id }, select: { id: true } });
        if (!store) {
            res.status(404).json({ success: false, message: "You have not created a store yet" });
            return;
        }

        const order = await prisma.orders.findFirst({ where: { id, store_id: store.id }, select: { id: true, order_status: true, items: true } });
        if (!order) {
            res.status(404).json({ success: false, message: "Order not found" });
            return;
        }
        if (order.order_status === "cancelled") {
            res.status(400).json({ success: false, message: "Cancelled orders can't be changed" });
            return;
        }

        const updated = await prisma.$transaction(async (tx) => {
            if (status === "cancelled") {
                const items = Array.isArray(order.items) ? (order.items as any[]) : [];
                for (const item of items) {
                    const productId = parseId(item?.product_id);
                    const quantity = Number(item?.quantity);
                    if (productId && Number.isInteger(quantity) && quantity > 0) {
                        // updateMany: the product may have been deleted since
                        await tx.products.updateMany({ where: { id: productId }, data: { stock: { increment: quantity } } });
                    }
                }
            }
            return tx.orders.update({ where: { id }, data: { order_status: status } });
        });

        res.status(200).json({ success: true, message: `Order is now ${status}`, order: updated });
    } catch (error) {
        console.error("updateOrderStatus error:", error);
        res.status(500).json({ success: false, message: "Failed to update order status" });
    }
}

// Public receipt by order number (order numbers are random, so they work like a private link)
export const getOrderReceipt = async (req: Request, res: Response): Promise<void> => {
    try {
        const orderNumber = req.params.orderNumber;
        if (typeof orderNumber !== "string" || orderNumber.length > 100) {
            res.status(404).json({ success: false, message: "Order not found" });
            return;
        }

        const order = await prisma.orders.findUnique({
            where: { order_number: orderNumber },
            include: { stores: { select: { id: true, name: true, slug: true, logo_url: true, currency: true, accent_color: true } } },
        });
        if (!order) {
            res.status(404).json({ success: false, message: "Order not found" });
            return;
        }

        const { stores, customer_id: _customerId, ...rest } = order;
        res.status(200).json({ success: true, order: { ...rest, store: stores } });
    } catch (error) {
        console.error("getOrderReceipt error:", error);
        res.status(500).json({ success: false, message: "Failed to fetch receipt" });
    }
}

// Logged-in customer: their own orders, plus guest orders placed with their email
// (only if that email is verified). Optional ?storeSlug= or ?storeId= to show one store.
export const getCustomerOrders = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
        const { id: userId, email: userEmail } = req.user!;
        const { storeSlug, storeId } = req.query;

        let storeFilter: { store_id: number } | {} = {};
        if (storeSlug !== undefined || storeId !== undefined) {
            const id = parseId(storeId);
            const store = typeof storeSlug === "string" && storeSlug
                ? await prisma.stores.findUnique({ where: { slug: storeSlug }, select: { id: true } })
                : id ? await prisma.stores.findUnique({ where: { id }, select: { id: true } }) : null;
            if (!store) {
                res.status(404).json({ success: false, message: "Store not found" });
                return;
            }
            storeFilter = { store_id: store.id };
        }

        // Anyone can sign up with any email, so only trust it once it's verified
        const matchEmail = userEmail && await isNeonEmailVerified(userId);

        const orders = await prisma.orders.findMany({
            where: {
                ...storeFilter,
                OR: [
                    { customer_id: userId },
                    ...(matchEmail ? [{ customer_email: { equals: userEmail, mode: "insensitive" as const } }] : []),
                ],
            },
            orderBy: { created_at: "desc" },
            include: { stores: { select: { id: true, name: true, slug: true } } },
        });
        res.status(200).json({ success: true, orders });
    } catch (error) {
        console.error("getCustomerOrders error:", error);
        res.status(500).json({ success: false, message: "Failed to fetch your orders" });
    }
}
