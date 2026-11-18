# Deploying Manage on Vercel

This runbook also describes the separate web/mobile projects. Paths prefixed
`api/` refer to this repository root after extraction; `web/` and `mobile/`
refer to their separate repositories. Run API commands from this repository root.

Production topology:

```
Browser ──► Vercel project: web (Next.js)
              └─ /api/v1/* and /api/auth/* rewrites ──► Vercel project: api (Express)
                                                          └─ MongoDB Atlas (replica set)

Expo app ──────────────────────────────────────────────► Vercel project: api

GitHub Actions (every 5 min) ──► POST /api/v1/internal/worker/tick
                                  └─ drains outbox, reconciles presence/stale shifts
```

The worker is scheduled by GitHub Actions, not Vercel Cron:
`.github/workflows/worker-tick.yml` calls the secret-protected endpoint with
`WORKER_TRIGGER_SECRET` as a bearer token. `api/vercel.json` deliberately
declares no `crons` entry, so there is exactly one scheduler. Any other
external scheduler (cron on a VM, Cloud Scheduler) can call the same `POST`
endpoint with the same secret.

The deployment is split into two Vercel projects because the Next.js app and the
Express API have different runtimes, environment variables, and build outputs.

---

## 1. Prerequisites

- A Vercel account and team. Vercel's Hobby plan is for personal, non-commercial
  use; a business deployment needs Pro (or higher) for licensing and
  production-appropriate limits. Scheduling the worker with GitHub Actions
  instead of Vercel Cron removes the paid-plan constraints on cron frequency.
- A MongoDB Atlas cluster. Atlas clusters are replica sets, which the API needs
  for transactions. Use M0 only for smoke tests; its IOPS and connection limits
  are not sized for production traffic.
- A Resend account with a verified sending domain. Email is required in
  production: the API refuses to boot without `RESEND_API_KEY` and
  `RESEND_WEBHOOK_SECRET`.
- An Expo access token if the mobile app should receive push notifications.
  Without it, the scheduled worker has no push provider, and because local disk
  delivery is disabled in production, push deliveries fail and eventually land in
  the dead-letter state.

Generate secrets locally:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Use a different value for `BETTER_AUTH_SECRET` and `WORKER_TRIGGER_SECRET`.

---

## 2. Prepare MongoDB

1. Create the cluster and a database named `manage` (or your choice; it must match
   `MONGODB_DB_NAME`).
2. Create a database user with `readWrite` on that database only. Do not use an
   Atlas admin user.
3. Network access: Vercel functions have dynamic egress addresses. Add
   `0.0.0.0/0` and rely on the database user credentials, or use Vercel Secure
   Compute (Enterprise) if private networking is required.
4. Copy the SRV connection string and keep `retryWrites=true`.

Create indexes and verify them **once from a trusted machine**, not from a
serverless request:

```bash
MONGODB_URI='mongodb+srv://...' MONGODB_DB_NAME=manage pnpm db:indexes:apply
MONGODB_URI='mongodb+srv://...' MONGODB_DB_NAME=manage pnpm db:indexes:verify
```

`src/vercel.ts` intentionally never creates indexes or runs migrations at
request time; doing so would add latency and race between cold instances. Re-run
`db:indexes:apply` after every deploy that changes an index.

Create the first platform administrator before inviting anyone:

```bash
MONGODB_URI='mongodb+srv://...' MONGODB_DB_NAME=manage \
  pnpm bootstrap:admin -- --email you@example.com --name "Your Name" \
  --password 'a-long-unique-password' --org "Your Organization"
```

The command refuses to run if a platform administrator already exists. It does
not create a default password, and it does not enroll the account in MFA; enroll
MFA at first sign-in. `pnpm seed` is demo data for local development only.

---

## 3. Deploy the API project

Copy the contents of `api/` into its own Git repository, including `.github/`. Create a Vercel project from that API repository:

| Setting | Value |
| --- | --- |
| Root Directory | `.` (API repository root) |
| Framework Preset | Express |
| Build Command | `pnpm typecheck && pnpm build` (configured in `vercel.json`) |
| Output Directory | leave empty |
| Install Command | `pnpm install --frozen-lockfile` |
| Node.js Version | 22.x |

How the entry works:

- `api/server.js` is the Vercel entry. It imports `dist/serverless.js`
  lazily from inside the handler, so a bundle that fails to load is logged and
  answered with the usual `503 PROVIDER_UNAVAILABLE` JSON instead of the
  platform's anonymous `500 FUNCTION_INVOCATION_FAILED`.
