# Manage API

Standalone Express backend for web and mobile. All domain, database, contract
and worker code is under `src/`; no sibling project is required.

Use Node 22 LTS and pnpm 10.20.0. Run `pnpm install --frozen-lockfile`, copy
`.env.example` to `.env`, then `pnpm db:dev` and `pnpm dev` in separate terminals.
MongoDB must be a replica set. `pnpm dev:worker` runs the optional local worker.
`pnpm bootstrap:admin` creates the initial administrator. The local seed script
is intentionally not distributed.

Checks: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, and
`pnpm build`. Integration tests download MongoDB unless MONGOMS_SYSTEM_BINARY is set.
Installation skips the test MongoDB binary download; production uses the configured
hosted MONGODB_URI. `pnpm security:check` checks tracked/staged files for secrets.
Both `src/scripts/seed.ts` and `src/scripts/users.ts` are local-only and ignored.

Deploy this folder as its own repository, Vercel Express preset, Node 22.x,
root `.`, with the committed vercel.json. The GitHub Actions workflow belongs
at `.github/workflows/worker-tick.yml` in the API repository. Set its
MANAGE_API_URL and WORKER_TRIGGER_SECRET secrets, and WORKER_SCHEDULE_SECONDS=300
on the API. Retire the old repository's scheduler. No Vercel cron is configured.

See [deployment instructions](docs/deployment-vercel.md) for Atlas, environment
variables, indexes, MFA, browser proxy configuration, Resend, and smoke checks.
