import type { APIRequestContext, APIResponse } from '@playwright/test';
import type { PaymentInput } from './factories';

export interface Payment {
  id: string;
  source_account_id: string;
  destination_account_id: string;
  amount_minor: number;
  currency: string;
  status: string;
  created_at: string;
}

export class PaymentsClient {
  constructor(private readonly request: APIRequestContext) {}

  // Pass undefined as the key to send the request without an Idempotency-Key header
  create(body: unknown, idempotencyKey?: string): Promise<APIResponse> {
    return this.request.post('/payments', {
      data: body,
      headers: idempotencyKey === undefined ? {} : { 'Idempotency-Key': idempotencyKey },
    });
  }

  get(id: string): Promise<APIResponse> {
    return this.request.get(`/payments/${id}`);
  }

  // Test setup helper: fails loudly if the payment could not be created
  async createValid(body: PaymentInput, idempotencyKey: string): Promise<Payment> {
    const response = await this.create(body, idempotencyKey);
    if (response.status() !== 201) {
      throw new Error(`Setup failed: expected 201, got ${response.status()} ${await response.text()}`);
    }
    return (await response.json()) as Payment;
  }
}