- `api/tsup.config.ts` builds `src/app.ts` → `dist/serverless.js` as a
  **single self-contained file**: local source modules and npm dependencies
  are inlined, so the function imports nothing but Node built-ins at runtime.
  Each project now has its own dependencies and lockfile. Bundling is retained
  to preserve the tested serverless entry and its lazy initialization behavior.
- `vercel.json` declares `includeFiles: "dist/serverless.js*"` so the built
  bundle (and its source map) is always shipped with `server.js`.
- `dist/` is gitignored, so the build command is mandatory.
- `api/src/main.ts` is the long-running local/container entry. Never point
  Vercel at it; it opens a port listener. It is built separately and keeps its
  dependencies external.
- The other CLI entries (`bootstrap-admin`, `verify-indexes`, `apply-indexes`,
  `dev-db`) also stay external; they run with the repo's `node_modules` present.

A missing or invalid environment variable does **not** produce this 500. The
wrapper in `src/app.ts` catches bootstrap failures and returns
`503 PROVIDER_UNAVAILABLE` with a request id. If you see the platform's generic
500 page instead, the function failed to load, not to configure.

`vercel.json` pins `maxDuration: 60` for the function. The
scheduled tick self-limits to a 20-second deadline, so it finishes well inside
the limit.

### API environment variables

Set these for **Production** and **Preview**. Preview deployments should use a
separate database; admin endpoints in a preview can mutate whatever
`MONGODB_URI` points at.

| Variable | Required | Notes |
| --- | --- | --- |
| `NODE_ENV` | yes | `production`. Enables HTTPS/origin/secret validation. |
| `MONGODB_URI` | yes | Atlas SRV string, `retryWrites=true`. |
| `MONGODB_DB_NAME` | yes | e.g. `manage`. |
| `MONGODB_MAX_POOL_SIZE` | yes | `5`–`10` on serverless. Every warm instance keeps its own pool. |
| `BETTER_AUTH_SECRET` | yes | 32+ random characters. Rotating it signs everyone out. |
| `AUTH_BASE_URL` | yes | The **web** origin, e.g. `https://app.example.com`. Email links and Better Auth callbacks then route through the Next.js rewrite and stay first-party. |
| `TRUSTED_WEB_ORIGINS` | yes | The web origin, comma-separated, HTTPS only. |
| `MOBILE_SCHEME` | yes | `manage` unless you changed the Expo scheme. |
| `RESEND_API_KEY` | yes | Required; there is no disk fallback in production. |
| `RESEND_WEBHOOK_SECRET` | yes | Signing secret for the webhook endpoint. |
| `EMAIL_FROM` | yes | Must use a Resend-verified domain, e.g. `Manage <alerts@yourdomain.com>`. |
| `EXPO_ACCESS_TOKEN` | for push | Without it, push delivery fails in production. |
| `WORKER_TRIGGER_SECRET` | yes | 32+ random characters. The GitHub Actions workflow sends it as `Authorization: Bearer …`. The API refuses to boot without `CRON_SECRET` or `WORKER_TRIGGER_SECRET`. |
| `CRON_SECRET` | optional | Only for Vercel Cron. Leave empty: `api/vercel.json` has no `crons` entry, so this secret would be unused. |
| `WORKER_SCHEDULE_SECONDS` | yes | Match the workflow schedule: `300` for the default five-minute cron. |
| `OUTBOX_MAX_ATTEMPTS` | optional | Default `8`. |
| `WORKER_LEASE_SECONDS` | optional | Default `60`. Must stay below the function duration. |
| `PRESENCE_STALE_SECONDS` | optional | Default `300`. |
| `STALE_SHIFT_HOURS` | optional | Default `16`. |
| `LOCATION_RETENTION_DAYS` | optional | Default `7`. |
| `LOG_LEVEL` | optional | `info` in production. |

Do not set `ENABLE_DEV_TOKENS`; production boot fails if it is enabled. `PORT` and
`TRUST_PROXY` are irrelevant on Vercel — the app trusts one proxy hop
automatically when `VERCEL=1`, and Vercel owns the port.

After deploying, check:

```bash
curl -fsS https://api.example.com/health/live
curl -fsS https://api.example.com/health/ready   # pings MongoDB
curl -fsS https://api.example.com/api/v1/health  # public service marker
```

If the first request returns `503 PROVIDER_UNAVAILABLE`, environment validation
or the Mongo connection failed. Read the function logs and use the request ID in
the response; the API logs no secrets.

