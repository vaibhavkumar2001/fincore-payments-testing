import type { APIRequestContext, APIResponse } from '@playwright/test';
import { buildAccount } from './factories';
import type { AccountInput } from './factories';

export interface Account {
  id: string;
  owner_name: string;
  currency: string;
  balance_minor: number;
  created_at: string;
}

// Thin wrapper over the HTTP API, so specs never contain raw URLs
export class AccountsClient {
  constructor(private readonly request: APIRequestContext) {}

  create(body: unknown): Promise<APIResponse> {
    return this.request.post('/accounts', { data: body });
  }

  // Sends the body exactly as given, for malformed JSON tests
  createRaw(rawBody: string): Promise<APIResponse> {
    return this.request.post('/accounts', {
      data: rawBody,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  get(id: string): Promise<APIResponse> {
    return this.request.get(`/accounts/${id}`);
  }

  deposit(id: string, body: unknown): Promise<APIResponse> {
    return this.request.post(`/accounts/${id}/deposits`, { data: body });
  }

  // Test setup helper: fails loudly if the account could not be created
  async createValid(overrides: Partial<AccountInput> = {}): Promise<Account> {
    const response = await this.create(buildAccount(overrides));
    if (response.status() !== 201) {
      throw new Error(`Setup failed: expected 201, got ${response.status()} ${await response.text()}`);
    }
    return (await response.json()) as Account;
  }

  // Test setup helper: an account that already holds the given balance
  async createFunded(balanceMinor: number, overrides: Partial<AccountInput> = {}): Promise<Account> {
    const account = await this.createValid(overrides);
    if (balanceMinor > 0) {
      const response = await this.deposit(account.id, { amount_minor: balanceMinor });
      if (response.status() !== 201) {
        throw new Error(`Setup failed: deposit returned ${response.status()} ${await response.text()}`);
      }
    }
    return { ...account, balance_minor: balanceMinor };
  }
}