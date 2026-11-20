import { ObjectId } from 'mongodb';
import { randomBytes } from 'node:crypto';
import { conflict, forbidden, notFound, type AccountCreateInput } from '../contracts/index.js';
import { appendAudit, createAssignment, createMembership, usersByIds, withTransaction } from '../database/index.js';
import type { AppDeps, AuthContext } from '../http/context.js';

/** Authenticated provisioning only; public sign-up remains blocked. */
export async function createAccount(deps: AppDeps, auth: AuthContext, input: AccountCreateInput, requestId: string) {
  const admin = auth.roles.includes('PLATFORM_ADMIN');
  if (!admin && (!auth.actor.ownedOrganizationIds.includes(input.organizationId) ||
      !['STAFF', 'SUPERVISOR'].includes(input.role))) throw forbidden('You can only create staff for your own organization.');
  if (auth.mfaBlocked) throw forbidden('Complete MFA setup before managing accounts.');
  const organizationId = new ObjectId(input.organizationId);
  const organization = await deps.db.c.organizations.findOne({ _id: organizationId, status: 'ACTIVE', deletedAt: null });
  if (!organization) throw notFound('Organization not found.');
  const siteIds = [...new Set(input.siteIds)];
  if (!admin && siteIds.some((id) => !auth.actor.ownedSiteIds.includes(id))) throw forbidden('Choose sites you manage.');
  const sites = await deps.db.c.sites.find({ _id: { $in: siteIds.map((id) => new ObjectId(id)) }, organizationId, status: 'ACTIVE', deletedAt: null }).toArray();
  if (sites.length !== siteIds.length) throw notFound('One or more sites are unavailable.');
  if (await deps.db.c.users.findOne({ email: input.email })) throw conflict('An account already exists for this email.');

  // Better Auth owns credential hashing and email verification. Never return its session token.
  const temporaryPassword = randomBytes(18).toString('base64url');
  const created = await deps.auth.api.signUpEmail({ body: {
    name: input.name, email: input.email, password: temporaryPassword,
    callbackURL: `${deps.env.trustedWebOrigins[0]}/sign-in`,
  } });
  const userId = created.user.id;
  await deps.db.db.collection('session').deleteMany({ userId });
  try {
    await withTransaction(deps.db, async (session) => {
  // Keep provisioning failures unable to act until a complete membership exists.
  await deps.db.c.users.updateOne({ email: input.email }, { $set: {
    phone: input.phone, mustChangePassword: true,
    temporaryPasswordExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  } }, { session });
  const membership = await createMembership(deps.db.c, { organizationId, userId, role: input.role }, session);
  await deps.db.c.memberships.updateOne({ _id: membership._id }, { $set: {
    canUpdateSiteLocation: input.role === 'SUPERVISOR' && input.canUpdateSiteLocation,
  } }, { session });
  for (const site of sites) {
    await createAssignment(deps.db.c, {
      siteId: site._id, organizationId, memberId: userId, membershipId: membership._id,
      permissionScope: 'CLOCK_AND_HISTORY', createdBy: auth.user.id,
    }, session);
  }
  await appendAudit(deps.db.c, {
    actorId: auth.user.id, actorName: auth.user.name, actorRole: auth.roles[0] ?? null,
    action: 'account.created', targetType: 'user', targetId: userId, organizationId,
    siteId: null, requestId, summary: 'Created an account.',
    meta: { role: input.role, siteIds },
  }, session);
    });
  } catch (error) {
    // Auth creation is outside this transaction. Fail closed if provisioning cannot complete.
    await deps.db.c.users.updateOne({ email: input.email }, { $set: { status: 'DISABLED', disabledReason: 'Account provisioning did not complete.' } });
    await deps.db.db.collection('session').deleteMany({ userId });
    throw error;
  }
  try {
    await deps.mailer.send({
      to: input.email, idempotencyKey: `account-password:${userId}`,
      subject: 'Your Manage account — temporary password',
      text: `Your Manage account has been created.\n\nTemporary password: ${temporaryPassword}\n\nVerify your email using the separate verification email, then sign in to Manage and choose a new password. This temporary password expires in 24 hours and cannot be reused after replacement. If it expires, use Forgot password.`,
      html: `<p>Your Manage account has been created.</p><p>Temporary password: <strong>${temporaryPassword}</strong></p><p>Verify your email using the separate verification email, then sign in and choose a new password. This password expires in 24 hours and cannot be reused after replacement. If it expires, use Forgot password.</p>`,
    });
  } catch {
    // Never report delivery success or expose the password in the response/log.
    throw conflict('Account created, but the temporary-password email failed. Use Forgot password to request a secure reset.');
  }
  return { id: userId, requiresEmailVerification: true, requiresPasswordChange: true, emailProvider: deps.mailer.provider };
}

export async function updateAccountProfile(deps: AppDeps, auth: AuthContext, userId: string,
  input: { name: string; email: string; phone: string }, requestId: string) {
  if (!auth.roles.includes('PLATFORM_ADMIN') || auth.mfaBlocked) throw forbidden('Administrator access is required.');
  const user = (await usersByIds(deps.db.c, [userId])).get(userId);
  if (!user || user.deletedAt) throw notFound('Account not found.');
  const changedEmail = user.email !== input.email;
  if (changedEmail && await deps.db.c.users.findOne({ email: input.email })) throw conflict('Email is already in use.');
  await withTransaction(deps.db, async (session) => {
    await deps.db.c.users.updateOne({ _id: user._id }, { $set: { ...input, updatedAt: new Date(), ...(changedEmail ? { emailVerified: false } : {}) } }, { session });
    if (changedEmail) await deps.db.db.collection('session').deleteMany({ userId }, { session });
    await appendAudit(deps.db.c, { actorId: auth.user.id, actorName: auth.user.name, actorRole: 'PLATFORM_ADMIN',
      action: 'account.updated', targetType: 'user', targetId: userId, requestId,
      summary: 'Updated account profile.', meta: { emailChanged: changedEmail } }, session);
  });
  if (changedEmail) await deps.auth.api.sendVerificationEmail({ body: { email: input.email, callbackURL: `${deps.env.trustedWebOrigins[0]}/sign-in` } });
  return { ok: true, requiresEmailVerification: changedEmail };
}
