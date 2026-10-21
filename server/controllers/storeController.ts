import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth.js";
import { prisma } from "../config/prisma.js";
import { updateNeonUserRole, findNeonUserByIds, findNeonMerchants } from "../services/neonUser.js";

// Generate a slug from a text
const generateSlug = (text: string) => text.toString().toLowerCase().trim()
.replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

const VALID_HEROES = ["hero1", "hero2", "hero3", "hero4"];
const VALID_PAYMENT_METHODS = ["mobile_money", "cash_on_delivery", "bank_transfer"];
const VALID_STATUSES = ["active", "suspended"];

const isHttpsUrl = (value: string) => {
    try {
        return new URL(value).protocol === "https:";
    } catch {
        return false;
    }
}

// Checks the store fields a merchant is allowed to set.
// Returns the cleaned data, or an error message.
// `partial` = true for updates (every field optional).
const parseStoreInput = (body: any, partial: boolean): { data: Record<string, any> } | { error: string } => {
    const data: Record<string, any> = {};
    const has = (key: string) => body?.[key] !== undefined;

    if (!partial || has("name")) {
        if (typeof body?.name !== "string" || !body.name.trim()) return { error: "Store name is required" };
        if (body.name.trim().length > 255) return { error: "Store name must be 255 characters or less" };
        data.name = body.name.trim();
    }
    if (has("description")) {
        if (typeof body.description !== "string" || body.description.length > 2000) return { error: "Description must be text of 2000 characters or less" };
        data.description = body.description.trim();
    }
    if (has("address")) {
        if (typeof body.address !== "string" || body.address.length > 500) return { error: "Address must be text of 500 characters or less" };
        data.address = body.address.trim();
    }
    for (const key of ["logo_url", "banner_url"]) {
        if (has(key)) {
            if (body[key] === "" || body[key] === null) { data[key] = null; continue; }
            if (typeof body[key] !== "string" || !isHttpsUrl(body[key])) return { error: `${key} must be an https URL` };
            data[key] = body[key];
        }
    }
    if (has("currency")) {
        if (typeof body.currency !== "string" || !/^[A-Za-z]{3}$/.test(body.currency)) return { error: "Currency must be a 3-letter code, e.g. GHS" };
        data.currency = body.currency.toUpperCase();
    }
    for (const key of ["shipping_fee", "free_shipping_threshold"]) {
        if (has(key)) {
            const n = Number(body[key]);
            if (!Number.isFinite(n) || n < 0) return { error: `${key} must be a number of 0 or more` };
            data[key] = n;
        }
    }
    if (has("payment_methods")) {
        const pm = body.payment_methods;
        if (!Array.isArray(pm) || pm.length === 0 || !pm.every((m) => VALID_PAYMENT_METHODS.includes(m))) {
            return { error: `payment_methods must be a list using: ${VALID_PAYMENT_METHODS.join(", ")}` };
        }
        data.payment_methods = [...new Set(pm)];
    }
    if (has("hero_style")) {
        if (!VALID_HEROES.includes(body.hero_style)) return { error: `hero_style must be one of: ${VALID_HEROES.join(", ")}` };
        data.hero_style = body.hero_style;
    }
    if (has("accent_color")) {
        if (typeof body.accent_color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(body.accent_color.trim())) return { error: "accent_color must be a hex colour, e.g. #059669" };
        data.accent_color = body.accent_color.trim();
    }
    return { data };
}

// Prisma error code for a unique constraint (e.g. slug already used)
const isUniqueError = (error: any) => error?.code === "P2002";


// Create a new store. Any logged-in user (except platform admins) can create one,
// and becomes a merchant when they do.
export const createStore = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
        const merchantId = req.user!.id;

        // Platform Admin account cannot create a store or become a merchant
        if (req.user!.role === "admin") {
            res.status(403).json({ success: false, message: "Platform admin accounts cannot create a store" });
            return;
        }

        // Check if merchant already has a store
        const existingStore = await prisma.stores.findFirst({ where: { merchant_id: merchantId }, select: { id: true } });
        if (existingStore) {
            res.status(400).json({ success: false, message: "You already have a store" });
            return;
        }

        const parsed = parseStoreInput(req.body, false);
        if ("error" in parsed) {
            res.status(400).json({ success: false, message: parsed.error });
            return;
        }

        const slugSource = typeof req.body?.slug === "string" && req.body.slug.trim() ? req.body.slug : parsed.data.name;
        const finalSlug = generateSlug(slugSource);
        if (!finalSlug) {
            res.status(400).json({ success: false, message: "Store name or slug must contain letters or numbers" });
            return;
        }

        // Check if slug is already taken
        const slugCheck = await prisma.stores.findUnique({ where: { slug: finalSlug }, select: { id: true } });
        if (slugCheck) {
            res.status(409).json({ success: false, message: "That store URL is already taken" });
            return;
        }

        const newStore = await prisma.stores.create({
            data: {
                currency: "GHS",
                ...parsed.data,
                name: parsed.data.name,
                merchant_id: merchantId,
                slug: finalSlug,
                status: "active", // merchants can't choose their own status
            },
        });

        // Update user role to merchant (never downgrades an admin)
        await updateNeonUserRole(merchantId, "merchant");

        res.status(201).json({ success: true, message: "Store created successfully", store: newStore });
    } catch (error) {
        if (isUniqueError(error)) {
            res.status(409).json({ success: false, message: "That store URL is already taken" });
            return;
        }
        console.error("createStore error:", error);
        res.status(500).json({ success: false, message: "Failed to create store" });
    }
};

