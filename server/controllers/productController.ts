import { Response } from "express";
import { prisma } from "../config/prisma.js";
import { AuthenticatedRequest } from "../middleware/auth.js";

const VALID_STATUSES = ["active", "draft", "archived"];
const MAX_IMAGES = 10;
const MAX_VARIANTS = 50;

const getMerchantStore = (merchantId: string) =>
    prisma.stores.findFirst({ where: { merchant_id: merchantId }, select: { id: true } });

const isHttpsUrl = (value: unknown) => {
    if (typeof value !== "string") return false;
    try {
        return new URL(value).protocol === "https:";
    } catch {
        return false;
    }
}

const parseId = (value: unknown) => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
}

// Checks the product fields a merchant is allowed to set.
// Returns the cleaned data, or an error message.
// `partial` = true for updates (every field optional).
const parseProductInput = async (body: any, storeId: number, partial: boolean): Promise<{ data: Record<string, any> } | { error: string }> => {
    const data: Record<string, any> = {};
    const has = (key: string) => body?.[key] !== undefined;

    if (!partial || has("name")) {
        if (typeof body?.name !== "string" || !body.name.trim()) return { error: "Product name is required" };
        if (body.name.trim().length > 255) return { error: "Product name must be 255 characters or less" };
        data.name = body.name.trim();
    }
    if (!partial || has("price")) {
        const price = Number(body?.price);
        if (body?.price === undefined || body?.price === "" || !Number.isFinite(price) || price < 0) return { error: "Price must be a number of 0 or more" };
        data.price = price;
    }
    if (has("compare_at_price")) {
        if (body.compare_at_price === null || body.compare_at_price === "") {
            data.compare_at_price = null;
        } else {
            const n = Number(body.compare_at_price);
            if (!Number.isFinite(n) || n < 0) return { error: "compare_at_price must be a number of 0 or more" };
            data.compare_at_price = n;
        }
    }
    if (has("description")) {
        if (typeof body.description !== "string" || body.description.length > 5000) return { error: "Description must be text of 5000 characters or less" };
        data.description = body.description.trim();
    }
    if (has("sku")) {
        if (body.sku !== null && (typeof body.sku !== "string" || body.sku.length > 100)) return { error: "SKU must be text of 100 characters or less" };
        data.sku = body.sku?.trim() || null;
    }
    if (has("stock")) {
        const n = Number(body.stock);
        if (!Number.isInteger(n) || n < 0) return { error: "Stock must be a whole number of 0 or more" };
        data.stock = n;
    }
    if (has("images")) {
        if (!Array.isArray(body.images) || body.images.length > MAX_IMAGES || !body.images.every(isHttpsUrl)) {
            return { error: `images must be a list of up to ${MAX_IMAGES} https URLs` };
        }
        data.images = body.images;
    }
    if (has("variants")) {
        if (!Array.isArray(body.variants) || body.variants.length > MAX_VARIANTS
            || !body.variants.every((v: unknown) => v !== null && typeof v === "object" && !Array.isArray(v))
            || JSON.stringify(body.variants).length > 20000) {
            return { error: `variants must be a list of up to ${MAX_VARIANTS} objects` };
        }
        data.variants = body.variants;
    }
    if (has("status")) {
        if (!VALID_STATUSES.includes(body.status)) return { error: `status must be one of: ${VALID_STATUSES.join(", ")}` };
        data.status = body.status;
    }
    if (has("category_id")) {
        if (body.category_id === null || body.category_id === "") {
            data.category_id = null;
        } else {
            const categoryId = parseId(body.category_id);
            // The category must belong to this merchant's store
            const category = categoryId
                ? await prisma.categories.findFirst({ where: { id: categoryId, store_id: storeId }, select: { id: true } })
                : null;
            if (!category) return { error: "Category not found in your store" };
            data.category_id = category.id;
        }
    }
    return { data };
}


// Create a product in the merchant's store
export const createProduct = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
        const store = await getMerchantStore(req.user!.id);
        if (!store) {
            res.status(404).json({ success: false, message: "You must create a store before adding products" });
            return;
        }

        const parsed = await parseProductInput(req.body, store.id, false);
        if ("error" in parsed) {
            res.status(400).json({ success: false, message: parsed.error });
            return;
        }

        const product = await prisma.products.create({
            data: {
                ...parsed.data,
                name: parsed.data.name,
                price: parsed.data.price,
                store_id: store.id,
            },
        });
        res.status(201).json({ success: true, message: "Product created successfully", product });
    } catch (error) {
        console.error("createProduct error:", error);
        res.status(500).json({ success: false, message: "Failed to create product" });
    }
}

// Update a product (only if it belongs to the merchant's store)
export const updateProduct = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
        const id = parseId(req.params.id);
        if (!id) {
            res.status(400).json({ success: false, message: "Invalid product id" });
            return;
        }

        const store = await getMerchantStore(req.user!.id);
        if (!store) {
            res.status(404).json({ success: false, message: "You have not created a store yet" });
            return;
        }

        const existing = await prisma.products.findFirst({ where: { id, store_id: store.id }, select: { id: true } });
        if (!existing) {
            res.status(404).json({ success: false, message: "Product not found" });
            return;
        }

        const parsed = await parseProductInput(req.body, store.id, true);
        if ("error" in parsed) {
            res.status(400).json({ success: false, message: parsed.error });
            return;
        }
        if (Object.keys(parsed.data).length === 0) {
            res.status(400).json({ success: false, message: "No valid fields to update" });
            return;
        }

        const product = await prisma.products.update({ where: { id }, data: parsed.data });
        res.status(200).json({ success: true, message: "Product updated successfully", product });
    } catch (error) {
        console.error("updateProduct error:", error);
        res.status(500).json({ success: false, message: "Failed to update product" });
    }
}

// Delete a product (only if it belongs to the merchant's store)
export const deleteProduct = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
        const id = parseId(req.params.id);
        if (!id) {
            res.status(400).json({ success: false, message: "Invalid product id" });
            return;
        }

        const store = await getMerchantStore(req.user!.id);
        if (!store) {
            res.status(404).json({ success: false, message: "You have not created a store yet" });
            return;
        }

        const result = await prisma.products.deleteMany({ where: { id, store_id: store.id } });
        if (result.count === 0) {
            res.status(404).json({ success: false, message: "Product not found" });
            return;
        }
        res.status(200).json({ success: true, message: "Product deleted successfully" });
    } catch (error) {
        console.error("deleteProduct error:", error);
        res.status(500).json({ success: false, message: "Failed to delete product" });
    }
}
