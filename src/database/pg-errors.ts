/** Postgres SQLSTATE codes the app handles. https://www.postgresql.org/docs/current/errcodes-appendix.html */
export const PG_UNIQUE_VIOLATION = '23505';
export const PG_NUMERIC_OUT_OF_RANGE = '22003';
export const PG_LOCK_NOT_AVAILABLE = '55P03'; // lock_timeout expired
export const PG_DEADLOCK_DETECTED = '40P01';

/** UNIQUE (initiated_by, idempotency_key) on transactions. */
export const IDEMPOTENCY_CONSTRAINT = 'transactions_initiated_by_idempotency_key_key';
