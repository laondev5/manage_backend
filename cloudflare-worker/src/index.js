/**
 * Free scheduled driver for Manage's outbox worker.
 *
 * Cloudflare Cron Triggers invoke `scheduled()` every five minutes. The Worker
 * only holds secrets and pokes the API's authenticated tick endpoint; the API
 * does the actual outbox draining, presence reconciliation, and stale-shift
 * flagging. No secret is stored in wrangler.toml or logged.
 */

const TICK_PATH = '/api/v1/internal/worker/tick?max=90';

function trim(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function triggerHeaders(env) {
  const secret = trim(env.WORKER_TRIGGER_SECRET);
  if (!secret) throw new Error('WORKER_TRIGGER_SECRET is not set.');

  const headers = {
    authorization: `Bearer ${secret}`,
    'content-type': 'application/json',
  };
  const bypass = trim(env.VERCEL_PROTECTION_BYPASS);
  if (bypass) headers['x-vercel-protection-bypass'] = bypass;
  return headers;
}

async function postTick(env, scheduledAt) {
  const baseUrl = trim(env.MANAGE_API_URL).replace(/\/+$/, '');
  if (!baseUrl) throw new Error('MANAGE_API_URL is not set.');

  const headers = triggerHeaders(env);
  const url = `${baseUrl}${TICK_PATH}`;
  let lastError;

  // One retry covers a cold Vercel function returning 503.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ scheduledAt }),
      });
      if (response.ok) {
        const body = await response.text();
        console.log('Manage worker tick accepted', { attempt, body });
        return;
      }
      const body = await response.text();
      lastError = new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
    } catch (error) {
      lastError = error;
    }
    console.warn('Manage worker tick attempt failed', { attempt, reason: lastError?.message });
    if (attempt < 2) await delay(5000);
  }

  throw new Error(`Manage worker tick failed after two attempts: ${lastError?.message ?? 'unknown error'}`);
}

export default {
  async scheduled(controller, env, ctx) {
    const scheduledAt = new Date(controller.scheduledTime).toISOString();
    ctx.waitUntil(postTick(env, scheduledAt));
  },
};
