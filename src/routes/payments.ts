import { createHash } from 'node:crypto';
import { Router } from 'express';
import type { PoolClient } from 'pg';
import { pool } from '../db';
import { sendError } from '../http';
import { readIdempotencyKey, runIdempotent } from '../idempotency';
import type { Outcome } from '../idempotency';
import { createPaymentSchema, formatIssues, isUuid, refundSchema } from '../validation';

interface PaymentRow {
  id: string;
  source_account_id: string;
  destination_account_id: string;
  amount_minor: string;
  refunded_minor: string;
  currency: string;
  status: string;
  created_at: Date;
}

const PAYMENT_COLUMNS = `id, source_account_id, destination_account_id, amount_minor,
  refunded_minor, currency, status, created_at`;

function toPayment(row: PaymentRow) {
  return {
    id: row.id,
    source_account_id: row.source_account_id,
    destination_account_id: row.destination_account_id,
    amount_minor: Number(row.amount_minor),
    refunded_minor: Number(row.refunded_minor),
    currency: row.currency,
    status: row.status,
    created_at: row.created_at,
  };
}

// The same operation with the same input always gives the same hash,
// so a reused key with a different request can be detected.
function hashRequest(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

// Locks both accounts in a fixed order (by id). Two payments that move money in opposite
// directions would otherwise lock the same rows in opposite order and deadlock.
async function lockAccounts(client: PoolClient, ids: string[]) {
  const result = await client.query<{ id: string; balance_minor: string; currency: string }>(
    'SELECT id, balance_minor, currency FROM accounts WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
    [ids]
  );
  return new Map(result.rows.map((row) => [row.id, row]));
}

function invalidTransition(from: string, action: string) {
  return {
    status: 409,
    code: 'invalid_state_transition',
    message: `A payment that is ${from} cannot be ${action}d`,
    details: { from, action },
  };
}

export const paymentsRouter = Router();

// ---------- create (authorize) ----------
paymentsRouter.post('/', async (req, res, next) => {
  try {
    const key = readIdempotencyKey(req.header('Idempotency-Key'), res);
    if (!key) return;

    const parsed = createPaymentSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, 'validation_error', 'Invalid payment data', formatIssues(parsed.error));
    }
    const payment = parsed.data;
    const requestHash = hashRequest([
      'create_payment',
      payment.source_account_id.toLowerCase(),
      payment.destination_account_id.toLowerCase(),
      payment.amount_minor,
      payment.currency,
    ]);

    await runIdempotent({
      key,
      requestHash,
      res,
      work: async (client): Promise<Outcome> => {
        const accounts = await client.query<{ id: string; currency: string; balance_minor: string }>(
          'SELECT id, currency, balance_minor FROM accounts WHERE id = ANY($1::uuid[])',
          [[payment.source_account_id, payment.destination_account_id]]
        );
        const source = accounts.rows.find((a) => a.id === payment.source_account_id.toLowerCase());
        const destination = accounts.rows.find((a) => a.id === payment.destination_account_id.toLowerCase());

        if (!source || !destination) {
          return { kind: 'failure', status: 404, code: 'account_not_found', message: 'Source or destination account not found' };
        }
        if (source.currency !== payment.currency || destination.currency !== payment.currency) {
          return { kind: 'failure', status: 422, code: 'currency_mismatch', message: 'Payment and both accounts must use the same currency' };
        }
        // Authorization only checks funds. It does not move or hold money (capture does).
        if (Number(source.balance_minor) < payment.amount_minor) {
          return { kind: 'failure', status: 422, code: 'insufficient_funds', message: 'Source account has insufficient funds' };
        }

        const inserted = await client.query<PaymentRow>(
          `INSERT INTO payments (source_account_id, destination_account_id, amount_minor, currency, status)
           VALUES ($1, $2, $3, $4, 'authorized')
           RETURNING ${PAYMENT_COLUMNS}`,
          [source.id, destination.id, payment.amount_minor, payment.currency]
        );
        const body = toPayment(inserted.rows[0]);
        return { kind: 'success', status: 201, body, paymentId: body.id };
      },
    });
  } catch (error) {
    next(error);
  }
});

// ---------- read ----------
paymentsRouter.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isUuid(id)) {
      return sendError(res, 400, 'invalid_id', 'Payment id must be a UUID');
    }

    const result = await pool.query<PaymentRow>(`SELECT ${PAYMENT_COLUMNS} FROM payments WHERE id = $1`, [id]);
    if (result.rowCount === 0) {
      return sendError(res, 404, 'payment_not_found', 'Payment not found');
    }
    res.json(toPayment(result.rows[0]));
  } catch (error) {
    next(error);
  }
});

