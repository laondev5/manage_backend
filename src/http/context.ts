import type { NextFunction, Request, Response } from 'express';
import { ObjectId } from 'mongodb';
import { ZodError, type ZodType } from 'zod';
import {
  AppError,
  validationError,
  type Capability,
  type Role,
} from '../contracts/index.js';
import { capabilitiesFor, requiresMfa, type ScopedActor } from '../domain/index.js';
import {
  getUserContext,
  type Database,
  type UserContextRecord,
} from '../database/index.js';
import { fromNodeHeaders } from 'better-auth/node';
import type { Auth } from '../auth.js';

export type AuthContext = {
  sessionId: string;
  sessionCreatedAt: Date;
  sessionExpiresAt: Date;
  user: {
    id: string;
    name: string;
    email: string;
    emailVerified: boolean;
    twoFactorEnabled: boolean;
  };
  context: UserContextRecord;
  capabilities: Capability[];
  actor: ScopedActor;
  roles: Role[];
  activeOrganizationId: string | null;
  mfaSetupRequired: boolean;
  mfaBlocked: boolean;
};

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      auth?: AuthContext;
      rawBody?: Buffer;
    }
  }
}

export type AppDeps = {
  db: Database;
  auth: Auth;
  env: import('../env.js').Env;
  mailer: import('../mail.js').Mailer;
};

export const asyncHandler =
  (handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    handler(req, res, next).catch(next);
  };

export function parseBody<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw zodToValidationError(result.error);
  return result.data;
}

export function parseQuery<T>(schema: ZodType<T>, value: unknown): T {
  return parseBody(schema, value);
}

export function zodToValidationError(error: ZodError): AppError {
  const fields: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.length ? issue.path.join('.') : 'body';
    fields[key] = [...(fields[key] ?? []), issue.message];
  }
  return validationError('Check the highlighted fields and try again.', fields);
}

function buildActor(context: UserContextRecord, capabilities: Capability[]): ScopedActor {
  const activeMemberships = context.memberships.filter(
    (entry) => entry.membership.status === 'ACTIVE' && entry.organization.status === 'ACTIVE',
  );
  const ownerOrgs = [
    ...new Set(
      activeMemberships
        .filter((entry) => entry.membership.role === 'SITE_OWNER')
        .map((entry) => entry.organization._id.toHexString()),
    ),
  ];
  const staffOrgs = [
    ...new Set(
      activeMemberships
        .filter((entry) => ['STAFF', 'SUPERVISOR'].includes(entry.membership.role))
        .map((entry) => entry.organization._id.toHexString()),
    ),
  ];
  const adminOrgs = new Set(
    activeMemberships
      .filter((entry) => entry.membership.role === 'PLATFORM_ADMIN')
      .map((entry) => entry.organization._id.toHexString()),
  );
  for (const grant of context.grants) adminOrgs.add(grant.organizationId.toHexString());
  return {
    userId: context.userId,
    capabilities,
    organizationIds: [...new Set(activeMemberships.map((entry) => entry.organization._id.toHexString()))],
    ownedOrganizationIds: ownerOrgs,
    staffOrganizationIds: staffOrgs,
    adminOrganizationIds: [...adminOrgs],
    ownedSiteIds: context.ownedSites.map((site) => site._id.toHexString()),
    assignedSiteIds: context.assignedSites.map((entry) => entry.site._id.toHexString()),
  };
}

function resolveActiveOrganization(
  context: UserContextRecord,
  requested: string | undefined,
): string | null {
  const activeOrganizations = new Set(
    context.memberships
      .filter((entry) => entry.membership.status === 'ACTIVE' && entry.organization.status === 'ACTIVE')
      .map((entry) => entry.organization._id.toHexString()),
  );
  for (const grant of context.grants) activeOrganizations.add(grant.organizationId.toHexString());
  if (requested) {
    if (!activeOrganizations.has(requested)) {
      throw new AppError(403, 'FORBIDDEN', 'You do not have an active membership in that organization.');
    }
    return requested;
  }
  return activeOrganizations.values().next().value ?? null;
}

