# Free worker scheduler (Cloudflare Workers)

This is the active scheduler for the Manage outbox worker. It uses a Cloudflare
Workers **Free plan** Cron Trigger, so it does not need Vercel Cron and does not
depend on the billing-locked GitHub Actions account.

The Worker makes a signed `POST` to:

```
{MANAGE_API_URL}/api/v1/internal/worker/tick?max=90
```

with `Authorization: Bearer {WORKER_TRIGGER_SECRET}`. It retries once after a
cold-start 503. The API does all outbox, presence, and stale-shift work.

## Deploy

```bash
cd api/cloudflare-worker
npm install -g wrangler        # skip if wrangler is already installed
wrangler login
wrangler secret put MANAGE_API_URL          # e.g. https://manage-backend-sigma.vercel.app
wrangler secret put WORKER_TRIGGER_SECRET   # the value used by the API's Vercel env
# Optional, only if Vercel Deployment Protection blocks the API:
wrangler secret put VERCEL_PROTECTION_BYPASS
wrangler deploy
```

`wrangler.toml` declares `*/5 * * * *` UTC. Cloudflare runs it every five
minutes and replaces old triggers on each deploy. Confirm in the Cloudflare
dashboard under **Workers & Pages → manage-worker-tick → Triggers**.

## Verify

```bash
wrangler tail manage-worker-tick
```

A successful run logs `Manage worker tick accepted` with the API response. The
API response includes `ok:true`. You can also check the admin health page or
call the endpoint manually with the same secret:

```bash
curl -X POST "https://manage-backend-sigma.vercel.app/api/v1/internal/worker/tick?max=90" \
  -H "authorization: Bearer $WORKER_TRIGGER_SECRET" \
  -H "content-type: application/json"
```

## Other schedulers

Any free scheduler that can send a custom `Authorization` header can call the
same endpoint. GitHub Actions is disabled because this repository's account is
locked for billing; it remains as a manual fallback in
`../.github/workflows/worker-tick.yml`.
