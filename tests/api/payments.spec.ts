import { test, expect } from '../fixtures';
import { buildPayment, newIdempotencyKey } from '../support/factories';
import { countPaymentsFromSource, findPayment } from '../support/db';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

test.describe('Create payment', () => {
  test('creates an authorized payment and does not move any money yet @smoke', async ({
    accounts,
    payments,
    db,
  }) => {
    const source = await accounts.createFunded(5000);
    const destination = await accounts.createFunded(200);

    const response = await payments.create(
      buildPayment(source.id, destination.id, { amount_minor: 1500 }),
      newIdempotencyKey()
    );

    expect(response.status()).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({
      source_account_id: source.id,
      destination_account_id: destination.id,
      amount_minor: 1500,
      currency: 'INR',
      status: 'authorized',
    });
    expect(body.id).toMatch(UUID_PATTERN);

    // The database agrees, and authorization alone leaves both balances untouched
    expect(await findPayment(db, body.id)).toMatchObject({
      status: 'authorized',
      amount_minor: '1500',
      source_account_id: source.id,
    });
    expect((await (await accounts.get(source.id)).json()).balance_minor).toBe(5000);
    expect((await (await accounts.get(destination.id)).json()).balance_minor).toBe(200);
  });

  test('a payment for exactly the available balance is accepted', async ({ accounts, payments }) => {
    const source = await accounts.createFunded(1000);
    const destination = await accounts.createValid();

    const response = await payments.create(
      buildPayment(source.id, destination.id, { amount_minor: 1000 }),
      newIdempotencyKey()
    );

    expect(response.status()).toBe(201);
  });

  test('a payment one unit above the balance is rejected and nothing is stored', async ({
    accounts,
    payments,
    db,
  }) => {
    const source = await accounts.createFunded(1000);
    const destination = await accounts.createValid();

    const response = await payments.create(
      buildPayment(source.id, destination.id, { amount_minor: 1001 }),
      newIdempotencyKey()
    );

    expect(response.status()).toBe(422);
    expect((await response.json()).error.code).toBe('insufficient_funds');
    expect(await countPaymentsFromSource(db, source.id)).toBe(0);
  });

  test('rejects a payment when the accounts use a different currency than the payment', async ({
    accounts,
    payments,
    db,
  }) => {
    const source = await accounts.createFunded(5000, { currency: 'INR' });
    const destination = await accounts.createValid({ currency: 'USD' });

    const response = await payments.create(
      buildPayment(source.id, destination.id, { currency: 'INR' }),
      newIdempotencyKey()
    );

    expect(response.status()).toBe(422);
    expect((await response.json()).error.code).toBe('currency_mismatch');
    expect(await countPaymentsFromSource(db, source.id)).toBe(0);
  });

  test('returns 404 when the source account does not exist', async ({ accounts, payments }) => {
    const destination = await accounts.createValid();

    const response = await payments.create(
      buildPayment('11111111-1111-4111-8111-111111111111', destination.id),
      newIdempotencyKey()
    );

    expect(response.status()).toBe(404);
    expect((await response.json()).error.code).toBe('account_not_found');
  });

  test('returns 404 when the destination account does not exist', async ({ accounts, payments, db }) => {
    const source = await accounts.createFunded(5000);

    const response = await payments.create(
      buildPayment(source.id, '11111111-1111-4111-8111-111111111111'),
      newIdempotencyKey()
    );

    expect(response.status()).toBe(404);
    expect(await countPaymentsFromSource(db, source.id)).toBe(0);
  });

  test.describe('validation', () => {
    const invalidBodies = [
      { name: 'a missing amount', mutate: (b: Record<string, unknown>) => ({ ...b, amount_minor: undefined }) },
      { name: 'a zero amount', mutate: (b: Record<string, unknown>) => ({ ...b, amount_minor: 0 }) },
      { name: 'a negative amount', mutate: (b: Record<string, unknown>) => ({ ...b, amount_minor: -5 }) },
      { name: 'a decimal amount', mutate: (b: Record<string, unknown>) => ({ ...b, amount_minor: 10.5 }) },
      { name: 'an amount above the maximum', mutate: (b: Record<string, unknown>) => ({ ...b, amount_minor: 100_000_001 }) },
      { name: 'an unsupported currency', mutate: (b: Record<string, unknown>) => ({ ...b, currency: 'XYZ' }) },
      { name: 'a source id that is not a UUID', mutate: (b: Record<string, unknown>) => ({ ...b, source_account_id: 'abc' }) },
      { name: 'a client-supplied status', mutate: (b: Record<string, unknown>) => ({ ...b, status: 'captured' }) },
      { name: 'a client-supplied id', mutate: (b: Record<string, unknown>) => ({ ...b, id: 'abc' }) },
    ];

    for (const { name, mutate } of invalidBodies) {
      test(`rejects ${name}`, async ({ accounts, payments, db }) => {
        const source = await accounts.createFunded(5000);
        const destination = await accounts.createValid();
        const body = mutate({ ...buildPayment(source.id, destination.id) });

        const response = await payments.create(body, newIdempotencyKey());

        expect(response.status()).toBe(400);
        expect((await response.json()).error.code).toBe('validation_error');
        expect(await countPaymentsFromSource(db, source.id)).toBe(0);
      });
    }

    test('rejects a payment from an account to itself', async ({ accounts, payments, db }) => {
      const account = await accounts.createFunded(5000);

      const response = await payments.create(buildPayment(account.id, account.id), newIdempotencyKey());

      expect(response.status()).toBe(400);
      expect(await countPaymentsFromSource(db, account.id)).toBe(0);
    });
  });
});

test.describe('Get payment', () => {
  test('returns the payment that was created @smoke', async ({ accounts, payments }) => {
    const source = await accounts.createFunded(5000);
    const destination = await accounts.createValid();
    const created = await payments.createValid(buildPayment(source.id, destination.id), newIdempotencyKey());

    const response = await payments.get(created.id);

    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual(created);
  });

  test('returns 404 for an unknown payment', async ({ payments }) => {
    const response = await payments.get('11111111-1111-4111-8111-111111111111');

    expect(response.status()).toBe(404);
    expect((await response.json()).error.code).toBe('payment_not_found');
  });

  test('returns 400 for an id that is not a UUID', async ({ payments }) => {
    const response = await payments.get('not-a-uuid');

    expect(response.status()).toBe(400);
  });
});