import { test, expect } from '../fixtures';
import { findPayment, getBalance, sumBalances } from '../support/db';

const UNKNOWN_ID = '11111111-1111-4111-8111-111111111111';

test.describe('Capture', () => {
  test('moves the money from the source to the destination and marks the payment captured @smoke', async ({
    accounts,
    payments,
    db,
  }) => {
    const source = await accounts.createFunded(5000);
    const destination = await accounts.createFunded(200);
    const payment = await payments.authorize(source.id, destination.id, 1500);

    const response = await payments.capture(payment.id);

    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ id: payment.id, status: 'captured', refunded_minor: 0 });
    expect(await getBalance(db, source.id)).toBe('3500');
    expect(await getBalance(db, destination.id)).toBe('1700');
    expect((await findPayment(db, payment.id))?.status).toBe('captured');
    // Money is only moved, never created or destroyed
    expect(await sumBalances(db, [source.id, destination.id])).toBe(5200);
  });

  test('fails when the source no longer has the funds, and leaves everything unchanged', async ({
    accounts,
    payments,
    db,
  }) => {
    // Authorization does not hold funds, so two payments of 800 can both be authorized on a balance of 1000
    const source = await accounts.createFunded(1000);
    const destination = await accounts.createValid();
    const first = await payments.authorize(source.id, destination.id, 800);
    const second = await payments.authorize(source.id, destination.id, 800);
    await payments.captureValid(first.id);

    const response = await payments.capture(second.id);

    expect(response.status()).toBe(422);
    expect((await response.json()).error.code).toBe('insufficient_funds');
    expect((await findPayment(db, second.id))?.status).toBe('authorized');
    expect(await getBalance(db, source.id)).toBe('200');
    expect(await getBalance(db, destination.id)).toBe('800');
  });

  test('returns 404 for an unknown payment', async ({ payments }) => {
    const response = await payments.capture(UNKNOWN_ID);

    expect(response.status()).toBe(404);
    expect((await response.json()).error.code).toBe('payment_not_found');
  });

  test('returns 400 for an id that is not a UUID', async ({ payments }) => {
    const response = await payments.capture('not-a-uuid');

    expect(response.status()).toBe(400);
    expect((await response.json()).error.code).toBe('invalid_id');
  });
});

test.describe('Void', () => {
  test('voids an authorized payment without moving any money @smoke', async ({ accounts, payments, db }) => {
    const source = await accounts.createFunded(5000);
    const destination = await accounts.createFunded(200);
    const payment = await payments.authorize(source.id, destination.id, 1500);

    const response = await payments.void(payment.id);

    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ id: payment.id, status: 'voided' });
    expect((await findPayment(db, payment.id))?.status).toBe('voided');
    expect(await getBalance(db, source.id)).toBe('5000');
    expect(await getBalance(db, destination.id)).toBe('200');
  });

  test('a voided payment can never be captured later', async ({ accounts, payments, db }) => {
    const source = await accounts.createFunded(5000);
    const destination = await accounts.createValid();
    const payment = await payments.authorize(source.id, destination.id, 1500);
    await payments.voidValid(payment.id);

    const response = await payments.capture(payment.id);

    expect(response.status()).toBe(409);
    expect(await getBalance(db, source.id)).toBe('5000');
    expect(await getBalance(db, destination.id)).toBe('0');
  });

  test('returns 404 for an unknown payment', async ({ payments }) => {
    const response = await payments.void(UNKNOWN_ID);

    expect(response.status()).toBe(404);
  });

  test('returns 400 for an id that is not a UUID', async ({ payments }) => {
    const response = await payments.void('not-a-uuid');

    expect(response.status()).toBe(400);
  });
});