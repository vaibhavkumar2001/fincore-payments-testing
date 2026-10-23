import express from "express";
import { pool } from "./db";


export function createApp() {
    const app = express();
    app.use(express.json());

    //Now this is confirms that the api is UP and reach the database
    app.get('/health', async (_req,res) => {
        try {
            await pool.query('SELECT 1');
            res.json({ status: 'ok', db: 'up' });
        } catch {
            res.json(503).json({ status: 'degraded', db: 'down' });
        }
    })

    return app
}