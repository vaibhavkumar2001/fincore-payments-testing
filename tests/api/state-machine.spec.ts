import { test, expect } from '../fixtures';
import { findPayment, getBalance } from '../support/db';
import { newIdempotencyKey } from '../support/factories';
import { createPaymentInState } from '../support/scenarios';
import type { PaymentState } from '../support/scenarios';

type Action = 'capture' | 'void' | 'refund';

// The complete state machine as a table: every state against every action.
//   authorized         --capture--> captured        --void--> voided
//   captured           --refund-->  partially_refunded or refunded
//   partially_refunded --refund-->  partially_refunded or refunded
// Everything else is an invalid transition and must return 409 without changing anything.
const EXPECTED_STATUS: Record<PaymentState, Record<Action, number>> = {
  authorized: { capture: 200, void: 200, refund: 409 },
  captured: { capture: 409, void: 409, refund: 201 },
  partially_refunded: { capture: 409, void: 409, refund: 201 },
  voided: { capture: 409, void: 409, refund: 409 },
  refunded: { capture: 409, void: 409, refund: 409 },
};

const STATES = Object.keys(EXPECTED_STATUS) as PaymentState[];
const ACTIONS: Action[] = ['capture', 'void', 'refund'];

test.describe('Payment state machine', () => {
  for (const state of STATES) {
    for (const action of ACTIONS) {
      const expectedStatus = EXPECTED_STATUS[state][action];
      const outcome = expectedStatus === 409 ? 'is rejected with 409' : `succeeds with ${expectedStatus}`;

      test(`${action} on a ${state} payment ${outcome}`, async ({ accounts, payments, db }) => {
        const { source, destination, payment } = await createPaymentInState(accounts, payments, state);
        const sourceBefore = await getBalance(db, source.id);
        const destinationBefore = await getBalance(db, destination.id);
        const before = await findPayment(db, payment.id);

        const response =
          action === 'capture'
            ? await payments.capture(payment.id)
            : action === 'void'
              ? await payments.void(payment.id)
              : await payments.refund(payment.id, { amount_minor: 1 }, newIdempotencyKey());

        expect(response.status()).toBe(expectedStatus);

        if (expectedStatus === 409) {
          const body = await response.json();
          expect(body.error.code).toBe('invalid_state_transition');
          expect(body.error.details).toEqual({ from: state, action });

          // A rejected transition must change nothing at all
          expect(await findPayment(db, payment.id)).toEqual(before);
          expect(await getBalance(db, source.id)).toBe(sourceBefore);
          expect(await getBalance(db, destination.id)).toBe(destinationBefore);
        }
      });
    }
  }
});