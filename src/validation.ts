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