---

## 4. Deploy the web project

Copy `web/` into its own Git repository and create a second Vercel project. Run all commands from the relevant project folder.

| Setting | Value |
| --- | --- |
| Root Directory | `.` (web repository root) |
| Framework Preset | Next.js (auto-detected) |
| Build Command | default |
| Output Directory | default |

| Variable | Required | Notes |
| --- | --- | --- |
| `API_ORIGIN` | yes | The API project origin, e.g. `https://api.example.com`. Server-only. Used by Next rewrites for `/api/v1/*` and `/api/auth/*`. |
| `NEXT_PUBLIC_API_BASE_URL` | no | Leave **empty** in the normal setup. The browser then calls the web origin, and Next proxies to the API. |

Leaving `NEXT_PUBLIC_API_BASE_URL` empty keeps auth cookies first-party. If the
browser called the API origin directly, Better Auth's `sameSite=lax` cookie would
not be sent on cross-site requests, and the session would appear to vanish after
sign-in. If you must use an absolute API URL, make both hosts subdomains of the
same registrable domain and understand the cookie implications before doing so.

Preview deployments: either give each preview its own Atlas database, or turn
preview deployments off for the web project if previews would share production
data. Previews inherit `API_ORIGIN` and will proxy to production otherwise.

Mobile builds point at the API directly:

```bash
EXPO_PUBLIC_API_URL=https://api.example.com
```

---

## 5. Schedule the worker with GitHub Actions

`api/vercel.json` intentionally declares no `crons` block; the schedule
lives in `.github/workflows/worker-tick.yml` on the default branch:

```yaml
on:
  schedule:
    - cron: '*/5 * * * *'
  workflow_dispatch:
```

Each run sends `POST /api/v1/internal/worker/tick?max=90` with
`Authorization: Bearer $WORKER_TRIGGER_SECRET`, retries once (a cold function
returns 503), and fails the job when both attempts fail. `max=90` lets one tick
clear more than a single five-minute batch; the endpoint clamps at 100 and
self-limits to a 20-second deadline. The handler still accepts `GET` with
`CRON_SECRET` and returns 404 while neither secret is set, so an unconfigured
deployment does not advertise the endpoint.

Repository secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
| --- | --- |
| `MANAGE_API_URL` | API project origin, e.g. `https://api.example.com`. |
| `WORKER_TRIGGER_SECRET` | Identical to the API project's `WORKER_TRIGGER_SECRET`. |
| `VERCEL_PROTECTION_BYPASS` | Optional. Only when Vercel Deployment Protection is enabled on the API project; otherwise Vercel answers 401 before the request reaches the API. |

Plan around these GitHub constraints:

- Scheduled workflows run only from the **default branch**, and only once the
  workflow file is merged there.
- `*/5` is the finest granularity and actual start times drift or are dropped
  under load. The outbox is durable and the next run picks up the batch, so
  lateness delays notifications but never loses them.
- In public repositories, GitHub disables scheduled workflows after **60 days without repository
  activity** and emails the owner. The admin health page then reports the worker
  as overdue; re-enable the workflow from the Actions tab.

Each tick heartbeats the worker, leases a bounded batch, delivers email/push,
marks failures, reconciles presence, flags stale shifts, purges precise
coordinates past `LOCATION_RETENTION_DAYS` (up to 500 rows per collection per
tick), and returns:

```json
{
  "workerId": "scheduled-…",
  "delivered": 12,
  "failed": 0,
  "remaining": false,
  "reconciled": true,
  "presenceReconciled": 0,
  "staleShiftsFlagged": 0,
  "locationsPurged": 0,
  "durationMs": 2130,
  "ok": true
}
```

Verify it after the first deploy, then run the workflow by hand once
(Actions → Worker tick → Run workflow) and confirm the output contains
`"ok":true`:

```bash
curl -fsS -X POST "https://api.example.com/api/v1/internal/worker/tick?max=40" \
  -H "Authorization: Bearer $WORKER_TRIGGER_SECRET"
```

### Cadence

| Schedule | Runs/day | Notes |
| --- | --- | --- |
| `*/5 * * * *` (default) | 288 | Pair with `WORKER_SCHEDULE_SECONDS=300`. |
| `*/10 * * * *` | 144 | Set `WORKER_SCHEDULE_SECONDS=600` to match. |
| daily | 1 | Not suitable for attendance alerts. |

