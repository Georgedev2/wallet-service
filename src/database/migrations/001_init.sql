-- Wallet service schema (PostgreSQL 13+; gen_random_uuid() is built in)
-- Money is stored as BIGINT in minor units (kobo), never as FLOAT.

-- ---------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------
CREATE TABLE users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email          TEXT NOT NULL,
  phone          TEXT NOT NULL,                 -- normalised to E.164 in the app
  full_name      TEXT NOT NULL,
  password_hash  TEXT NOT NULL,                 -- argon2, never plaintext
  role           TEXT NOT NULL DEFAULT 'user'
                 CHECK (role IN ('user', 'admin')),
  status         TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'blocked')),
  blocked_reason TEXT,
  blocked_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- blocked_at must be set exactly when the user is blocked
  CHECK ((status = 'blocked') = (blocked_at IS NOT NULL))
);

CREATE UNIQUE INDEX users_email_uq ON users (lower(email));
CREATE UNIQUE INDEX users_phone_uq ON users (phone);

-- ---------------------------------------------------------------
-- Blacklist (checked at signup and before transfers)
-- Can also cache results from an external provider (source column).
-- ---------------------------------------------------------------
CREATE TABLE blacklist_entries (
  id              BIGSERIAL PRIMARY KEY,
  identity_type   TEXT NOT NULL CHECK (identity_type IN ('email', 'phone', 'bvn', 'nin')),
  identity_value  TEXT NOT NULL,                -- normalised (lowercase email, E.164 phone)
  reason          TEXT,
  source          TEXT NOT NULL DEFAULT 'internal',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (identity_type, identity_value)
);

-- ---------------------------------------------------------------
-- Block / unblock audit trail (who did what, when, and why)
-- ---------------------------------------------------------------
CREATE TABLE user_status_events (
  id            BIGSERIAL PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES users(id),
  action        TEXT NOT NULL CHECK (action IN ('blocked', 'unblocked')),
  reason        TEXT,
  performed_by  TEXT NOT NULL,                  -- admin id or 'system'
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX user_status_events_user_idx ON user_status_events (user_id, created_at DESC);

-- ---------------------------------------------------------------
-- Wallets (one per user per currency)
-- balance is a cached value; ledger_entries is the source of truth.
-- The CHECK makes overdraft impossible even if app code has a bug.
-- ---------------------------------------------------------------
CREATE TABLE wallets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id),
  currency    CHAR(3) NOT NULL DEFAULT 'NGN',
  balance     BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, currency)
);

-- ---------------------------------------------------------------
-- Transactions (one row per money movement)
-- (initiated_by, idempotency_key) blocks duplicate or replayed requests.
-- request_hash detects the same key being reused with a different payload.
-- ---------------------------------------------------------------
CREATE TABLE transactions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference              TEXT NOT NULL UNIQUE,  -- public reference returned to clients
  type                   TEXT NOT NULL CHECK (type IN ('funding', 'transfer')),
  initiated_by           UUID NOT NULL REFERENCES users(id),
  idempotency_key        TEXT NOT NULL,
  request_hash           TEXT NOT NULL,
  source_wallet_id       UUID REFERENCES wallets(id),          -- NULL for funding
  destination_wallet_id  UUID NOT NULL REFERENCES wallets(id),
  amount                 BIGINT NOT NULL CHECK (amount > 0),
  currency               CHAR(3) NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'completed'
                         CHECK (status IN ('completed', 'reversed')),
  narration              TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (initiated_by, idempotency_key),
  CHECK (source_wallet_id IS DISTINCT FROM destination_wallet_id),
  CHECK (type = 'funding' OR source_wallet_id IS NOT NULL)
);

CREATE INDEX transactions_source_idx      ON transactions (source_wallet_id, created_at DESC);
CREATE INDEX transactions_destination_idx ON transactions (destination_wallet_id, created_at DESC);

-- ---------------------------------------------------------------
-- Ledger (double entry, append-only)
-- A transfer writes one debit and one credit. Funding writes one credit.
-- ---------------------------------------------------------------
CREATE TABLE ledger_entries (
  id              BIGSERIAL PRIMARY KEY,
  transaction_id  UUID NOT NULL REFERENCES transactions(id),
  wallet_id       UUID NOT NULL REFERENCES wallets(id),
  direction       TEXT NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount          BIGINT NOT NULL CHECK (amount > 0),
  balance_after   BIGINT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (transaction_id, wallet_id, direction)
);

CREATE INDEX ledger_entries_wallet_idx ON ledger_entries (wallet_id, id DESC);

-- Reconciliation check: should return zero rows.
-- SELECT w.id, w.balance,
--        COALESCE(SUM(CASE WHEN l.direction = 'credit' THEN l.amount ELSE -l.amount END), 0) AS ledger_balance
--   FROM wallets w LEFT JOIN ledger_entries l ON l.wallet_id = w.id
--  GROUP BY w.id, w.balance
-- HAVING w.balance <> COALESCE(SUM(CASE WHEN l.direction = 'credit' THEN l.amount ELSE -l.amount END), 0);
