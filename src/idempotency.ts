import type { Response } from 'express';
import type { PoolClient } from 'pg';
import { pool } from './db';
import { sendError } from './http';
import { isValidIdempotencyKey } from './validation';

// What a unit of work returns. A failure rolls the whole transaction back, so it never uses up the key.
export type Outcome =
  | { kind: 'success'; status: number; body: unknown; paymentId?: string }
  | { kind: 'failure'; status: number; code: string; message: string; details?: unknown };

// Reads and validates the Idempotency-Key header. Sends the error response and returns null when invalid.
export function readIdempotencyKey(headerValue: string | undefined, res: Response): string | null {
  if (!headerValue) {
    sendError(res, 400, 'missing_idempotency_key', 'The Idempotency-Key header is required');
    return null;
  }
  if (!isValidIdempotencyKey(headerValue)) {
    sendError(
      res,
      400,
      'invalid_idempotency_key',
      'Idempotency-Key must be 8 to 128 characters: letters, digits, dash or underscore'
    );
    return null;
  }
  return headerValue;
}

// Runs `work` at most once per Idempotency-Key.
// The key, the business change and the stored response are committed together, or not at all.
export async function runIdempotent(params: {
  key: string;
  requestHash: string;
  res: Response;
  work: (client: PoolClient) => Promise<Outcome>;
}): Promise<void> {
  const { key, requestHash, res, work } = params;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Claim the key. If another request holds the same key, this INSERT waits for it to finish
    // (unique index), then does nothing, and we replay its stored response below.
    const claim = await client.query(
      `INSERT INTO idempotency_keys (key, request_hash)
       VALUES ($1, $2)
       ON CONFLICT (key) DO NOTHING
       RETURNING key`,
      [key, requestHash]
    );

    if (claim.rowCount === 0) {
      const existing = await client.query<{
        request_hash: string;
        response_status: number | null;
        response_body: unknown;
      }>('SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE key = $1', [key]);
      await client.query('ROLLBACK');

      const row = existing.rows[0];
      if (row.request_hash !== requestHash) {
        sendError(res, 422, 'idempotency_key_reuse', 'This Idempotency-Key was already used with a different request');
        return;
      }
      if (row.response_status === null) {
        sendError(res, 409, 'request_in_progress', 'A request with this key is still being processed');
        return;
      }
      res.set('Idempotent-Replayed', 'true');
      res.status(row.response_status).json(row.response_body);
      return;
    }

    const outcome = await work(client);

    if (outcome.kind === 'failure') {
      await client.query('ROLLBACK');
      sendError(res, outcome.status, outcome.code, outcome.message, outcome.details);
      return;
    }

    // Round trip through JSON so the stored body is exactly what the client receives
    const body = JSON.parse(JSON.stringify(outcome.body));
    await client.query(
      `UPDATE idempotency_keys
       SET response_status = $1, response_body = $2::jsonb, payment_id = $3
       WHERE key = $4`,
      [outcome.status, JSON.stringify(body), outcome.paymentId ?? null, key]
    );
    await client.query('COMMIT');

    res.status(outcome.status).json(body);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}