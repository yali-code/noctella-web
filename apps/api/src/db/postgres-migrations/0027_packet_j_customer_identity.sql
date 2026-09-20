-- Packet J: additive Customer identity, separate from ERP Customer and Admin authentication.
-- The existing customer_profiles domain is SQLite-first; introduce its base shape for linkage.
CREATE TABLE IF NOT EXISTS customer_profiles (
  id text PRIMARY KEY,
  erp_reference_id text,
  marketplace_buyer_id text,
  email text,
  phone text,
  vat_number text,
  name text,
  status text NOT NULL DEFAULT 'Active',
  source text NOT NULL DEFAULT 'ERP',
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_customer_profiles_email ON customer_profiles(email);
ALTER TABLE customer_addresses ADD COLUMN IF NOT EXISTS customer_id text;
ALTER TABLE customer_addresses ADD COLUMN IF NOT EXISTS type text;
ALTER TABLE customer_addresses ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE customer_addresses ADD COLUMN IF NOT EXISTS line1 text;
ALTER TABLE customer_addresses ADD COLUMN IF NOT EXISTS line2 text;
ALTER TABLE customer_addresses ADD COLUMN IF NOT EXISTS city text;
ALTER TABLE customer_addresses ADD COLUMN IF NOT EXISTS region text;
ALTER TABLE customer_addresses ADD COLUMN IF NOT EXISTS postal_code text;
ALTER TABLE customer_addresses ADD COLUMN IF NOT EXISTS country text;
ALTER TABLE customer_addresses ADD COLUMN IF NOT EXISTS country_code text;
ALTER TABLE customer_addresses ADD COLUMN IF NOT EXISTS fingerprint text;
ALTER TABLE customer_addresses ADD COLUMN IF NOT EXISTS created_at text;
ALTER TABLE customer_addresses ADD COLUMN IF NOT EXISTS updated_at text;

CREATE TABLE IF NOT EXISTS customer_accounts (
  id text PRIMARY KEY,
  customer_id text NOT NULL UNIQUE REFERENCES customer_profiles(id),
  normalized_email text NOT NULL UNIQUE,
  password_hash text,
  email_verified_at text,
  status text NOT NULL DEFAULT 'active',
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE TABLE IF NOT EXISTS customer_sessions (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES customer_accounts(id),
  token_hash text NOT NULL UNIQUE,
  expires_at text NOT NULL,
  revoked_at text,
  created_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_customer_sessions_account ON customer_sessions(account_id);
CREATE INDEX IF NOT EXISTS idx_customer_sessions_expiry ON customer_sessions(expires_at);

CREATE TABLE IF NOT EXISTS customer_security_tokens (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES customer_accounts(id),
  purpose text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at text NOT NULL,
  consumed_at text,
  created_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_customer_security_tokens_account ON customer_security_tokens(account_id, purpose);
CREATE INDEX IF NOT EXISTS idx_customer_security_tokens_expiry ON customer_security_tokens(expires_at);

CREATE TABLE IF NOT EXISTS customer_auth_providers (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES customer_accounts(id),
  provider text NOT NULL,
  subject text NOT NULL,
  created_at text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_auth_providers_subject ON customer_auth_providers(provider, subject);
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_auth_providers_account ON customer_auth_providers(account_id, provider);
CREATE TABLE IF NOT EXISTS customer_oauth_attempts (
  id text PRIMARY KEY,
  state_hash text NOT NULL UNIQUE,
  nonce text NOT NULL,
  code_verifier text NOT NULL,
  expires_at text NOT NULL,
  consumed_at text,
  created_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_customer_oauth_attempts_expiry ON customer_oauth_attempts(expires_at);
