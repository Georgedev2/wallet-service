# Wallet Service

User accounts, NGN wallets, and wallet-to-wallet transfers, built with NestJS 10, TypeScript and PostgreSQL 15 (plain SQL via `pg`, no ORM).

## Requirements

- Node.js 24
- Docker (for local Postgres)

## Local setup

```bash
npm install
cp .env.local .env          # then set JWT_SECRET (min 32 chars)
docker compose up -d db     # Postgres on localhost:5433, creates wallet_dev and wallet_test
npm run migrate             # apply migrations and seed the admin user
npm run start:dev           # http://localhost:3600
```

Compose maps Postgres to host port **5433**, so it doesn't clash with a local Postgres on 5432.

## Environment

| Variable            | Required | Default       | Notes                                             |
| ------------------- | -------- | ------------- | ------------------------------------------------- |
| `DATABASE_URL`      | yes      |               | `postgres://` or `postgresql://`                  |
| `JWT_SECRET`        | yes      |               | At least 32 characters                            |
| `PORT`              | no       | `3600`        |                                                   |
| `DATABASE_SSL`      | no       | `false`       | `true` on Render (TLS without certificate checks) |
| `JWT_EXPIRES_IN`    | no       | `15m`         |                                                   |
| `ADMIN_EMAIL`       | no       |               | Set both admin variables, or neither              |
| `ADMIN_PASSWORD`    | no       |               | At least 8 characters                             |
| `ADMIN_PHONE`       | no       | `+2340000000000` | Seeded admin's phone (E.164)                   |
| `ADMIN_FULL_NAME`   | no       | `Administrator`  | Seeded admin's name                            |
| `TEST_DATABASE_URL` | e2e only |               | e2e tests run against this, never `DATABASE_URL`  |
| `NODE_ENV`          | no       | `development` | Set `production` on Render (JSON logs, no pino-pretty) |

The app and the migration runner both validate the environment at startup, and exit if it's invalid.

## API conventions

- Success: `{ "data": ... }`. Error: `{ "error": { "code": "INSUFFICIENT_FUNDS", "message": "..." } }`.
- Money is sent and received as a string of kobo digits: `"150000"` is ₦1,500.00.
- Every money movement needs an `Idempotency-Key` header: 8-128 characters of `A-Z a-z 0-9 _ -`.
- Every response has an `x-request-id` header, which also appears in the logs. A safe incoming `X-Request-Id` is reused.
- Authenticated routes need `Authorization: Bearer <accessToken>`. A missing or invalid token gets 401 `UNAUTHORIZED`; a non-admin on an admin route gets 403 `FORBIDDEN`.

## Endpoints

### `POST /auth/login`

Body: `{ "email": "...", "password": "..." }`. The email is trimmed and lowercased.

Returns `200` with `{ "data": { "accessToken": "...", "user": { "id", "email", "fullName", "role", "status" } } }`.
The token is an HS256 JWT valid for `JWT_EXPIRES_IN`. Blocked users can log in.

Errors: `401 INVALID_CREDENTIALS` (same response whether the email is unknown or the password is wrong),
`400 VALIDATION_ERROR`, and `429 TOO_MANY_REQUESTS` after 5 attempts per minute from one IP.

### `POST /users`

Public signup. Body: `{ "email", "phone", "fullName", "password", "bvn"? }`.

- `password`: 8–256 characters. `phone`: a Nigerian number like `08031234567`, or international format
  like `+2348031234567`; stored as E.164. `bvn` (optional, 11 digits) is checked against the blacklist
  and stored; one BVN can belong to only one account. Responses show it masked (`"*******8901"`), or `null`.
- Creates the user and an NGN wallet in one transaction.

Returns `201` with `{ "data": { "user": { "id", "email", "phone", "fullName", "bvn", "role", "status", "blockedReason", "blockedAt", "createdAt" },
"wallet": { "id", "currency": "NGN", "balance": "0" } } }`.

