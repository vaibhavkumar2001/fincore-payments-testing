import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { pool } from './db';
import { sendError } from './http';
import { accountsRouter } from './routes/accounts';
import { paymentsRouter } from './routes/payments';

export function createApp() {
  const app = express();

  // Must come before the routers, otherwise req.body stays undefined
  app.use(express.json());

  // Health check: confirms the API is up and can reach the database
  app.get('/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok', db: 'up' });
    } catch {
      res.status(503).json({ status: 'degraded', db: 'down' });
    }
  });

  app.use('/accounts', accountsRouter);
  app.use('/payments', paymentsRouter);

  app.use((_req, res) => {
    sendError(res, 404, 'route_not_found', 'Route not found');
  });

  // Central error handler: malformed JSON is a client error, everything else is a server error
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if ((error as { type?: string } | null)?.type === 'entity.parse.failed') {
      return sendError(res, 400, 'invalid_json', 'Request body is not valid JSON');
    }
    console.error(error);
    sendError(res, 500, 'internal_error', 'Unexpected error');
  });

  return app;
}