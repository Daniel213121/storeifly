import { Request, Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth.js";
import { prisma } from "../config/prisma.js";


// "Summer Sale!" -> "summer-sale"
const generateSlug = (text: string) => text.toString().toLowerCase().trim()
.replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

const getStore = (merchantId: string) => prisma.stores.findFirst({ where: { merchant_id: merchantId } });

export const getCategories = async (req: Request, res: Response): Promise<void> => {
    try {
        const { store_id, storeSlug } = req.query;
        let targetStoreId: number | null = null;

        if (typeof storeSlug === 'string' && storeSlug) {
            const store = await prisma.stores.findUnique({ where: { slug: storeSlug }, select: { id: true } });
            if (!store) {
                res.status(404).json({ success: false, message: 'Store not found' });
                return;
            }
            targetStoreId = store.id;
        } else if (store_id) {
            const id = Number(store_id);
            if (Number.isInteger(id) && id > 0) targetStoreId = id;
        }
        if (!targetStoreId) {
            res.status(400).json({ success: false, message: 'Missing or invalid store_id or storeSlug query parameter' });
            return;
        }

        const list = await prisma.categories.findMany({
            where: { store_id: targetStoreId },
            include: { _count: { select: { products: true } } },
            orderBy: { name: 'asc' }
        });

        const categories = list.map(({ _count, ...rest }) => ({ ...rest, product_count: _count.products }));
        res.status(200).json({ success: true, data: categories });
    } catch (error) {
        console.error("getCategories error:", error);
        res.status(500).json({ success: false, message: 'Failed to fetch categories' });
    }
}

export const createCategory = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
        const store = await getStore(req.user!.id);
        if (!store) {
            res.status(404).json({ success: false, message: 'Store not found' });
            return;
        }

        const { name } = req.body ?? {};
        if (typeof name !== 'string' || !name.trim()) {
            res.status(400).json({ success: false, message: 'Category name is required' });
            return;
        }
        if (name.trim().length > 255) {
            res.status(400).json({ success: false, message: 'Category name must be 255 characters or less' });
            return;
        }

        const slug = generateSlug(name);
        if (!slug) {
            res.status(400).json({ success: false, message: 'Category name must contain letters or numbers' });
            return;
        }

        const existing = await prisma.categories.findFirst({ where: { store_id: store.id, slug } });
        if (existing) {
            res.status(409).json({ success: false, message: 'A category with this name already exists' });
            return;
        }

        const category = await prisma.categories.create({
            data: {
                store_id: store.id,
                name: name.trim(),
                slug,
            },
        });
        res.status(201).json({ success: true, data: category });
    } catch (error) {
        console.error("createCategory error:", error);
        res.status(500).json({ success: false, message: 'Failed to create category' });
    }
}

export const deleteCategory = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
            res.status(400).json({ success: false, message: 'Invalid category id' });
            return;
        }

        const store = await getStore(req.user!.id);
        if (!store) {
            res.status(404).json({ success: false, message: 'Store not found' });
            return;
        }

        // Only deletes if the category belongs to this merchant's store.
        // Products in this category are kept and unlinked (ON DELETE SET NULL).
        const result = await prisma.categories.deleteMany({ where: { id, store_id: store.id } });
        if (result.count === 0) {
            res.status(404).json({ success: false, message: 'Category not found' });
            return;
        }
        res.status(200).json({ success: true, message: 'Category deleted successfully' });
    } catch (error) {
        console.error("deleteCategory error:", error);
        res.status(500).json({ success: false, message: 'Failed to delete category' });
    }
}