// ---------- capture: authorized -> captured, money moves from source to destination ----------
paymentsRouter.post('/:id/capture', async (req, res, next) => {
  const { id } = req.params;
  if (!isUuid(id)) {
    return sendError(res, 400, 'invalid_id', 'Payment id must be a UUID');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // The row lock makes concurrent state changes of the SAME payment run one after another
    const found = await client.query<PaymentRow>(
      `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (found.rowCount === 0) {
      await client.query('ROLLBACK');
      return sendError(res, 404, 'payment_not_found', 'Payment not found');
    }
    const payment = found.rows[0];

    if (payment.status !== 'authorized') {
      await client.query('ROLLBACK');
      const t = invalidTransition(payment.status, 'capture');
      return sendError(res, t.status, t.code, t.message, t.details);
    }

    const amount = Number(payment.amount_minor);
    const accounts = await lockAccounts(client, [payment.source_account_id, payment.destination_account_id]);
    const source = accounts.get(payment.source_account_id);

    // Authorization did not hold the funds, so they must be checked again now, under the lock
    if (!source || Number(source.balance_minor) < amount) {
      await client.query('ROLLBACK');
      return sendError(res, 422, 'insufficient_funds', 'Source account has insufficient funds');
    }

    await client.query('UPDATE accounts SET balance_minor = balance_minor - $1 WHERE id = $2', [amount, payment.source_account_id]);
    await client.query('UPDATE accounts SET balance_minor = balance_minor + $1 WHERE id = $2', [amount, payment.destination_account_id]);
    const updated = await client.query<PaymentRow>(
      `UPDATE payments SET status = 'captured', updated_at = now() WHERE id = $1 RETURNING ${PAYMENT_COLUMNS}`,
      [id]
    );
    await client.query('COMMIT');

    res.json(toPayment(updated.rows[0]));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    next(error);
  } finally {
    client.release();
  }
});

// ---------- void: authorized -> voided, no money moves ----------
paymentsRouter.post('/:id/void', async (req, res, next) => {
  const { id } = req.params;
  if (!isUuid(id)) {
    return sendError(res, 400, 'invalid_id', 'Payment id must be a UUID');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const found = await client.query<PaymentRow>(
      `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (found.rowCount === 0) {
      await client.query('ROLLBACK');
      return sendError(res, 404, 'payment_not_found', 'Payment not found');
    }
    if (found.rows[0].status !== 'authorized') {
      await client.query('ROLLBACK');
      const t = invalidTransition(found.rows[0].status, 'void');
      return sendError(res, t.status, t.code, t.message, t.details);
    }

    const updated = await client.query<PaymentRow>(
      `UPDATE payments SET status = 'voided', updated_at = now() WHERE id = $1 RETURNING ${PAYMENT_COLUMNS}`,
      [id]
    );
    await client.query('COMMIT');

    res.json(toPayment(updated.rows[0]));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    next(error);
  } finally {
    client.release();
  }
});

// ---------- refund: full or partial, money moves from destination back to source ----------
// A refund needs an Idempotency-Key: the payment state alone cannot stop a retried
// partial refund from being applied twice.
paymentsRouter.post('/:id/refund', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isUuid(id)) {
      return sendError(res, 400, 'invalid_id', 'Payment id must be a UUID');
    }

    const key = readIdempotencyKey(req.header('Idempotency-Key'), res);
    if (!key) return;

    // The body is optional: no body means "refund everything that is left"
    const parsed = refundSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return sendError(res, 400, 'validation_error', 'Invalid refund data', formatIssues(parsed.error));
    }
    const requestedAmount = parsed.data.amount_minor;
    const requestHash = hashRequest(['refund', id.toLowerCase(), requestedAmount ?? 'remaining']);

    await runIdempotent({
      key,
      requestHash,
      res,
      work: async (client): Promise<Outcome> => {
        const found = await client.query<PaymentRow>(
          `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE id = $1 FOR UPDATE`,
          [id]
        );
        if (found.rowCount === 0) {
          return { kind: 'failure', status: 404, code: 'payment_not_found', message: 'Payment not found' };
        }
        const payment = found.rows[0];

        if (payment.status !== 'captured' && payment.status !== 'partially_refunded') {
          const t = invalidTransition(payment.status, 'refund');
          return { kind: 'failure', ...t };
        }

        const total = Number(payment.amount_minor);
        const alreadyRefunded = Number(payment.refunded_minor);
        const remaining = total - alreadyRefunded;
        const amount = requestedAmount ?? remaining;

        if (amount > remaining) {
          return {
            kind: 'failure',
            status: 422,
            code: 'refund_exceeds_remaining',
            message: 'Refund is larger than the amount that is still refundable',
            details: { remaining_minor: remaining },
          };
        }

        const accounts = await lockAccounts(client, [payment.source_account_id, payment.destination_account_id]);
        const destination = accounts.get(payment.destination_account_id);
        if (!destination || Number(destination.balance_minor) < amount) {
          return {
            kind: 'failure',
            status: 422,
            code: 'insufficient_funds_for_refund',
            message: 'The receiving account no longer has enough funds for this refund',
          };
        }

        await client.query('UPDATE accounts SET balance_minor = balance_minor - $1 WHERE id = $2', [amount, payment.destination_account_id]);
        await client.query('UPDATE accounts SET balance_minor = balance_minor + $1 WHERE id = $2', [amount, payment.source_account_id]);

        const refund = await client.query<{ id: string; created_at: Date }>(
          'INSERT INTO refunds (payment_id, amount_minor) VALUES ($1, $2) RETURNING id, created_at',
          [id, amount]
        );

        const newRefunded = alreadyRefunded + amount;
        const newStatus = newRefunded === total ? 'refunded' : 'partially_refunded';
        await client.query(
          'UPDATE payments SET refunded_minor = $1, status = $2, updated_at = now() WHERE id = $3',
          [newRefunded, newStatus, id]
        );

        return {
          kind: 'success',
          status: 201,
          paymentId: id,
          body: {
            id: refund.rows[0].id,
            payment_id: id,
            amount_minor: amount,
            payment_status: newStatus,
            payment_refunded_minor: newRefunded,
            created_at: refund.rows[0].created_at,
          },
        };
      },
    });
  } catch (error) {
    next(error);
  }
});