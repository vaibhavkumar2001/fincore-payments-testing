import type { APIRequestContext, APIResponse } from '@playwright/test';
import { newIdempotencyKey } from './factories';
import type { PaymentInput } from './factories';

export interface Payment {
  id: string;
  source_account_id: string;
  destination_account_id: string;
  amount_minor: number;
  refunded_minor: number;
  currency: string;
  status: string;
  created_at: string;
}

export interface Refund {
  id: string;
  payment_id: string;
  amount_minor: number;
  payment_status: string;
  payment_refunded_minor: number;
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

  capture(id: string): Promise<APIResponse> {
    return this.request.post(`/payments/${id}/capture`);
  }

  void(id: string): Promise<APIResponse> {
    return this.request.post(`/payments/${id}/void`);
  }

  // The body and the key are both optional, so tests can leave either one out
  refund(id: string, body?: unknown, idempotencyKey?: string): Promise<APIResponse> {
    return this.request.post(`/payments/${id}/refund`, {
      ...(body === undefined ? {} : { data: body }),
      headers: idempotencyKey === undefined ? {} : { 'Idempotency-Key': idempotencyKey },
    });
  }

  // ----- Test setup helpers: they fail loudly if a setup step does not work -----

  async createValid(body: PaymentInput, idempotencyKey: string): Promise<Payment> {
    return this.expectOk(await this.create(body, idempotencyKey), 201, 'create payment');
  }

  async authorize(sourceId: string, destinationId: string, amountMinor = 1000): Promise<Payment> {
    return this.createValid(
      {
        source_account_id: sourceId,
        destination_account_id: destinationId,
        amount_minor: amountMinor,
        currency: 'INR',
      },
      newIdempotencyKey()
    );
  }

  async captureValid(id: string): Promise<Payment> {
    return this.expectOk(await this.capture(id), 200, 'capture payment');
  }

  async voidValid(id: string): Promise<Payment> {
    return this.expectOk(await this.void(id), 200, 'void payment');
  }

  // Without an amount, the whole remaining amount is refunded
  async refundValid(id: string, amountMinor?: number): Promise<Refund> {
    const body = amountMinor === undefined ? undefined : { amount_minor: amountMinor };
    return this.expectOk(await this.refund(id, body, newIdempotencyKey()), 201, 'refund payment');
  }

  private async expectOk<T>(response: APIResponse, status: number, action: string): Promise<T> {
    if (response.status() !== status) {
      throw new Error(`Setup failed (${action}): expected ${status}, got ${response.status()} ${await response.text()}`);
    }
    return (await response.json()) as T;
  }
}