# REST Client requests

`wallet-service.http` exercises every endpoint, covering the happy path and the main errors. Each request's
`###` line states the expected status and error code. It's for manual checks; the automated tests are in `test/`.

## Setup

1. Install the VS Code extension **REST Client** (`humao.rest-client`).
2. `cp rest-client/.env.example rest-client/.env`, then set:
   - `BASE_URL`: `http://localhost:3600` locally, or the Render URL.
   - `ADMIN_EMAIL` / `ADMIN_PASSWORD`: the same values as the app's `.env`, so they match the seeded admin
     created by `npm run migrate`.
3. Start the app: `docker compose up -d db && npm run migrate && npm run start:dev`.

## Running

Open `wallet-service.http` and click **Send Request** above each request, **top to bottom**. Requests marked
`# @name` save their response, and later requests read tokens and ids from it. If you skip one, later
requests send an unresolved `{{...}}` and fail.

Each run signs up new users (Alice and Bob), so you can run the file again from the top.

## Rate limits

- Login: 5 per minute per IP. One pass makes 4 logins.
- Signup: 10 per minute per IP. One pass makes 7 signup requests.

If you get `429 TOO_MANY_REQUESTS`, wait a minute.
