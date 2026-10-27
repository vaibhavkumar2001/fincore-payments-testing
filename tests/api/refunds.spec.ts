import { test, expect } from '../fixtures';
import { expectValidationError } from '../support/assertions';
import { findPayment, findRefunds, getBalance, sumBalances } from '../support/db';
import { newIdempotencyKey } from '../support/factories';
import { createPaymentInState } from '../support/scenarios';

const UNKNOWN_ID = '11111111-1111-4111-8111-111111111111';

test.describe('Full refund', () => {
  test('a refund without an amount returns everything that is left @smoke', async ({
    accounts,
    payments,
    db,
  }) => {
    const { source, destination, payment } = await createPaymentInState(accounts, payments, 'captured', 1000);
    // After capture: source 1000, destination 1000
    const response = await payments.refund(payment.id, undefined, newIdempotencyKey());

    expect(response.status()).toBe(201);
    expect(await response.json()).toMatchObject({
      payment_id: payment.id,
      amount_minor: 1000,
      payment_status: 'refunded',
      payment_refunded_minor: 1000,
    });
    expect(await getBalance(db, source.id)).toBe('2000');
    expect(await getBalance(db, destination.id)).toBe('0');
    expect(await findPayment(db, payment.id)).toMatchObject({ status: 'refunded', refunded_minor: '1000' });
    expect(await findRefunds(db, payment.id)).toHaveLength(1);
  });
});

test.describe('Partial refunds', () => {
  test('several partial refunds add up and the status follows the refunded amount', async ({
    accounts,
    payments,
    db,
  }) => {
    const { source, destination, payment } = await createPaymentInState(accounts, payments, 'captured', 1000);

    const first = await payments.refundValid(payment.id, 300);
    expect(first).toMatchObject({ amount_minor: 300, payment_status: 'partially_refunded', payment_refunded_minor: 300 });

    const second = await payments.refundValid(payment.id, 200);
    expect(second).toMatchObject({ amount_minor: 200, payment_status: 'partially_refunded', payment_refunded_minor: 500 });

    // No amount: the remaining 500 is refunded and the payment becomes fully refunded
    const last = await payments.refundValid(payment.id);
    expect(last).toMatchObject({ amount_minor: 500, payment_status: 'refunded', payment_refunded_minor: 1000 });

    const refunds = await findRefunds(db, payment.id);
    expect(refunds.map((r) => r.amount_minor)).toEqual(['300', '200', '500']);
    expect(await getBalance(db, source.id)).toBe('2000');
    expect(await getBalance(db, destination.id)).toBe('0');
    expect(await sumBalances(db, [source.id, destination.id])).toBe(2000);
  });

  test('refunding exactly the remaining amount is accepted', async ({ accounts, payments }) => {
    const { payment } = await createPaymentInState(accounts, payments, 'captured', 1000);
    await payments.refundValid(payment.id, 600);

    const response = await payments.refund(payment.id, { amount_minor: 400 }, newIdempotencyKey());

    expect(response.status()).toBe(201);
    expect((await response.json()).payment_status).toBe('refunded');
  });

  test('refunding one unit more than the remaining amount is rejected and nothing changes', async ({
    accounts,
    payments,
    db,
  }) => {
    const { source, destination, payment } = await createPaymentInState(accounts, payments, 'captured', 1000);
    await payments.refundValid(payment.id, 600);
    const sourceBefore = await getBalance(db, source.id);
    const destinationBefore = await getBalance(db, destination.id);

    const response = await payments.refund(payment.id, { amount_minor: 401 }, newIdempotencyKey());

    expect(response.status()).toBe(422);
    const body = await response.json();
    expect(body.error.code).toBe('refund_exceeds_remaining');
    expect(body.error.details).toEqual({ remaining_minor: 400 });
    expect(await findRefunds(db, payment.id)).toHaveLength(1);
    expect((await findPayment(db, payment.id))?.refunded_minor).toBe('600');
    expect(await getBalance(db, source.id)).toBe(sourceBefore);
    expect(await getBalance(db, destination.id)).toBe(destinationBefore);
  });

  test('a refund larger than the whole payment is rejected', async ({ accounts, payments }) => {
    const { payment } = await createPaymentInState(accounts, payments, 'captured', 1000);

    const response = await payments.refund(payment.id, { amount_minor: 1001 }, newIdempotencyKey());

    expect(response.status()).toBe(422);
    expect((await response.json()).error.code).toBe('refund_exceeds_remaining');
  });

  test('is rejected when the receiving account has already spent the money', async ({
    accounts,
    payments,
    db,
  }) => {
    const { destination, payment } = await createPaymentInState(accounts, payments, 'captured', 1000);
    // The destination now holds 1000. It pays 900 to a third account, so only 100 is left.
    const third = await accounts.createValid();
    const spend = await payments.authorize(destination.id, third.id, 900);
    await payments.captureValid(spend.id);

    const response = await payments.refund(payment.id, undefined, newIdempotencyKey());

    expect(response.status()).toBe(422);
    expect((await response.json()).error.code).toBe('insufficient_funds_for_refund');
    expect(await findRefunds(db, payment.id)).toHaveLength(0);
    expect((await findPayment(db, payment.id))?.status).toBe('captured');
  });

  test('a failed refund does not use up its key', async ({ accounts, payments, db }) => {
    const { destination, payment } = await createPaymentInState(accounts, payments, 'captured', 1000);
    const third = await accounts.createValid();
    await payments.captureValid((await payments.authorize(destination.id, third.id, 900)).id);
    const key = newIdempotencyKey();

    const failed = await payments.refund(payment.id, { amount_minor: 500 }, key);
    expect(failed.status()).toBe(422);

    // The receiving account gets money again, then the same request is retried with the same key
    await accounts.deposit(destination.id, { amount_minor: 1000 });
    const retry = await payments.refund(payment.id, { amount_minor: 500 }, key);

    expect(retry.status()).toBe(201);
    expect(await findRefunds(db, payment.id)).toHaveLength(1);
  });
});

