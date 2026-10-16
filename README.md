# Wallet Service

User accounts with NGN wallets, wallet-to-wallet transfers, a blacklist check at signup, and admin block/unblock.
NestJS 10 · TypeScript · PostgreSQL 15 (plain SQL, no ORM) · deployed on Render.

## Live demo

- API: https://wallet-service-jdlj.onrender.com
- Swagger: https://wallet-service-jdlj.onrender.com/docs

The first request after 15 minutes idle can take up to a minute while the free server wakes up.
Amounts are in kobo, sent as strings: `"500000"` = ₦5,000.

**1. Log in as admin.** In Swagger, open **auth → POST /auth/login → Try it out** and send the demo admin login:

```json
{ "email": "admin@yourdomain.com", "password": "youradminpassword" }
```

Click **Execute**, copy `data.accessToken`, then click **Authorize** (top right), paste the token and click
**Authorize**. Tokens expire after 15 minutes, so log in again if you get `401`. This admin exists only for the demo,
and all money in it is test data.

**2. Create two accounts:** **users → POST /users**, sent twice:

```json
{ "email": "alice.demo@example.com", "phone": "08030000001", "fullName": "Alice Demo", "password": "AliceDemo#2026" }
```

```json
{ "email": "bob.demo@example.com", "phone": "08030000002", "fullName": "Bob Demo", "password": "BobDemo#2026" }
```

Note each `data.wallet.id`. If you get `409 USER_EXISTS`, the accounts already exist: log in as each one and get
the wallet id from **GET /users/me**.

**3. Fund both wallets as admin:** **admin: wallets → POST /admin/wallets/{id}/fund**, using the admin token:

- Alice: `id` = Alice's wallet id, `Idempotency-Key` = `fund-alice-001`, body `{ "amount": "500000" }`
- Bob: `id` = Bob's wallet id, `Idempotency-Key` = `fund-bob-001`, body `{ "amount": "200000" }`

**4. Transfer from Alice to Bob.** Log in as Alice (`alice.demo@example.com` / `AliceDemo#2026`) and **Authorize**
with her token. Then **transfers → POST /transfers** with `Idempotency-Key` = `alice-to-bob-001`:

```json
{ "sourceWalletId": "<Alice's wallet id>", "destinationWalletId": "<Bob's wallet id>", "amount": "25000", "narration": "Lunch" }
```

You'll get `201`. Send the same request again and you'll get `200` with `"replayed": true`, and the money only
moves once. Use a new key for each new transfer.

**5. Check balances:** **GET /wallets/{id}** shows Alice at `"475000"` and Bob at `"225000"`.

The live database is shared, so anything you create stays there for everyone.

## Run locally

Needs Node 24 and Docker.

```bash
npm install
cp .env.local .env          # then set JWT_SECRET (32+ chars), ADMIN_EMAIL and ADMIN_PASSWORD
docker compose up -d db     # Postgres on localhost:5433 (wallet_dev and wallet_test)
npm run migrate             # creates the schema and the admin user
npm run start:dev           # http://localhost:3600/docs
```

Optional settings: `CORS_ORIGINS` (comma-separated browser origins) and `RATE_LIMIT_PER_MINUTE` (default 100).
`rest-client/wallet-service.http` walks through every endpoint with the VS Code REST Client extension.

## Endpoints

Full request and response details, including error codes, are in Swagger at `/docs`.

| Method | Path | Auth | Description |
| ------ | ---- | ---- | ----------- |
| POST | `/users` | public | Sign up; creates the user and an NGN wallet |
| POST | `/auth/login` | public | Returns a JWT (15 min) |
| GET | `/users/me` | user | Your profile and wallets |
| GET | `/wallets/:id` | owner or admin | Wallet and balance |
| GET | `/wallets/:id/transactions` | owner or admin | History, newest first, cursor-paged |
| POST | `/transfers` | user + `Idempotency-Key` | Send from your wallet to another |
| POST | `/admin/wallets/:id/fund` | admin + `Idempotency-Key` | Credit a wallet |
| PATCH | `/admin/users/:id/block` · `/unblock` | admin | Block or unblock, with a reason |
| GET | `/admin/users/:id/status-history` | admin | Block/unblock audit trail |
| POST · DELETE | `/admin/blacklist` · `/admin/blacklist/:id` | admin | Manage blacklisted email, phone, BVN, NIN |
| GET | `/health` | public | Database check; Render's health check |