// Onboard or elevate a user to the merchant role (without creating a store yet)
export const onboardMerchant = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
        const userId = req.user!.id;

        // Platform Admin accounts cannot become merchants
        if (req.user!.role === "admin") {
            res.status(403).json({ success: false, message: "Platform admin accounts cannot become merchants" });
            return;
        }

        await updateNeonUserRole(userId, "merchant");
        const store = await prisma.stores.findFirst({ where: { merchant_id: userId } });

        res.status(200).json({ success: true, role: "merchant", store: store ?? null });
    } catch (error) {
        console.error("onboardMerchant error:", error);
        res.status(500).json({ success: false, message: "Failed to onboard merchant" });
    }
};

// Get authenticated merchant's store
export const getMyStore = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
        const store = await prisma.stores.findFirst({ where: { merchant_id: req.user!.id } });
        if (!store) {
            res.status(404).json({ success: false, message: "You have not created a store yet" });
            return;
        }
        res.status(200).json({ success: true, store });
    } catch (error) {
        console.error("getMyStore error:", error);
        res.status(500).json({ success: false, message: "Failed to get store" });
    }
};

// Update merchant's store settings (slug and status can't be changed here)
export const updateMyStore = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
        const store = await prisma.stores.findFirst({ where: { merchant_id: req.user!.id }, select: { id: true } });
        if (!store) {
            res.status(404).json({ success: false, message: "You have not created a store yet" });
            return;
        }

        const parsed = parseStoreInput(req.body, true);
        if ("error" in parsed) {
            res.status(400).json({ success: false, message: parsed.error });
            return;
        }
        if (Object.keys(parsed.data).length === 0) {
            res.status(400).json({ success: false, message: "No valid fields to update" });
            return;
        }

        const updated = await prisma.stores.update({ where: { id: store.id }, data: parsed.data });
        res.status(200).json({ success: true, message: "Store updated successfully", store: updated });
    } catch (error) {
        console.error("updateMyStore error:", error);
        res.status(500).json({ success: false, message: "Failed to update store" });
    }
};

// Platform Admin: get all stores with stats
export const getAllStores = async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
        const stores = await prisma.stores.findMany({
            orderBy: { created_at: "desc" },
            include: { _count: { select: { products: true, orders: true, categories: true } } },
        });

        // Merchants live in Neon Auth, not in Prisma, so look them up separately
        const users = await findNeonUserByIds(stores.map((s) => s.merchant_id).filter((id): id is string => !!id));

        res.status(200).json({
            success: true,
            stores: stores.map((s) => {
                const m = s.merchant_id ? users[s.merchant_id] : undefined;
                return { ...s, merchant: m ? { id: m.id, name: m.name, email: m.email } : null };
            }),
        });
    } catch (error) {
        console.error("getAllStores error:", error);
        res.status(500).json({ success: false, message: "Failed to fetch stores" });
    }
};

//  
export const getAllMerchants = async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
        const merchants = await findNeonMerchants();

        const stores = merchants.length
            ? await prisma.stores.findMany({
                where: { merchant_id: { in: merchants.map((m) => m.id) } },
                select: { id: true, name: true, slug: true, status: true, merchant_id: true },
            })
            : [];
        const byMerchant = new Map(stores.map((s) => [s.merchant_id, s]));

        res.status(200).json({
            success: true,
            merchants: merchants.map((m) => {
                const store = byMerchant.get(m.id);
                return {
                    ...m,
                    store_id: store?.id ?? null,
                    store_name: store?.name ?? null,
                    store_slug: store?.slug ?? null,
                    store_status: store?.status ?? null,
                };
            }),
        });
    } catch (error) {
        console.error("getAllMerchants error:", error);
        res.status(500).json({ success: false, message: "Failed to fetch merchants" });
    }
};

// Platform Admin: Toggle store status (active / suspended).
// Send { status } to set it directly, or nothing to flip it.
export const toggleStoreStatus = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
            res.status(400).json({ success: false, message: "Invalid store id" });
            return;
        }

        const requested = req.body?.status;
        if (requested !== undefined && !VALID_STATUSES.includes(requested)) {
            res.status(400).json({ success: false, message: 'status must be "active" or "suspended"' });
            return;
        }

        const store = await prisma.stores.findUnique({ where: { id }, select: { id: true, status: true } });
        if (!store) {
            res.status(404).json({ success: false, message: "Store not found" });
            return;
        }

        const status = requested ?? (store.status === "active" ? "suspended" : "active");
        const updated = await prisma.stores.update({ where: { id }, data: { status } });
        res.status(200).json({ success: true, message: `Store has been ${status === "active" ? "activated" : "suspended"}`, store: updated });
    } catch (error) {
        console.error("toggleStoreStatus error:", error);
        res.status(500).json({ success: false, message: "Failed to update store status" });
    }
};
