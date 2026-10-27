import { expect } from '@playwright/test';
import type { APIResponse } from '@playwright/test';

interface ValidationDetail {
  path: string;
  message: string;
}

interface ExpectedRejection {
  // The request field that must be reported as invalid, for example "currency"
  field?: string;
  // A field the client was not allowed to send, for example "balance_minor"
  unknownKey?: string;
}

// Proves a request was rejected for the RIGHT reason, not just that some 400 came back.
// A broken server also answers 400, so status and error code alone are not enough.
export async function expectValidationError(response: APIResponse, expected: ExpectedRejection) {
  expect(response.status()).toBe(400);

  const body = await response.json();
  expect(body.error.code).toBe('validation_error');

  const details = body.error.details as ValidationDetail[];
  if (expected.field !== undefined) {
    expect(details.map((d) => d.path)).toContain(expected.field);
  }
  if (expected.unknownKey !== undefined) {
    // Match the key in quotes. A plain substring check is too weak: "id" is inside the word "Invalid".
    const quotedKey = new RegExp(`["'\u201c]${expected.unknownKey}["'\u201d]`);
    expect(details.map((d) => d.message).join(' ')).toMatch(quotedKey);
  }
}