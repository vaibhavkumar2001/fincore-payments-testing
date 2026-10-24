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