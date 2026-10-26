import { test as base, expect } from '@playwright/test';
import { Pool } from 'pg';
import { AccountsClient } from './support/AccountsClient';
import { PaymentsClient } from './support/PaymentsClient';

interface TestFixtures {
  accounts: AccountsClient;
  payments: PaymentsClient;
}

interface WorkerFixtures {
  db: Pool;
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  // One database pool per worker, used for DB assertions after API calls
  db: [
    async ({}, use) => {
      const pool = new Pool({
        connectionString:
          process.env.DATABASE_URL || 'postgres://fincore:fincore@localhost:5432/fincore',
      });
      await use(pool);
      await pool.end();
    },
    { scope: 'worker' },
  ],

  accounts: async ({ request }, use) => {
    await use(new AccountsClient(request));
  },

  payments: async ({ request }, use) => {
    await use(new PaymentsClient(request));
  },
});

export { expect };