GitHub Actions does not retry a failed run either, and it does not wake a
sleeping repository; the next scheduled run picks the batch up. Expect a cold
start on the first tick after idle traffic; the 60-second function limit
accommodates it.

---

## 6. Configure the Resend webhook

1. In Resend, add a webhook to `https://api.example.com/api/v1/webhooks/resend`.
2. Subscribe to delivery, bounce, and complaint events.
3. Copy the signing secret into `RESEND_WEBHOOK_SECRET` and redeploy the API.
4. Send a test event. The API verifies the signature against the raw request
   body and rejects timestamps older than five minutes.

The webhook route is mounted before the JSON body parser on purpose. Do not add
`express.json()` or a platform body parser ahead of it; signature verification
needs the exact bytes Resend signed. The API never reads Vercel's lazy
`request.body` helper.

A delivered notification updates the outbox item's delivery report. Bounces and
failures record the provider error on the item; there is no automatic address
suppression, so remove a bad address in the product rather than expecting Resend
events to do it. Duplicate webhook events are ignored by event ID. Check the admin
health page for failed deliveries and dead-lettered outbox items.

---

## 7. Health, alerting, and recovery

| Endpoint | Purpose |
| --- | --- |
| `/health/live` | Process liveness; no dependencies. |
| `/health/ready` | MongoDB ping; use for uptime checks. |
| `/api/v1/health` | Public service marker. |
| `/api/v1/admin/health` | Authenticated console data (MFA + capability required). |

The admin health page shows the worker heartbeat and the `scheduled` worker
state. The stale threshold is `max(2 × WORKER_SCHEDULE_SECONDS + 120, 300)` —
12 minutes for the default five-minute schedule. If the page reports an overdue
scheduler:

1. Open the repository's **Actions → Worker tick** tab and check the last run.
   A workflow that GitHub disabled for inactivity shows as disabled at the top
   of the tab.
2. Confirm the workflow file is on the default branch — scheduled runs ignore
   the same file on other branches.
3. Confirm `MANAGE_API_URL` and `WORKER_TRIGGER_SECRET` repository secrets exist
   and that the secret matches the API project's variable. A mismatch returns
   401 from the API; Deployment Protection returns 401 from Vercel before the
   request is forwarded.
4. Trigger the endpoint manually with the curl command above and read the JSON.

Rotating `WORKER_TRIGGER_SECRET`: update it on the API project first, redeploy
so the function environment changes, then update the repository secret. Requests
signed with the old value return 401 immediately. Preview deployments need the
same value if you run the workflow against them.

Rollback:

- Use Vercel Instant Rollback to return the API or web project to a previous
  deployment. Rollback does not un-send notifications.
- Database changes in this project are additive indexes applied with
  `db:indexes:apply`; there are no destructive migrations in the deploy path.
- Outbox items that were leased but not completed are reclaimed after
  `WORKER_LEASE_SECONDS`; dead-lettered items can be retried from the admin
  console after fixing the provider.

Deployment order for a fresh environment:

1. Atlas cluster, database user, indexes, first platform admin.
2. API project and environment variables; verify `/health/ready`.
3. Web project and environment variables; sign in with MFA.
4. Resend webhook and a test event.
5. Repository secrets plus the merged `worker-tick.yml`; run the workflow once
   by hand and confirm `"ok":true`.
6. Invite real users from the owner console (invitation-only; there is no public
   signup).

## Research and standalone ownership (2026-11-18)

- [Vercel Express](https://vercel.com/docs/frameworks/backend/express): Express runs as one Vercel Function with Fluid Compute. Keep the existing Node runtime, bounded tick handler, and cached Mongo client. No always-running worker is started in the function.
- [Vercel configuration](https://vercel.com/docs/project-configuration/vercel-json): memory is not configured per function with Fluid Compute; duration remains explicit.
- [MongoDB connection storms](https://www.mongodb.com/docs/manual/troubleshooting/connection-storms/): reuse clients and keep pools small across scaled instances.
- [GitHub schedule](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule): default-branch schedules have a five-minute minimum and may be delayed or dropped. Public inactive repositories can have schedules disabled.

The scheduler file is `api/.github/workflows/worker-tick.yml` in this collection; it must be `.github/workflows/worker-tick.yml` at the API repository root after extraction. Retire the old repository schedule when switching to avoid duplicate schedulers. Never enable both the continuous worker and scheduled ticks for the same deployment intentionally. No Vercel cron is configured. Place the API near Atlas using the Vercel region setting after choosing the database region.
