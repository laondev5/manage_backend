import request from 'supertest';
import type { MailMessage } from '../../mail.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestAgent, type TestContext } from './harness.js';

describe('staff provisioning and supervisor boundaries', () => {
  const messages: MailMessage[] = [];
  let ctx: TestContext; let owner: TestAgent; let supervisor: TestAgent;
  let orgId: string; let siteId: string; let supervisorId: string;
  const mutate = async (agent: TestAgent, method: 'post' | 'patch', path: string, body: object) => {
    const csrf = await agent.get('/api/v1/csrf').set('origin', 'http://localhost:3000');
    return agent[method](path).set('origin', 'http://localhost:3000').set('x-csrf-token', csrf.body.token).send(body);
  };
  beforeAll(async () => {
    ctx = await createTestContext({}, { mailer: { provider: 'local', async send(message) { messages.push(message); return { provider: 'local', providerMessageId: 'test' }; } } });
    const ownerId = await ctx.createUser('provision-owner@example.com');
    supervisorId = await ctx.createUser('supervisor@example.com');
    const org = await ctx.createOrganization('Provisioning', 'provision-owner@example.com'); orgId = org._id.toHexString();
    await ctx.createMembership({ organization: org, userId: ownerId, role: 'SITE_OWNER' });
    const membership = await ctx.createMembership({ organization: org, userId: supervisorId, role: 'SUPERVISOR' });
    const site = await ctx.createSite({ organization: org, name: 'Assigned site', ownerIds: [ownerId], createdBy: ownerId }); siteId = site._id.toHexString();
    await ctx.assign({ organization: org, site, userId: supervisorId, membership });
    owner = await ctx.signIn('provision-owner@example.com'); supervisor = await ctx.signIn('supervisor@example.com');
  });
  afterAll(async () => { await ctx?.close(); });
  it('denies owners creating admins and staff provisioning other accounts', async () => {
    const body = { organizationId: orgId, name: 'New person', email: 'blocked@example.com', phone: '+2348000000000', role: 'PLATFORM_ADMIN' };
    expect((await mutate(owner, 'post', '/api/v1/accounts', body)).status).toBe(403);
    expect((await mutate(supervisor, 'post', '/api/v1/accounts', { ...body, role: 'STAFF' })).status).toBe(403);
    expect(await ctx.c.users.findOne({ email: body.email })).toBeNull();
  });
  it('creates staff directly without returning a session or password', async () => {
    const response = await mutate(owner, 'post', '/api/v1/accounts', { organizationId: orgId, name: 'Created Staff', email: 'created@example.com', phone: '+2348000000001', role: 'STAFF', siteIds: [siteId] });
    expect(response.status).toBe(201); expect(response.body.requiresEmailVerification).toBe(true);
    expect(response.body.password).toBeUndefined(); expect(response.body.token).toBeUndefined();
    expect(await ctx.c.memberships.countDocuments({ userId: response.body.id, role: 'STAFF' })).toBe(1);
    expect(await ctx.c.assignments.countDocuments({ memberId: response.body.id })).toBe(1);
  });
  it('requires replacement and consumes the temporary password only once', async () => {
    const email = 'created@example.com';
    const message = messages.find((m) => m.to === email && m.idempotencyKey.startsWith('account-password:'));
    const password = message?.text.match(/Temporary password: (\S+)/)?.[1];
    expect(Boolean(password)).toBe(true);
    await ctx.c.users.updateOne({ email }, { $set: { emailVerified: true } });
    const agent = request.agent(ctx.app);
    expect((await agent.post('/api/auth/sign-in/email').set('origin', 'http://localhost:3000').send({ email, password })).status).toBe(200);
    expect((await agent.get('/api/v1/me')).body.mustChangePassword).toBe(true);
    expect((await agent.get('/api/v1/sites')).status).toBe(403);
    const repeated = await request(ctx.app).post('/api/auth/sign-in/email').set('origin', 'http://localhost:3000').send({ email, password });
    expect(repeated.status).not.toBe(200);
    expect((await mutate(agent, 'post', '/api/v1/me/initial-password', { currentPassword: password, newPassword: 'ChangedPassword!2026' })).status).toBe(200);
    expect((await agent.get('/api/v1/me')).body.mustChangePassword).toBe(false);
    expect((await agent.get('/api/v1/sites')).status).toBe(200);
    expect((await mutate(agent, 'post', '/api/v1/me/initial-password', { currentPassword: 'ChangedPassword!2026', newPassword: 'AnotherPassword!2026' })).status).toBe(409);
  });
  it('admin-created owners receive the same temporary password and MFA requirement', async () => {
    const adminId = await ctx.createUser('provision-admin@example.com');
    const org = await ctx.c.organizations.findOne({ name: 'Provisioning' });
    await ctx.createMembership({ organization: org!, userId: adminId, role: 'PLATFORM_ADMIN' });
    const admin = await ctx.signIn('provision-admin@example.com');
    const email = 'new-owner@example.com';
    const created = await mutate(admin, 'post', '/api/v1/accounts', { organizationId: orgId, name: 'New owner', email, phone: '+2348000000002', role: 'SITE_OWNER' });
    expect(created.status).toBe(201);
    const password = messages.find((m) => m.to === email && m.idempotencyKey.startsWith('account-password:'))?.text.match(/Temporary password: (\S+)/)?.[1];
    expect(Boolean(password)).toBe(true);
    await ctx.c.users.updateOne({ email }, { $set: { emailVerified: true } });
    const agent = request.agent(ctx.app);
    expect((await agent.post('/api/auth/sign-in/email').set('origin', 'http://localhost:3000').send({ email, password })).status).toBe(200);
    expect((await mutate(agent, 'post', '/api/v1/me/initial-password', { currentPassword: password, newPassword: 'OwnerPassword!2026' })).status).toBe(200);
    expect((await agent.get('/api/v1/me')).body.mfaSetupRequired).toBe(true);
    expect((await agent.get('/api/v1/team')).status).toBe(403);
  });
  it('requires explicit permission, allows only coordinates, and rechecks revoked permissions', async () => {
    const path = `/api/v1/sites/${siteId}`;
    expect((await mutate(supervisor, 'patch', path, { latitude: 6.4, longitude: 3.4, version: 1 })).status).toBe(404);
    await ctx.c.memberships.updateOne({ userId: supervisorId }, { $set: { canUpdateSiteLocation: true } });
    expect((await mutate(supervisor, 'patch', path, { name: 'Not allowed', version: 1 })).status).toBe(404);
    expect((await mutate(supervisor, 'patch', path, { latitude: 6.4, longitude: 3.4, version: 1 })).status).toBe(200);
    expect((await mutate(supervisor, 'patch', path, { latitude: 6.5, longitude: 3.5, version: 1 })).status).toBe(409);
    await ctx.c.memberships.updateOne({ userId: supervisorId }, { $set: { canUpdateSiteLocation: false } });
    expect((await mutate(supervisor, 'patch', path, { latitude: 6.5, longitude: 3.5, version: 2 })).status).toBe(404);
    expect((await supervisor.get('/api/v1/activity')).status).toBe(403);
  });
});
