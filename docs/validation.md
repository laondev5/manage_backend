# Standalone backend validation — 2026-11-18

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
