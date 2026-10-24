import { test, expect } from '../fixtures';
import { buildAccount } from '../support/factories';
import { countAccountsByOwner, findAccount } from '../support/db';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

test.describe('Create account', () => {
  test('creates an account with a zero balance and stores it in the database @smoke', async ({
    accounts,
    db,
  }) => {
    const payload = buildAccount({ currency: 'USD' });

    const response = await accounts.create(payload);

    expect(response.status()).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({
      owner_name: payload.owner_name,
      currency: 'USD',
      balance_minor: 0,
    });
    expect(body.id).toMatch(UUID_PATTERN);

    // The API response is not enough: confirm the row really exists
    const row = await findAccount(db, body.id);
    expect(row).toMatchObject({
      owner_name: payload.owner_name,
      currency: 'USD',
      balance_minor: '0',
    });
  });

  test('trims whitespace around the owner name', async ({ accounts }) => {
    const response = await accounts.create({ owner_name: '  Asha Rao  ', currency: 'INR' });

    expect(response.status()).toBe(201);
    expect((await response.json()).owner_name).toBe('Asha Rao');
  });

  for (const currency of ['INR', 'USD', 'EUR']) {
    test(`accepts the supported currency ${currency}`, async ({ accounts }) => {
      const response = await accounts.create(buildAccount({ currency }));
      expect(response.status()).toBe(201);
      expect((await response.json()).currency).toBe(currency);
    });
  }

  const invalidPayloads = [
    { name: 'a missing owner_name', body: { currency: 'INR' } },
    { name: 'an empty owner_name', body: { owner_name: '', currency: 'INR' } },
    { name: 'a blank owner_name', body: { owner_name: '   ', currency: 'INR' } },
    { name: 'an owner_name longer than 100 characters', body: { owner_name: 'a'.repeat(101), currency: 'INR' } },
    { name: 'a missing currency', body: { owner_name: 'Asha Rao' } },
    { name: 'an unsupported currency', body: { owner_name: 'Asha Rao', currency: 'XYZ' } },
    { name: 'a lowercase currency', body: { owner_name: 'Asha Rao', currency: 'inr' } },
    { name: 'a numeric currency', body: { owner_name: 'Asha Rao', currency: 356 } },
    { name: 'a client-supplied balance', body: { owner_name: 'Asha Rao', currency: 'INR', balance_minor: 1000000 } },
    { name: 'a client-supplied id', body: { owner_name: 'Asha Rao', currency: 'INR', id: 'abc' } },
  ];

  for (const { name, body } of invalidPayloads) {
    test(`rejects ${name}`, async ({ accounts }) => {
      const response = await accounts.create(body);

      expect(response.status()).toBe(400);
      expect((await response.json()).error.code).toBe('validation_error');
    });
  }

  test('does not create a row when the request is rejected', async ({ accounts, db }) => {
    // A unique owner name lets us count exactly the rows this test could have created
    const ownerName = buildAccount().owner_name + ' (rejected)';

    const response = await accounts.create({ owner_name: ownerName, currency: 'INR', balance_minor: 999999 });

    expect(response.status()).toBe(400);
    expect(await countAccountsByOwner(db, ownerName)).toBe(0);
  });

  test('rejects malformed JSON', async ({ accounts }) => {
    const response = await accounts.createRaw('{"owner_name": ');

    expect(response.status()).toBe(400);
    expect((await response.json()).error.code).toBe('invalid_json');
  });

  test('rejects a JSON array instead of an object', async ({ accounts }) => {
    const response = await accounts.createRaw('[]');

    expect(response.status()).toBe(400);
  });
});

test.describe('Get account', () => {
  test('returns the account that was created @smoke', async ({ accounts }) => {
    const created = await accounts.createValid();

    const response = await accounts.get(created.id);

    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual(created);
  });

  test('returns 404 for an unknown account', async ({ accounts }) => {
    const response = await accounts.get('11111111-1111-4111-8111-111111111111');

    expect(response.status()).toBe(404);
    expect((await response.json()).error.code).toBe('account_not_found');
  });

  test('returns 400 for an id that is not a UUID', async ({ accounts }) => {
    const response = await accounts.get('not-a-uuid');

    expect(response.status()).toBe(400);
    expect((await response.json()).error.code).toBe('invalid_id');
  });

  test('treats an injection-style id as invalid input', async ({ accounts }) => {
    const response = await accounts.get(encodeURIComponent("1' OR '1'='1"));

    expect(response.status()).toBe(400);
  });
});