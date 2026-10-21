import { Router } from "express";
import { getCategories, createCategory, deleteCategory } from "../controllers/categoryController.js";
import { requireAuth, requireRole } from "../middleware/auth.js";


const categoryRouter = Router();

//public / custer can view categories
categoryRouter.get("/", getCategories);

// Merchant can manage categories
categoryRouter.post("/",requireAuth, requireRole(['merchant']), createCategory)
categoryRouter.delete("/:id", requireAuth, requireRole(['merchant']), deleteCategory)


export default categoryRouter;