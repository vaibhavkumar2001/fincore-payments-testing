import { createHash } from 'node:crypto';
import { Router } from 'express';
import { pool } from '../db';
import { sendError } from '../http';
import { createPaymentSchema, formatIssues, isUuid, isValidIdempotencyKey } from '../validation';

interface PaymentRow {
  id: string;
  source_account_id: string;
  destination_account_id: string;
  amount_minor: string;
  currency: string;
  status: string;
  created_at: Date;
}

function toPayment(row: PaymentRow) {
  return {
    id: row.id,
    source_account_id: row.source_account_id,
    destination_account_id: row.destination_account_id,
    amount_minor: Number(row.amount_minor),
    currency: row.currency,
    status: row.status,
    created_at: row.created_at,
  };
}

// Same request body always gives the same hash, so a reused key with a different body can be detected
function hashRequest(body: {
  source_account_id: string;
  destination_account_id: string;
  amount_minor: number;
  currency: string;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        body.source_account_id.toLowerCase(),
        body.destination_account_id.toLowerCase(),
        body.amount_minor,
        body.currency,
      ])
    )
    .digest('hex');
}

export const paymentsRouter = Router();

paymentsRouter.post('/', async (req, res, next) => {
  const key = req.header('Idempotency-Key');
  if (!key) {
    return sendError(res, 400, 'missing_idempotency_key', 'The Idempotency-Key header is required');
  }
  if (!isValidIdempotencyKey(key)) {
    return sendError(
      res,
      400,
      'invalid_idempotency_key',
      'Idempotency-Key must be 8 to 128 characters: letters, digits, dash or underscore'
    );
  }

  const parsed = createPaymentSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'validation_error', 'Invalid payment data', formatIssues(parsed.error));
  }
  const payment = parsed.data;
  const requestHash = hashRequest(payment);

  // Everything below runs in ONE transaction: the key, the payment and the stored response
  // are committed together, or none of them is.
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
        return sendError(
          res,
          422,
          'idempotency_key_reuse',
          'This Idempotency-Key was already used with a different request'
        );
      }
      if (row.response_status === null) {
        return sendError(res, 409, 'request_in_progress', 'A request with this key is still being processed');
      }
      res.set('Idempotent-Replayed', 'true');
      return res.status(row.response_status).json(row.response_body);
    }

    const accounts = await client.query<{ id: string; currency: string; balance_minor: string }>(
      'SELECT id, currency, balance_minor FROM accounts WHERE id = ANY($1::uuid[])',
      [[payment.source_account_id, payment.destination_account_id]]
    );
    const source = accounts.rows.find((a) => a.id === payment.source_account_id.toLowerCase());
    const destination = accounts.rows.find((a) => a.id === payment.destination_account_id.toLowerCase());

    // Business errors roll back the whole transaction, so a failed attempt does not consume the key
    if (!source || !destination) {
      await client.query('ROLLBACK');
      return sendError(res, 404, 'account_not_found', 'Source or destination account not found');
    }
    if (source.currency !== payment.currency || destination.currency !== payment.currency) {
      await client.query('ROLLBACK');
      return sendError(res, 422, 'currency_mismatch', 'Payment and both accounts must use the same currency');
    }
    // Authorization only checks funds. It does not move or hold money (capture will, on Day 4).
    if (Number(source.balance_minor) < payment.amount_minor) {
      await client.query('ROLLBACK');
      return sendError(res, 422, 'insufficient_funds', 'Source account has insufficient funds');
    }

    const inserted = await client.query<PaymentRow>(
      `INSERT INTO payments (source_account_id, destination_account_id, amount_minor, currency, status)
       VALUES ($1, $2, $3, $4, 'authorized')
       RETURNING id, source_account_id, destination_account_id, amount_minor, currency, status, created_at`,
      [source.id, destination.id, payment.amount_minor, payment.currency]
    );
    const body = JSON.parse(JSON.stringify(toPayment(inserted.rows[0])));

    await client.query(
      `UPDATE idempotency_keys
       SET response_status = 201, response_body = $1::jsonb, payment_id = $2
       WHERE key = $3`,
      [JSON.stringify(body), body.id, key]
    );
    await client.query('COMMIT');

    res.status(201).json(body);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    next(error);
  } finally {
    client.release();
  }
});

paymentsRouter.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isUuid(id)) {
      return sendError(res, 400, 'invalid_id', 'Payment id must be a UUID');
    }

    const result = await pool.query<PaymentRow>(
      `SELECT id, source_account_id, destination_account_id, amount_minor, currency, status, created_at
       FROM payments WHERE id = $1`,
      [id]
    );
    if (result.rowCount === 0) {
      return sendError(res, 404, 'payment_not_found', 'Payment not found');
    }
    res.json(toPayment(result.rows[0]));
  } catch (error) {
    next(error);
  }
});