export function requireAuth(deps: AppDeps) {
  return asyncHandler(async (req, _res, next) => {
    const session = await deps.auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    if (!session) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue.');

    const context = await getUserContext(deps.db.c, session.user.id);
    if (context.user.mustChangePassword && !['/me', '/csrf', '/me/initial-password'].includes(req.path)) {
      throw new AppError(403, 'FORBIDDEN', 'Change your temporary password before using Manage.');
    }
    // Disabled accounts are re-gated on every request, not only at sign-in.
    const userDoc = await deps.db.c.users.findOne(
      {
        $or: [
          { _id: session.user.id },
          ...(ObjectId.isValid(session.user.id) ? [{ _id: new ObjectId(session.user.id) }] : []),
        ],
      },
      { projection: { status: 1, deletedAt: 1 } },
    );
    if (userDoc?.deletedAt) {
      throw new AppError(403, 'FORBIDDEN', 'This account was deleted. Contact an administrator.');
    }
    if (userDoc?.status === 'DISABLED') {
      throw new AppError(403, 'FORBIDDEN', 'This account has been deactivated. Contact an administrator.');
    }
    const grants = context.grants.map((grant) => grant.capability);
    const activeMemberships = context.memberships.filter(
      (entry) => entry.membership.status === 'ACTIVE' && entry.organization.status === 'ACTIVE',
    );
    const roles = [...new Set(activeMemberships.map((entry) => entry.membership.role))];
    const capabilities = capabilitiesFor(
      activeMemberships.map((entry) => entry.membership),
      grants,
    );
    const twoFactorEnabled = Boolean(
      (session.user as { twoFactorEnabled?: boolean | null }).twoFactorEnabled,
    );
    const activeOrganizationId = resolveActiveOrganization(
      context,
      typeof req.headers['x-organization-id'] === 'string'
        ? req.headers['x-organization-id']
        : undefined,
    );
    const actor = buildActor(context, capabilities);
    const mfaSetupRequired = requiresMfa(roles) && !twoFactorEnabled;
    req.auth = {
      sessionId: session.session.id,
      sessionCreatedAt: session.session.createdAt,
      sessionExpiresAt: session.session.expiresAt,
      user: {
        id: session.user.id,
        name: session.user.name,
        email: session.user.email,
        emailVerified: session.user.emailVerified,
        twoFactorEnabled,
      },
      context,
      capabilities,
      actor,
      roles,
      activeOrganizationId,
      mfaSetupRequired,
      mfaBlocked: mfaSetupRequired,
    };
    next();
  });
}

export const authOf = (req: Request): AuthContext => {
  if (!req.auth) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
  return req.auth;
};

export function requireMfaComplete(req: Request) {
  const auth = authOf(req);
  if (auth.mfaBlocked) {
    throw new AppError(403, 'MFA_REQUIRED', 'Set up authenticator MFA before using this feature.');
  }
}

export function requireVerifiedEmail(req: Request, _res: Response, next: NextFunction) {
  const auth = authOf(req);
  if (!auth.user.emailVerified) {
    return next(new AppError(403, 'FORBIDDEN', 'Verify your email address before continuing.'));
  }
  return next();
}

export function requireCapability(req: Request, capability: Capability) {
  const auth = authOf(req);
  if (!auth.capabilities.includes(capability)) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have access to this action.');
  }
}

export function requireAdmin(req: Request) {
  requireMfaComplete(req);
  const auth = authOf(req);
  if (!auth.roles.includes('PLATFORM_ADMIN')) {
    throw new AppError(403, 'FORBIDDEN', 'Platform administrator access is required.');
  }
}

export function requireOrganization(req: Request, organizationId: string) {
  const auth = authOf(req);
  if (!auth.actor.organizationIds.includes(organizationId) && !auth.actor.adminOrganizationIds.includes(organizationId)) {
    throw new AppError(404, 'NOT_FOUND', 'Resource not found.');
  }
  return auth;
}

export function requireRecentAuth(req: Request, minutes = 15) {
  const auth = authOf(req);
  const ageMinutes = (Date.now() - auth.sessionCreatedAt.getTime()) / 60000;
  if (ageMinutes > minutes) {
    throw new AppError(
      403,
      'FORBIDDEN',
      'Sign in again before performing this sensitive action.',
    );
  }
}
