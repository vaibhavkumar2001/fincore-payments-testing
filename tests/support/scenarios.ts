import type { AccountsClient, Account } from './AccountsClient';
import type { Payment, PaymentsClient } from './PaymentsClient';

export type PaymentState = 'authorized' | 'captured' | 'voided' | 'partially_refunded' | 'refunded';

export interface PaymentScenario {
  source: Account;
  destination: Account;
  payment: Payment;
}

// Builds a payment that is in the requested state, using only the public API.
// The source starts with twice the payment amount, so it always has enough funds.
export async function createPaymentInState(
  accounts: AccountsClient,
  payments: PaymentsClient,
  state: PaymentState,
  amountMinor = 1000
): Promise<PaymentScenario> {
  const source = await accounts.createFunded(amountMinor * 2);
  const destination = await accounts.createValid();
  let payment = await payments.authorize(source.id, destination.id, amountMinor);

  if (state === 'voided') {
    payment = await payments.voidValid(payment.id);
  } else if (state !== 'authorized') {
    payment = await payments.captureValid(payment.id);
    if (state === 'partially_refunded') {
      await payments.refundValid(payment.id, Math.floor(amountMinor / 4));
    } else if (state === 'refunded') {
      await payments.refundValid(payment.id);
    }
    payment = (await (await payments.get(payment.id)).json()) as Payment;
  }

  return { source, destination, payment };
}