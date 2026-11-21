import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { OrganizationDoc, SiteDoc } from '../../database/index.js';
import { createTestContext, type TestContext } from './harness.js';

describe('authorization boundaries', () => {
  let ctx: TestContext;
  let northwind: OrganizationDoc;
  let siteA: SiteDoc;

  beforeAll(async () => {
    ctx = await createTestContext();
    const ownerA = await ctx.createUser('owner-a@example.com', 'Owner A');
    const ownerB = await ctx.createUser('owner-b@example.com', 'Owner B');
    const staffA = await ctx.createUser('staff-a@example.com', 'Staff A');
    const admin = await ctx.createUser('admin@example.com', 'Admin');

    northwind = await ctx.createOrganization('Northwind', 'owner-a@example.com');
    const harbor = await ctx.createOrganization('Harbor', 'owner-b@example.com');
    siteA = await ctx.createSite({
      organization: northwind,
      name: 'Marina Tower',
      ownerIds: [ownerA],
      createdBy: ownerA,
    });
    await ctx.createSite({
      organization: harbor,
      name: 'Wuse Depot',
      ownerIds: [ownerB],
      createdBy: ownerB,
      latitude: 9.0765,
      longitude: 7.3986,
    });

    await ctx.createMembership({ organization: northwind, userId: ownerA, role: 'SITE_OWNER' });
    await ctx.createMembership({ organization: harbor, userId: ownerB, role: 'SITE_OWNER' });
    const membership = await ctx.createMembership({
      organization: northwind,
      userId: staffA,
      role: 'STAFF',
    });
    await ctx.assign({ organization: northwind, site: siteA, userId: staffA, membership });
    await ctx.createMembership({ organization: northwind, userId: admin, role: 'PLATFORM_ADMIN' });
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('denies unauthenticated requests to every registered protected business endpoint', async () => {
    const source = readFileSync(new URL('../../routes/index.ts', import.meta.url), 'utf8');
    const protectedSource = source.slice(source.indexOf('router.use(requireAuth(deps))'));
    const routes = [...protectedSource.matchAll(/(router|adminRouter)\.(get|post|patch|put|delete)\(\s*'([^']+)'/g)];
    expect(routes.length).toBeGreaterThan(40);
    for (const [, router, method, route] of routes) {
      const path = '/api/v1' + (router === 'adminRouter' ? '/admin' : '') + route!.replace(/:[A-Za-z]+/g, '000000000000000000000001');
      const response = await request(ctx.app)[method as 'get' | 'post' | 'patch' | 'put' | 'delete'](path);
      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });

  it("does not let an owner read another organization's site", async () => {
    const ownerAAgent = await ctx.signIn('owner-a@example.com');
    const ownerBAgent = await ctx.signIn('owner-b@example.com');
    const own = await ownerAAgent.get(`/api/v1/sites/${siteA._id.toHexString()}`);
    const foreign = await ownerBAgent.get(`/api/v1/sites/${siteA._id.toHexString()}`);
    expect(own.status).toBe(200);
    expect(foreign.status).toBe(404);
  });

  it('blocks staff from owner and admin surfaces', async () => {
    const staffAgent = await ctx.signIn('staff-a@example.com');
    expect((await staffAgent.get('/api/v1/owner/overview')).status).toBe(403);
    expect((await staffAgent.get('/api/v1/admin/overview')).status).toBe(403);
    expect((await staffAgent.get('/api/v1/alerts')).status).toBe(200);
  });

  it('allows a platform admin into the admin console', async () => {
    const adminAgent = await ctx.signIn('admin@example.com');
    const response = await adminAgent.get('/api/v1/admin/overview');
    expect(response.status).toBe(200);
  });

  it('requires a CSRF token for cookie-authenticated browser mutations', async () => {
    const ownerAgent = await ctx.signIn('owner-a@example.com');
    const withoutToken = await ownerAgent
      .post('/api/v1/me/organization')
      .set('origin', 'http://localhost:3000')
      .send({ organizationId: northwind._id.toHexString() });
    expect(withoutToken.status).toBe(403);
    expect(withoutToken.body.error.code).toBe('FORBIDDEN');

    const csrf = await ownerAgent
      .get('/api/v1/csrf')
      .set('origin', 'http://localhost:3000');
    expect(csrf.status).toBe(200);
    const withToken = await ownerAgent
      .post('/api/v1/me/organization')
      .set('origin', 'http://localhost:3000')
      .set('x-csrf-token', csrf.body.token)
      .send({ organizationId: northwind._id.toHexString() });
    expect(withToken.status).toBe(200);
  });

  it('suspended members lose access to assigned sites', async () => {
    const suspendedId = await ctx.createUser('suspended@example.com', 'Suspended');
    const membership = await ctx.createMembership({
      organization: northwind,
      userId: suspendedId,
      role: 'STAFF',
      status: 'SUSPENDED',
    });
    await ctx.assign({
      organization: northwind,
      site: siteA,
      userId: suspendedId,
      membership,
    });
    const agent = await ctx.signIn('suspended@example.com');
    const sites = await agent.get('/api/v1/me/sites');
    expect(sites.status).toBe(200);
    expect(sites.body).toHaveLength(0);
    const clock = await agent
      .post('/api/v1/attendance/events')
      .set('X-Manage-Client', 'native')
      .set('Idempotency-Key', `suspended-${Date.now()}`)
      .send({
        clientEventId: crypto.randomUUID(),
        clientShiftId: crypto.randomUUID(),
        deviceId: 'device-suspended',
        siteId: siteA._id.toHexString(),
        type: 'CLOCK_IN',
        capturedAt: new Date().toISOString(),
      });
    expect(clock.body.outcome).toBe('REJECTED');
  });
});
