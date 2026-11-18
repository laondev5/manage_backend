# Manage API

This is an independent project. Install and run pnpm here; never import sibling
projects or add workspace dependencies. src/contracts is the canonical API schema;
coordinate compatible changes with the separately maintained web/mobile copies.

Express is the only business backend. Keep authorization in src/domain and
src/http/context.ts, deny by default, re-resolve roles/scopes per request, and
scope all queries/exports/jobs. Require owner/admin TOTP MFA. Keep browser Origin
and CSRF checks, raw Resend webhook bytes, and header/log redaction intact.

Attendance, presence and sync are separate. Missing GPS is unknown; leaving never
clocks someone out or reduces payable time. Enforce one accepted active shift
atomically. Originals and hash-chain audit history are append-only; amendments
are audited and nobody approves their own correction. Recompute recipients at
delivery time and preserve durable replay IDs, outbox leases and race protection.

Do not log secrets, coordinates, tokens, invitation links or MFA secrets. Do not
send real invitations or deploy production without authorization. Use labeled
local adapters when credentials are missing. Never claim compliance/readiness
without measured evidence.

Read relevant code before changing behavior; plan nontrivial work. Run pnpm lint,
typecheck, test, test:integration and build after changes. Keep openapi.yaml,
.env.example, index scripts and docs current. Integration tests require MongoDB
download or MONGOMS_SYSTEM_BINARY. Vercel uses server.js and a bounded tick;
GitHub Actions owns the schedule, with WORKER_SCHEDULE_SECONDS=300. No Vercel cron
or always-running worker inside the function. Preserve the cached Mongo client.
