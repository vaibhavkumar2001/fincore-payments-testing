-- This is the schema for the account
CREATE TABLE IF NOT EXISTS accounts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_name    TEXT NOT NULL,
  currency      CHAR(3) NOT NULL,
  -- Money is stored as integer minor units (for example paise or cents), never floats
  balance_minor BIGINT NOT NULL DEFAULT 0 CHECK (balance_minor >= 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);