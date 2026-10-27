import { z } from 'zod';

export const SUPPORTED_CURRENCIES = ['INR', 'USD', 'EUR'] as const;

// Largest single deposit: 1,000,000.00 in major units, expressed in minor units
export const MAX_DEPOSIT_MINOR = 100_000_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

// strict() rejects unknown fields, so a client cannot try to set balance_minor or id
export const createAccountSchema = z
  .object({
    owner_name: z.string().trim().min(1).max(100),
    currency: z.enum(SUPPORTED_CURRENCIES),
  })
  .strict();

export const depositSchema = z
  .object({
    amount_minor: z.number().int().positive().max(MAX_DEPOSIT_MINOR),
  })
  .strict();

export function formatIssues(error: z.ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}


// Largest single payment, in minor units
export const MAX_PAYMENT_MINOR = 100_000_000;

// Idempotency keys: 8 to 128 characters, letters, digits, dash and underscore only
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export function isValidIdempotencyKey(value: string): boolean {
  return IDEMPOTENCY_KEY_PATTERN.test(value);
}

const uuidField = z.string().refine(isUuid, { message: 'must be a UUID' });

export const createPaymentSchema = z
  .object({
    source_account_id: uuidField,
    destination_account_id: uuidField,
    amount_minor: z.number().int().positive().max(MAX_PAYMENT_MINOR),
    currency: z.enum(SUPPORTED_CURRENCIES),
  })
  .strict()
  .refine((data) => data.source_account_id.toLowerCase() !== data.destination_account_id.toLowerCase(), {
    message: 'source and destination accounts must be different',
    path: ['destination_account_id'],
  });


export const refundSchema = z
  .object({
    amount_minor: z.number().int().positive().max(MAX_PAYMENT_MINOR).optional(),
  })
  .strict(); 