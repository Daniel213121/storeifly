import "dotenv/config";
import express, { Request, Response } from 'express';
import cors from "cors";
import categoryRouter from "./routes/categoryRouters.js";
import uploadRouter from "./routes/uploadRoutes.js";
import { handleUploadError } from "./middleware/upload.js";

const app = express();

// Middleware
app.use(cors())
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

const port = process.env.PORT || 3000;

app.get('/', (_req: Request, res: Response) => {
    res.send('Server is Live!');
});

//api routes

app.use("/api/categories", categoryRouter);
app.use("/api/upload", uploadRouter);

// Must come after the routes: turns multer errors into 400s
app.use(handleUploadError);

app.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
});