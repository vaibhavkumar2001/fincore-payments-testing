import type { Response } from 'express';

// Every error from the API uses the same shape, so clients and tests can rely on it
export function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
  details?: unknown
) {
  res.status(status).json({ error: { code, message, ...(details ? { details } : {}) } });
}