test.describe('Refund idempotency', () => {
  test('is required', async ({ accounts, payments }) => {
    const { payment } = await createPaymentInState(accounts, payments, 'captured');

    const response = await payments.refund(payment.id, { amount_minor: 100 });

    expect(response.status()).toBe(400);
    expect((await response.json()).error.code).toBe('missing_idempotency_key');
  });

  test('the same key twice refunds only once', async ({ accounts, payments, db }) => {
    const { source, payment } = await createPaymentInState(accounts, payments, 'captured', 1000);
    const key = newIdempotencyKey();

    const first = await payments.refund(payment.id, { amount_minor: 300 }, key);
    const second = await payments.refund(payment.id, { amount_minor: 300 }, key);

    expect(first.status()).toBe(201);
    expect(second.status()).toBe(201);
    expect(await second.json()).toEqual(await first.json());
    expect(second.headers()['idempotent-replayed']).toBe('true');
    expect(await findRefunds(db, payment.id)).toHaveLength(1);
    expect((await findPayment(db, payment.id))?.refunded_minor).toBe('300');
    // 1000 left after capture, plus a single refund of 300
    expect(await getBalance(db, source.id)).toBe('1300');
  });

  test('the same key with a different amount is rejected', async ({ accounts, payments, db }) => {
    const { payment } = await createPaymentInState(accounts, payments, 'captured', 1000);
    const key = newIdempotencyKey();
    await payments.refund(payment.id, { amount_minor: 300 }, key);

    const reuse = await payments.refund(payment.id, { amount_minor: 400 }, key);

    expect(reuse.status()).toBe(422);
    expect((await reuse.json()).error.code).toBe('idempotency_key_reuse');
    expect(await findRefunds(db, payment.id)).toHaveLength(1);
  });

  test('different keys with the same amount are two separate refunds', async ({ accounts, payments, db }) => {
    const { payment } = await createPaymentInState(accounts, payments, 'captured', 1000);

    await payments.refundValid(payment.id, 300);
    await payments.refundValid(payment.id, 300);

    expect(await findRefunds(db, payment.id)).toHaveLength(2);
    expect((await findPayment(db, payment.id))?.refunded_minor).toBe('600');
  });
});

test.describe('Refund validation', () => {
  const invalidBodies: { name: string; body: unknown; field?: string; unknownKey?: string }[] = [
    { name: 'a zero amount', body: { amount_minor: 0 }, field: 'amount_minor' },
    { name: 'a negative amount', body: { amount_minor: -5 }, field: 'amount_minor' },
    { name: 'a decimal amount', body: { amount_minor: 10.5 }, field: 'amount_minor' },
    { name: 'an amount sent as a string', body: { amount_minor: '100' }, field: 'amount_minor' },
    { name: 'an extra field', body: { amount_minor: 100, status: 'refunded' }, unknownKey: 'status' },
  ];

  for (const { name, body, field, unknownKey } of invalidBodies) {
    test(`rejects ${name}`, async ({ accounts, payments, db }) => {
      const { payment } = await createPaymentInState(accounts, payments, 'captured');

      const response = await payments.refund(payment.id, body, newIdempotencyKey());

      await expectValidationError(response, { field, unknownKey });
      expect(await findRefunds(db, payment.id)).toHaveLength(0);
    });
  }

  test('returns 404 for an unknown payment', async ({ payments }) => {
    const response = await payments.refund(UNKNOWN_ID, { amount_minor: 100 }, newIdempotencyKey());

    expect(response.status()).toBe(404);
    expect((await response.json()).error.code).toBe('payment_not_found');
  });

  test('returns 400 for an id that is not a UUID', async ({ payments }) => {
    const response = await payments.refund('not-a-uuid', { amount_minor: 100 }, newIdempotencyKey());

    expect(response.status()).toBe(400);
  });
});