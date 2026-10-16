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
npm run lint
npm run build
```
