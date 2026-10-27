import { test, expect } from '../fixtures';
import { findPayment, findRefunds, getBalance, sumBalances } from '../support/db';
import { newIdempotencyKey } from '../support/factories';
import { createPaymentInState } from '../support/scenarios';

// These tests assert on outcomes (how many succeeded, what the totals are), never on timing.

test.describe('Concurrent payment operations', () => {
  test('ten parallel captures of one payment move the money exactly once @smoke', async ({
    accounts,
    payments,
    db,
  }) => {
    const source = await accounts.createFunded(5000);
    const destination = await accounts.createValid();
    const payment = await payments.authorize(source.id, destination.id, 1000);

    const responses = await Promise.all(Array.from({ length: 10 }, () => payments.capture(payment.id)));

    const statuses = responses.map((r) => r.status());
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(9);
    expect(await getBalance(db, source.id)).toBe('4000');
    expect(await getBalance(db, destination.id)).toBe('1000');
  });

  test('a capture and a void at the same time: exactly one wins and the money matches', async ({
    accounts,
    payments,
    db,
  }) => {
    const source = await accounts.createFunded(5000);
    const destination = await accounts.createValid();
    const payment = await payments.authorize(source.id, destination.id, 1000);

    const [capture, voided] = await Promise.all([payments.capture(payment.id), payments.void(payment.id)]);

    expect([capture.status(), voided.status()].sort()).toEqual([200, 409]);
    const final = await findPayment(db, payment.id);
    if (capture.status() === 200) {
      expect(final?.status).toBe('captured');
      expect(await getBalance(db, source.id)).toBe('4000');
      expect(await getBalance(db, destination.id)).toBe('1000');
    } else {
      expect(final?.status).toBe('voided');
      expect(await getBalance(db, source.id)).toBe('5000');
      expect(await getBalance(db, destination.id)).toBe('0');
    }
  });

  test('parallel partial refunds can never refund more than was captured', async ({
    accounts,
    payments,
    db,
  }) => {
    const { source, destination, payment } = await createPaymentInState(accounts, payments, 'captured', 1000);

    // Five refunds of 300 against 1000: only three fit (900), two must be rejected
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => payments.refund(payment.id, { amount_minor: 300 }, newIdempotencyKey()))
    );

    const statuses = responses.map((r) => r.status());
    expect(statuses.filter((s) => s === 201)).toHaveLength(3);
    expect(statuses.filter((s) => s === 422)).toHaveLength(2);

    expect((await findPayment(db, payment.id))?.refunded_minor).toBe('900');
    expect(await findRefunds(db, payment.id)).toHaveLength(3);
    expect(await getBalance(db, destination.id)).toBe('100');
    expect(await sumBalances(db, [source.id, destination.id])).toBe(2000);
  });

  test('ten parallel refunds with the same key create exactly one refund', async ({
    accounts,
    payments,
    db,
  }) => {
    const { payment } = await createPaymentInState(accounts, payments, 'captured', 1000);
    const key = newIdempotencyKey();

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => payments.refund(payment.id, { amount_minor: 100 }, key))
    );

    expect(responses.map((r) => r.status())).toEqual(Array(10).fill(201));
    const ids = new Set((await Promise.all(responses.map((r) => r.json()))).map((r) => r.id));
    expect(ids.size).toBe(1);
    expect(await findRefunds(db, payment.id)).toHaveLength(1);
  });

  test('payments in opposite directions between two accounts do not deadlock', async ({
    accounts,
    payments,
    db,
  }) => {
    const a = await accounts.createFunded(1000);
    const b = await accounts.createFunded(1000);
    const aToB = await Promise.all(Array.from({ length: 5 }, () => payments.authorize(a.id, b.id, 100)));
    const bToA = await Promise.all(Array.from({ length: 5 }, () => payments.authorize(b.id, a.id, 200)));

    // Ten captures at once, half in each direction. Without a fixed lock order this can deadlock.
    const responses = await Promise.all([...aToB, ...bToA].map((p) => payments.capture(p.id)));

    expect(responses.map((r) => r.status())).toEqual(Array(10).fill(200));
    // a: 1000 - 5 x 100 + 5 x 200 = 1500, b: 1000 + 5 x 100 - 5 x 200 = 500
    expect(await getBalance(db, a.id)).toBe('1500');
    expect(await getBalance(db, b.id)).toBe('500');
  });
});