Success responses are `{ "data": ... }`; errors are `{ "error": { "code": "INSUFFICIENT_FUNDS", "message": "..." } }`.

## Design decisions

**Money is integer kobo.** Stored as `BIGINT`, handled as `bigint` in code, and sent as a string in JSON, so
there's no floating-point rounding and no precision loss past 2^53.

**Double-entry ledger.** Each transfer writes one `transactions` row (the business event) and two
`ledger_entries` (a debit and a credit). Ledger entries are append-only. `wallets.balance` is a cached total
that always equals the sum of that wallet's entries, and the tests check this after every concurrent run. A
`CHECK (balance >= 0)` makes an overdraft impossible even if the code had a bug.

**Concurrency: one transaction, ordered row locks.** A transfer runs in one database transaction:
lock both wallets with `SELECT … FOR UPDATE` **in id order** → check idempotency → validate → write the
transaction, both balance updates and both ledger entries → commit. Locking in a fixed order means A→B and B→A
can't deadlock. Parallel transfers from one wallet queue on its lock, so each sees the real balance. A 5s
`lock_timeout` returns `503 TRY_AGAIN` instead of hanging.

**Idempotency.** Every money movement needs an `Idempotency-Key`, unique per user. The same key with the same
body returns the original result (`200`, `"replayed": true`). The same key with a different body returns
`409 IDEMPOTENCY_KEY_REUSED`. The check runs *after* the lock, so a duplicate sent at the same moment waits and
then sees the first request's result. A unique index on `(initiated_by, idempotency_key)` is the backstop.

**Blocked users** can log in and view their data, but can't send or receive. The check reads the database inside
the transfer transaction, so a block takes effect immediately, not when the user's token expires.

**BVN** is optional at signup, stored as 11 digits, unique per account, checked against the blacklist with the
email and phone, and only ever returned masked (`*******8901`). Logs never contain BVNs, passwords or tokens.

**No ORM.** The transfer's correctness depends on the exact SQL: lock order, `FOR UPDATE`, and when the
idempotency check runs. Plain SQL in one place keeps that visible and reviewable. Other modules follow
controller → service → repository.

**Security defaults.** Passwords hashed with argon2; the acting user always comes from the JWT, never the body;
every query is parameterised; rate limiting (5 logins and 10 signups per minute per IP, 100 requests per minute
otherwise); 10kb body limit; CORS allow-list; helmet headers. On shutdown the server finishes open requests
before closing the database pool.

### Trade-offs and next steps

- **Funding is single-entry.** Admin funding credits the wallet with no matching debit. Next: a system "funding"
  wallet so every movement balances to zero.
- **Rate limits are in memory**, so they're per instance and reset on deploy. Fine for one instance; more would
  need Redis.
- **No refresh tokens or token revocation.** Tokens are short-lived (15 min) instead.
- **Next:** reversals (the `reversed` status is in the schema), an outbox with webhooks for transfer events,
  multi-currency wallets with FX, and per-account login lockout.

## Tests

```bash
npm test                    # unit tests
npm run test:e2e            # e2e against real Postgres (needs docker compose up -d db)
```

The e2e tests never mock the database. The concurrency specs prove the transfer path holds under parallel load:

- `test/transfers.concurrency.e2e-spec.ts`: 50 parallel transfers of 100 kobo from a 1,000 kobo balance give
  exactly 10 successes and a balance of 0 (no overspend); 100 opposing A→B / B→A transfers finish with no deadlocks.
- `test/idempotency.e2e-spec.ts`: 20 parallel identical requests create one transaction and one pair of ledger
  entries, and all 20 responses carry the same reference.
- After each test, every balance is checked against its ledger, and every transfer must have exactly one debit and
  one credit of equal amount.

CI (`.github/workflows/ci.yml`) runs lint, build, unit and e2e tests against Postgres 15 on every push.

## Deployment

`render.yaml` is a Render Blueprint: **New > Blueprint** in Render, pick the repo, and set `ADMIN_EMAIL` and
`ADMIN_PASSWORD`. It creates the Postgres database and the web service, runs migrations on every start (they're
idempotent and lock-guarded), and uses `/health` as the health check.
