// YEh file isliye banya h kyonki hm fake username or currency create kr rhe h

import { faker } from '@faker-js/faker';

export interface AccountInput {
  owner_name: string;
  currency: string;
}

export function buildAccount(overrides: Partial<AccountInput> = {}): AccountInput {
  return {
    owner_name: faker.person.fullName(),
    currency: 'INR',
    ...overrides,
  };
}

export interface PaymentInput {
  source_account_id: string;
  destination_account_id: string;
  amount_minor: number;
  currency: string;
}

export function buildPayment(
  sourceId: string,
  destinationId: string,
  overrides: Partial<PaymentInput> = {}
): PaymentInput {
  return {
    source_account_id: sourceId,
    destination_account_id: destinationId,
    amount_minor: 1000,
    currency: 'INR',
    ...overrides,
  }
}

// A new idempotency key for every call, so tests never share keys by accident

export function newIdempotencyKey(): string {
  return `test-${faker.string.uuid()}`;
}