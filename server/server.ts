import "dotenv/config";
import express, { Request, Response } from 'express';
import cors from "cors";
import categoryRouter from "./routes/categoryRouters.js";

const app = express();

// Middleware
app.use(cors())
app.use(express.json());

const port = process.env.PORT || 3000;

app.get('/', (req: Request, res: Response) => {
    res.send('Server is Live!');
});

//api routes

app.use("/categories", categoryRouter);

app.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
});