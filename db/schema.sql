-- Day 1: only accounts. Payments, ledger and idempotency tables come in later days.
CREATE TABLE IF NOT EXISTS accounts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_name    TEXT NOT NULL,
  currency      CHAR(3) NOT NULL,
  -- Money is stored as integer minor units (for example paise or cents), never floats
  balance_minor BIGINT NOT NULL DEFAULT 0 CHECK (balance_minor >= 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Day 3: payments and idempotency keys
CREATE TABLE IF NOT EXISTS payments (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_account_id      UUID NOT NULL REFERENCES accounts(id),
  destination_account_id UUID NOT NULL REFERENCES accounts(id),
  amount_minor           BIGINT NOT NULL CHECK (amount_minor > 0),
  currency               CHAR(3) NOT NULL,
  status                 TEXT NOT NULL CHECK (status IN ('authorized', 'captured', 'voided', 'refunded')),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (source_account_id <> destination_account_id)
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