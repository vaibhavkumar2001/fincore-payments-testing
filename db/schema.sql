-- Accounts hold money as integer minor units (for example paise or cents), never floats
CREATE TABLE IF NOT EXISTS accounts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_name    TEXT NOT NULL,
  currency      CHAR(3) NOT NULL,
  balance_minor BIGINT NOT NULL DEFAULT 0 CHECK (balance_minor >= 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A payment moves through: authorized -> captured -> partially_refunded -> refunded,
-- or authorized -> voided
CREATE TABLE IF NOT EXISTS payments (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_account_id      UUID NOT NULL REFERENCES accounts(id),
  destination_account_id UUID NOT NULL REFERENCES accounts(id),
  amount_minor           BIGINT NOT NULL CHECK (amount_minor > 0),
  refunded_minor         BIGINT NOT NULL DEFAULT 0,
  currency               CHAR(3) NOT NULL,
  status                 TEXT NOT NULL CHECK (
    status IN ('authorized', 'captured', 'voided', 'partially_refunded', 'refunded')
  ),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (source_account_id <> destination_account_id),
  CHECK (refunded_minor >= 0 AND refunded_minor <= amount_minor)
);

-- One row per refund, so the history of partial refunds is never lost
CREATE TABLE IF NOT EXISTS refunds (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id   UUID NOT NULL REFERENCES payments(id),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per Idempotency-Key. The stored response is replayed on a retry.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key             TEXT PRIMARY KEY,
  request_hash    TEXT NOT NULL,
  response_status INT,
  response_body   JSONB,
  payment_id      UUID REFERENCES payments(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);