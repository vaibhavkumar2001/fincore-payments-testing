import { test, expect } from '../fixtures';
import { findAccount } from '../support/db';

// Keep in sync with MAX_DEPOSIT_MINOR in src/validation.ts
const MAX_DEPOSIT_MINOR = 100_000_000;

test.describe('Deposits', () => {
  test('a deposit increases the balance, in the API and in the database @smoke', async ({
    accounts,
    db,
  }) => {
    const account = await accounts.createValid();

    const response = await accounts.deposit(account.id, { amount_minor: 5000 });

    expect(response.status()).toBe(201);
    expect(await response.json()).toEqual({
      account_id: account.id,
      amount_minor: 5000,
      balance_minor: 5000,
    });
    expect((await findAccount(db, account.id))?.balance_minor).toBe('5000');
    expect((await (await accounts.get(account.id)).json()).balance_minor).toBe(5000);
  });

  test('several deposits add up to the exact total', async ({ accounts, db }) => {
    const account = await accounts.createValid();

    for (const amount of [100, 250, 1]) {
      expect((await accounts.deposit(account.id, { amount_minor: amount })).status()).toBe(201);
    }

    expect((await findAccount(db, account.id))?.balance_minor).toBe('351');
  });

  test('the smallest possible deposit (1 minor unit) is accepted', async ({ accounts }) => {
    const account = await accounts.createValid();

    const response = await accounts.deposit(account.id, { amount_minor: 1 });

    expect(response.status()).toBe(201);
  });

  test('a deposit of exactly the maximum is accepted', async ({ accounts, db }) => {
    const account = await accounts.createValid();

    const response = await accounts.deposit(account.id, { amount_minor: MAX_DEPOSIT_MINOR });

    expect(response.status()).toBe(201);
    expect((await findAccount(db, account.id))?.balance_minor).toBe(String(MAX_DEPOSIT_MINOR));
  });

  test('a deposit above the maximum is rejected and the balance stays unchanged', async ({
    accounts,
    db,
  }) => {
    const account = await accounts.createValid();

    const response = await accounts.deposit(account.id, { amount_minor: MAX_DEPOSIT_MINOR + 1 });

    expect(response.status()).toBe(400);
    expect((await findAccount(db, account.id))?.balance_minor).toBe('0');
  });

  const invalidAmounts = [
    { name: 'zero', body: { amount_minor: 0 } },
    { name: 'a negative amount', body: { amount_minor: -100 } },
    { name: 'a decimal amount', body: { amount_minor: 10.5 } },
    { name: 'an amount sent as a string', body: { amount_minor: '100' } },
    { name: 'a null amount', body: { amount_minor: null } },
    { name: 'a missing amount', body: {} },
    { name: 'an extra field', body: { amount_minor: 100, currency: 'USD' } },
    { name: 'an absurdly large number', body: { amount_minor: 1e21 } },
  ];

  for (const { name, body } of invalidAmounts) {
    test(`rejects ${name} and leaves the balance unchanged`, async ({ accounts, db }) => {
      const account = await accounts.createValid();

      const response = await accounts.deposit(account.id, body);

      expect(response.status()).toBe(400);
      expect((await response.json()).error.code).toBe('validation_error');
      expect((await findAccount(db, account.id))?.balance_minor).toBe('0');
    });
  }

  test('returns 404 when depositing to an unknown account', async ({ accounts }) => {
    const response = await accounts.deposit('11111111-1111-4111-8111-111111111111', {
      amount_minor: 100,
    });

    expect(response.status()).toBe(404);
    expect((await response.json()).error.code).toBe('account_not_found');
  });

  test('returns 400 when the account id is not a UUID', async ({ accounts }) => {
    const response = await accounts.deposit('not-a-uuid', { amount_minor: 100 });

    expect(response.status()).toBe(400);
  });

  test('a deposit never changes another account', async ({ accounts, db }) => {
    const first = await accounts.createValid();
    const second = await accounts.createValid();

    await accounts.deposit(first.id, { amount_minor: 700 });

    expect((await findAccount(db, first.id))?.balance_minor).toBe('700');
    expect((await findAccount(db, second.id))?.balance_minor).toBe('0');
  });

  test('ten parallel deposits are all applied and none is lost', async ({ accounts, db }) => {
    const account = await accounts.createValid();

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => accounts.deposit(account.id, { amount_minor: 100 }))
    );

    // Assert on outcomes, not timing: every request succeeds and the total is exact
    expect(responses.map((r) => r.status())).toEqual(Array(10).fill(201));
    expect((await findAccount(db, account.id))?.balance_minor).toBe('1000');
  });
});