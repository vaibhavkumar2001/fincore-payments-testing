import type { Pool } from 'pg';

export interface AccountRecord {
  id: string;
  owner_name: string;
  currency: string;
  // BIGINT is read as text, so large values never lose precision in assertions
  balance_minor: string;
}

export async function findAccount(db: Pool, id: string): Promise<AccountRecord | undefined> {
  const result = await db.query<AccountRecord>(
    `SELECT id, owner_name, currency, balance_minor::text AS balance_minor
     FROM accounts WHERE id = $1`,
    [id]
  );
  return result.rows[0];
}

export async function countAccountsByOwner(db: Pool, ownerName: string): Promise<number> {
  const result = await db.query<{ total: string }>(
    'SELECT count(*)::text AS total FROM accounts WHERE owner_name = $1',
    [ownerName]
  );
  return Number(result.rows[0].total);
}

export interface PaymentRecord {
  id: string;
  source_account_id: string;
  destination_account_id: string;
  amount_minor: string;
  refunded_minor: string;
  currency: string;
  status: string;
}

export async function findPayment(db: Pool, id: string): Promise<PaymentRecord | undefined> {
  const result = await db.query<PaymentRecord>(
    `SELECT id, source_account_id, destination_account_id, amount_minor::text AS amount_minor,
            refunded_minor::text AS refunded_minor, currency, status
     FROM payments WHERE id = $1`,
    [id]
  );
  return result.rows[0];
}

// Each test uses its own source account, so this count is exact for that test
export async function countPaymentsFromSource(db: Pool, sourceAccountId: string): Promise<number> {
  const result = await db.query<{ total: string }>(
    'SELECT count(*)::text AS total FROM payments WHERE source_account_id = $1',
    [sourceAccountId]
  );
  return Number(result.rows[0].total);
}

export async function countIdempotencyKeys(db: Pool, key: string): Promise<number> {
  const result = await db.query<{ total: string }>(
    'SELECT count(*)::text AS total FROM idempotency_keys WHERE key = $1',
    [key]
  );
  return Number(result.rows[0].total);
}

export interface RefundRecord {
  id: string;
  payment_id: string;
  amount_minor: string;
}

export async function findRefunds(db: Pool, paymentId: string): Promise<RefundRecord[]> {
  const result = await db.query<RefundRecord>(
    'SELECT id, payment_id, amount_minor::text AS amount_minor FROM refunds WHERE payment_id = $1 ORDER BY created_at',
    [paymentId]
  );
  return result.rows;
}

// The balance as text, so large values never lose precision
export async function getBalance(db: Pool, accountId: string): Promise<string> {
  const result = await db.query<{ balance_minor: string }>(
    'SELECT balance_minor::text AS balance_minor FROM accounts WHERE id = $1',
    [accountId]
  );
  return result.rows[0].balance_minor;
}

// Money must never be created or destroyed: the sum over the accounts of a test stays constant
export async function sumBalances(db: Pool, accountIds: string[]): Promise<number> {
  const result = await db.query<{ total: string }>(
    'SELECT COALESCE(SUM(balance_minor), 0)::text AS total FROM accounts WHERE id = ANY($1::uuid[])',
    [accountIds]
  );
  return Number(result.rows[0].total);
}