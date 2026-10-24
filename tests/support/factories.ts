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