Errors: `403 USER_BLACKLISTED` ("Unable to create account"; doesn't say which identifier matched),
`409 USER_EXISTS` (email, phone or BVN taken; email is case-insensitive),
`400 VALIDATION_ERROR | INVALID_PHONE | INVALID_BVN`, `429` after 10 signups per minute from one IP.

### `GET /users/me` (authenticated)

Returns `{ "data": { "user": { ... }, "wallets": [{ "id", "currency", "balance" }] } }`.

### `PATCH /admin/users/:id/block` and `PATCH /admin/users/:id/unblock` (admin)

Body: `{ "reason": "..." }` (required, max 500 characters). Returns `200` with the updated user.
Each change writes a `user_status_events` row recording the acting admin. Blocked users can still log in
and view their data, but can't send or receive transfers.

Errors: `409 ALREADY_BLOCKED` / `409 NOT_BLOCKED`, `422 CANNOT_BLOCK_SELF`, `404 USER_NOT_FOUND`,
`400 VALIDATION_ERROR` (malformed id or reason), `401`, `403`.

### `GET /admin/users/:id/status-history` (admin)

Returns the block/unblock events, newest first: `[{ "id", "action", "reason", "performedBy", "createdAt" }]`.

### `GET /wallets/:id` (owner or admin)

Returns `{ "id", "userId", "currency", "balance": "150050", "balanceFormatted": "1500.50", "status", "createdAt", "updatedAt" }`.
Anyone else gets `404 WALLET_NOT_FOUND`, the same as for a wallet that doesn't exist.

### `GET /wallets/:id/transactions?limit=20&cursor=...` (owner or admin)

Newest first. Returns `{ "items": [...], "nextCursor": "..." | null }`; pass `nextCursor` back as `cursor`
for the next page. Pages are stable: new entries never shift or repeat later pages. `limit` is 1–100 (default 20).
Each item: `reference`, `type` (`funding` | `transfer`), `direction` (`credit` | `debit`), `amount`,
`balanceAfter`, `counterpartyWalletId` (null for funding), `narration`, `createdAt`.

### `POST /transfers` (authenticated, `Idempotency-Key` required)

Body: `{ "sourceWalletId", "destinationWalletId", "amount": "2500", "narration"?: "..." }` (narration max 140).
The sender is always the token's user; the source wallet must be theirs.

Returns `201` with `{ "reference", "amount", "currency", "sourceWalletId", "destinationWalletId", "narration",
"status", "balanceAfter", "createdAt", "replayed": false }`. `balanceAfter` is the sender's new balance.

The same key with the same body returns `200` with the original body and `"replayed": true`; money moves once.
The same key with a different body gets `409 IDEMPOTENCY_KEY_REUSED`. Keys are scoped per user.

Errors: `404 WALLET_NOT_FOUND`, `403 FORBIDDEN` (not your wallet), `403 USER_BLOCKED` (sender or recipient),
`422 WALLET_FROZEN | CURRENCY_MISMATCH | INSUFFICIENT_FUNDS | SAME_WALLET`, `503 TRY_AGAIN` (a wallet stayed
locked for 5s; safe to retry with the same key), `400 INVALID_AMOUNT | VALIDATION_ERROR | MISSING_IDEMPOTENCY_KEY`, `401`.

### `POST /admin/wallets/:id/fund` (admin, `Idempotency-Key` required)

Body: `{ "amount": "150000", "narration"?: "..." }` (narration max 140 characters).
Returns `201` with `{ "reference", "type": "funding", "walletId", "amount", "currency", "narration", "status",
"balanceAfter", "createdAt", "replayed": false }`.

Repeating the request with the same key returns `200` with the original body and `"replayed": true`; the
wallet is credited once. The same key with a different wallet, amount or narration gets `409 IDEMPOTENCY_KEY_REUSED`.

Errors: `404 WALLET_NOT_FOUND`, `403 USER_BLOCKED` (owner blocked), `422 WALLET_FROZEN`,
`400 INVALID_AMOUNT | MISSING_IDEMPOTENCY_KEY | INVALID_IDEMPOTENCY_KEY`, `401`, `403`.

### `POST /admin/blacklist` (admin)

Body: `{ "identityType": "email" | "phone" | "bvn" | "nin", "identityValue": "...", "reason": "..." }`.

The value is normalised before it's stored: emails are trimmed and lowercased; phones become E.164,
with Nigerian local numbers converted (`0803 123 4567` → `+2348031234567`); BVN and NIN keep only
their 11 digits. Returns `201` with the entry. Its `id` is a string.

Errors: `409 ALREADY_BLACKLISTED`, `400 INVALID_EMAIL | INVALID_PHONE | INVALID_BVN | INVALID_NIN | VALIDATION_ERROR`,
`401`, `403 FORBIDDEN`.

### `DELETE /admin/blacklist/:id` (admin)

Returns `204`. Errors: `404 BLACKLIST_ENTRY_NOT_FOUND`, `400 VALIDATION_ERROR` for a malformed id, `401`, `403`.

## Migrations

SQL files in `src/database/migrations/` are applied in filename order. Each one runs in its own transaction and is recorded in `schema_migrations`. A Postgres advisory lock stops two deploys from running migrations at the same time.

```bash
npm run migrate        # from source (ts-node)
npm run migrate:prod   # from the build: node dist/database/migrations/run-migrations.js
```

The build copies the `.sql` files into `dist/`. On Render, set the pre-deploy command to `npm run migrate:prod`.

## Tests

```bash
npm test               # unit tests
npm run test:e2e       # e2e tests against real Postgres (needs docker compose up -d db)
                       # migrates TEST_DATABASE_URL first (test/global-setup.ts)
npm run lint
npm run build
```

`test/transfers.concurrency.e2e-spec.ts` and `test/idempotency.e2e-spec.ts` fire parallel requests at the real
database: 50 transfers racing to overspend one balance, 100 opposing transfers that would deadlock without
ordered locking, and the same `Idempotency-Key` sent 20 times at once. After each test they check that every
balance equals the sum of its ledger entries, and that every transfer has exactly one debit and one credit.
