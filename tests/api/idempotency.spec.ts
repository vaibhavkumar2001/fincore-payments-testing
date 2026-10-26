import { test, expect } from '../fixtures';
import { buildPayment, newIdempotencyKey } from '../support/factories';
import { countIdempotencyKeys, countPaymentsFromSource } from '../support/db';

test.describe('Idempotency-Key header', () => {
  test('is required', async ({ accounts, payments }) => {
    const source = await accounts.createFunded(5000);
    const destination = await accounts.createValid();

    const response = await payments.create(buildPayment(source.id, destination.id));

    expect(response.status()).toBe(400);
    expect((await response.json()).error.code).toBe('missing_idempotency_key');
  });

  for (const key of ['short', 'has spaces in it', 'bad/chars/here', 'a'.repeat(129)]) {
    test(`rejects the invalid key "${key.slice(0, 20)}${key.length > 20 ? '...' : ''}"`, async ({
      accounts,
      payments,
    }) => {
      const source = await accounts.createFunded(5000);
      const destination = await accounts.createValid();

      const response = await payments.create(buildPayment(source.id, destination.id), key);

      expect(response.status()).toBe(400);
      expect((await response.json()).error.code).toBe('invalid_idempotency_key');
    });
  }
});

test.describe('Idempotent payment creation', () => {
  test('the same key and body twice returns the same payment and creates only one @smoke', async ({
    accounts,
    payments,
    db,
  }) => {
    const source = await accounts.createFunded(5000);
    const destination = await accounts.createValid();
    const body = buildPayment(source.id, destination.id, { amount_minor: 1200 });
    const key = newIdempotencyKey();

    const first = await payments.create(body, key);
    const second = await payments.create(body, key);

    expect(first.status()).toBe(201);
    expect(second.status()).toBe(201);
    expect(await second.json()).toEqual(await first.json());
    expect(first.headers()['idempotent-replayed']).toBeUndefined();
    expect(second.headers()['idempotent-replayed']).toBe('true');
    expect(await countPaymentsFromSource(db, source.id)).toBe(1);
  });

  test('the same key with a different amount is rejected and the original payment stays', async ({
    accounts,
    payments,
    db,
  }) => {
    const source = await accounts.createFunded(5000);
    const destination = await accounts.createValid();
    const key = newIdempotencyKey();
    const original = await payments.createValid(
      buildPayment(source.id, destination.id, { amount_minor: 1000 }),
      key
    );

    const reuse = await payments.create(
      buildPayment(source.id, destination.id, { amount_minor: 2000 }),
      key
    );

    expect(reuse.status()).toBe(422);
    expect((await reuse.json()).error.code).toBe('idempotency_key_reuse');
    expect(await countPaymentsFromSource(db, source.id)).toBe(1);
    expect((await (await payments.get(original.id)).json()).amount_minor).toBe(1000);
  });

  test('the same key with a different destination is rejected', async ({ accounts, payments, db }) => {
    const source = await accounts.createFunded(5000);
    const firstDestination = await accounts.createValid();
    const otherDestination = await accounts.createValid();
    const key = newIdempotencyKey();
    await payments.createValid(buildPayment(source.id, firstDestination.id), key);

    const reuse = await payments.create(buildPayment(source.id, otherDestination.id), key);

    expect(reuse.status()).toBe(422);
    expect(await countPaymentsFromSource(db, source.id)).toBe(1);
  });

  test('different keys with the same body create two separate payments', async ({
    accounts,
    payments,
    db,
  }) => {
    const source = await accounts.createFunded(5000);
    const destination = await accounts.createValid();
    const body = buildPayment(source.id, destination.id);

    const first = await payments.createValid(body, newIdempotencyKey());
    const second = await payments.createValid(body, newIdempotencyKey());

    expect(second.id).not.toBe(first.id);
    expect(await countPaymentsFromSource(db, source.id)).toBe(2);
  });

  test('a failed attempt does not use up the key: it can be retried after the cause is fixed', async ({
    accounts,
    payments,
    db,
  }) => {
    const source = await accounts.createFunded(500);
    const destination = await accounts.createValid();
    const body = buildPayment(source.id, destination.id, { amount_minor: 1000 });
    const key = newIdempotencyKey();

    const failed = await payments.create(body, key);
    expect(failed.status()).toBe(422);
    expect(await countIdempotencyKeys(db, key)).toBe(0);

    await accounts.deposit(source.id, { amount_minor: 1000 });
    const retry = await payments.create(body, key);

    expect(retry.status()).toBe(201);
    expect(await countPaymentsFromSource(db, source.id)).toBe(1);
    expect(await countIdempotencyKeys(db, key)).toBe(1);
  });

  test('a rejected request (validation error) does not store the key', async ({
    accounts,
    payments,
    db,
  }) => {
    const source = await accounts.createFunded(5000);
    const destination = await accounts.createValid();
    const key = newIdempotencyKey();

    const response = await payments.create(
      buildPayment(source.id, destination.id, { amount_minor: -1 }),
      key
    );

    expect(response.status()).toBe(400);
    expect(await countIdempotencyKeys(db, key)).toBe(0);
  });
});

test.describe('Idempotency under concurrency', () => {
  test('ten parallel requests with the same key create exactly one payment @smoke', async ({
    accounts,
    payments,
    db,
  }) => {
    const source = await accounts.createFunded(5000);
    const destination = await accounts.createValid();
    const body = buildPayment(source.id, destination.id, { amount_minor: 700 });
    const key = newIdempotencyKey();

    const responses = await Promise.all(Array.from({ length: 10 }, () => payments.create(body, key)));

    // Assert on outcomes, not timing: every request succeeds, all see the same payment, one row exists
    expect(responses.map((r) => r.status())).toEqual(Array(10).fill(201));
    const ids = new Set((await Promise.all(responses.map((r) => r.json()))).map((p) => p.id));
    expect(ids.size).toBe(1);
    expect(await countPaymentsFromSource(db, source.id)).toBe(1);
    expect(await countIdempotencyKeys(db, key)).toBe(1);
  });

  test('parallel requests with the same key but different amounts still create only one payment', async ({
    accounts,
    payments,
    db,
  }) => {
    const source = await accounts.createFunded(50_000);
    const destination = await accounts.createValid();
    const key = newIdempotencyKey();

    const responses = await Promise.all(
      [100, 200, 300, 400, 500].map((amount) =>
        payments.create(buildPayment(source.id, destination.id, { amount_minor: amount }), key)
      )
    );

    // Which request wins is not predictable, but there is always exactly one winner
    const statuses = responses.map((r) => r.status());
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 422)).toHaveLength(4);
    expect(await countPaymentsFromSource(db, source.id)).toBe(1);
  });
});