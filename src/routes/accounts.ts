import { Router } from 'express';
import { pool } from '../db';
import { sendError } from '../http';
import { createAccountSchema, depositSchema, formatIssues, isUuid } from '../validation';

interface AccountRow {
  id: string;
  owner_name: string;
  currency: string;
  balance_minor: string;
  created_at: Date;
}

function toAccount(row: AccountRow) {
  return {
    id: row.id,
    owner_name: row.owner_name,
    currency: row.currency,
    // pg returns BIGINT as a string. Amounts here stay far below Number.MAX_SAFE_INTEGER.
    balance_minor: Number(row.balance_minor),
    created_at: row.created_at,
  };
}

export const accountsRouter = Router();

accountsRouter.post('/', async (req, res, next) => {
  try {
    const parsed = createAccountSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, 'validation_error', 'Invalid account data', formatIssues(parsed.error));
    }

    const { owner_name, currency } = parsed.data;
    const result = await pool.query<AccountRow>(
      `INSERT INTO accounts (owner_name, currency)
       VALUES ($1, $2)
       RETURNING id, owner_name, currency, balance_minor, created_at`,
      [owner_name, currency]
    );
    res.status(201).json(toAccount(result.rows[0]));
  } catch (error) {
    next(error);
  }
});

accountsRouter.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isUuid(id)) {
      return sendError(res, 400, 'invalid_id', 'Account id must be a UUID');
    }

    const result = await pool.query<AccountRow>(
      'SELECT id, owner_name, currency, balance_minor, created_at FROM accounts WHERE id = $1',
      [id]
    );
    if (result.rowCount === 0) {
      return sendError(res, 404, 'account_not_found', 'Account not found');
    }
    res.json(toAccount(result.rows[0]));
  } catch (error) {
    next(error);
  }
});

accountsRouter.post('/:id/deposits', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isUuid(id)) {
      return sendError(res, 400, 'invalid_id', 'Account id must be a UUID');
    }

    const parsed = depositSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, 'validation_error', 'Invalid deposit data', formatIssues(parsed.error));
    }

    // One atomic UPDATE: the database adds the amount, so parallel deposits cannot overwrite each other
    const result = await pool.query<AccountRow>(
      `UPDATE accounts
       SET balance_minor = balance_minor + $1
       WHERE id = $2
       RETURNING id, owner_name, currency, balance_minor, created_at`,
      [parsed.data.amount_minor, id]
    );
    if (result.rowCount === 0) {
      return sendError(res, 404, 'account_not_found', 'Account not found');
    }

    res.status(201).json({
      account_id: id,
      amount_minor: parsed.data.amount_minor,
      balance_minor: Number(result.rows[0].balance_minor),
    });
  } catch (error) {
    next(error);
  }
});