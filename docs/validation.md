# Standalone backend validation — 2026-11-18

## Standalone MongoDB support (shared-server fallback)

The configured production database is a shared standalone `mongod` that cannot
be converted to a replica set. The API now supports it without losing the
attendance invariants:

- `connectDatabase` checks `hello` at connect time. On a standalone server it
  reconnects with `retryWrites: false` (standalone rejects every txnNumber
  write, retryable writes included) and sets `supportsTransactions: false`.
- `withTransaction` runs write units in a plain session when transactions are
  unavailable, and also falls back at runtime if a server that reported a
  replica set rejects transaction numbers (code 20).
- Better Auth's MongoDB adapter is configured with `transaction: false` on
  standalone, as its documentation requires.
- Invariants rest on the existing unique indexes (one active WORKING shift per
  user, client-shift uniqueness, clock-event replay uniqueness) plus two
  compensating writes: a clock-in whose event insert fails deletes its own
  eventless shift, and an invitation accept whose membership/assignment fails
  releases the token for retry (a partially created membership is reused
  idempotently).
- Residual risk, documented in the runbook: a crash between the individual
  writes of presence observations, clock-out, or correction review can leave
  that unit partially applied on standalone; reconciliation and the next
  observation heal presence, and the event log stays append-only.

Re-verified 2026-11-18 (later session, after the invitation/callbackURL fixes):
`pnpm lint`, `pnpm typecheck`, `pnpm test` (48 unit tests), `pnpm test:integration`
(34 tests across five files, isolated binary via `MONGOMS_SYSTEM_BINARY`), and
`pnpm build` with the serverless import check all pass. The hosted API health
endpoint returns `200 {"status":"ok","service":"manage-api"}`, confirming the
startup fix in production. The invitation/verification link fixes are committed
locally as `b43faf8` but were not pushed (pushing can trigger a Vercel deploy).

Verified locally on 2026-11-18: `pnpm lint`, `pnpm typecheck`, `pnpm test` (43 tests),
`pnpm test:integration` (34 tests across five files, including a new
`standalone-mongo.integration.test.ts` that runs against a standalone
in-memory mongod: capability detection, replay dedupe, one-active-shift under
concurrency, clock-out/re-clock, injected event-insert failure compensation,
and end-to-end invitation accept), and `pnpm build` with the serverless bundle
import check. No production data was modified.

## Serverless bundle regression

After the rich-text report update, direct import of the generated ESM bundle
failed with `Dynamic require of "tty" is not supported`. The Node-only
serverless build now supplies `createRequire(import.meta.url)` for bundled
CommonJS dependencies. Report sanitization remains enabled and unchanged.
`pnpm build` now imports the actual generated bundle through
`scripts/check-serverless.mjs`, so this startup failure fails the build instead
of reaching deployment. Importing only the lazy `server.js` wrapper did not
exercise this failure.

## Extraction checks

Passed locally after extraction from the workspace:

- `pnpm install --frozen-lockfile`
- `pnpm lint` and `pnpm typecheck`
- `pnpm test`: 37 tests across five files
- `pnpm test:integration`: 25 tests across four files, using an isolated local
  MongoDB replica set via `MONGOMS_SYSTEM_BINARY`
- `pnpm build`, including the bundled serverless entry
- Import of the built Vercel `server.js` Express export
- `pnpm security:check` and `git diff --cached --check`

The configured hosted database passed a read-only ping. No production data was
modified. `.env`, `src/scripts/seed.ts` and `src/scripts/users.ts` are ignored.
The administrator bootstrap command is self-contained and remains available.

Live Vercel deployment, GitHub Actions execution, Resend delivery, Expo push and
native device behavior remain unverified. Resend API/webhook credentials and the
Expo push token still need provider-issued values. Follow the deployment runbook
for environment settings, database indexes and release smoke checks.
