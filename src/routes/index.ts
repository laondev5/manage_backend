import { fromNodeHeaders } from 'better-auth/node';
import { activityHistory } from '../services/activity.js';
import { createAccount, updateAccountProfile } from '../services/accounts.js';
import { accountCreateSchema, staffProfileUpdateSchema, accountProfileSchema, initialPasswordSchema } from '../contracts/accounts.js';
import { updateStaffProfile } from '../services/team.js';
import { Router, type Request } from 'express';
import type { Logger } from 'pino';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import {
  AppError,
  accessGrantCreateSchema,
  adminInviteSchema,
  adminMemberInviteSchema,
  adminUserDeleteSchema,
  adminUserReactivateSchema,
  alertReviewSchema,
  assignmentCreateSchema,
  assignmentRemoveSchema,
  attendanceEventInputSchema,
  correctionCreateSchema,
  correctionDecisionSchema,
  deviceRegistrationSchema,
  exportRequestSchema,
  invitationAcceptSchema,
  isoDateTimeSchema,
  memberQuerySchema,
  memberRemovalSchema,
  memberStatusUpdateSchema,
  membershipUpdateSchema,
  objectIdSchema,
  observationInputSchema,
  onboardingUpdateSchema,
  organizationCreateSchema,
  organizationDeleteSchema,
  organizationUpdateSchema,
  ownerInsightsQuerySchema,
  platformSiteUpdateSchema,
  reportCreateSchema,
  reportUpdateSchema,
  retryOutboxSchema,
  siteCreateSchema,
  siteInspectorUpdateSchema,
  siteLifecycleSchema,
  siteReviewCreateSchema,
  siteReviewUpdateSchema,
  siteUpdateSchema,
  switchOrganizationSchema,
  syncBatchSchema,
  teamLeadUpdateSchema,
  timezoneSchema,
  validationError,
} from '../contracts/index.js';
import { sha256, withIdempotency, type DeviceDoc } from '../database/index.js';
import {
  asyncHandler,
  authOf,
  parseBody,
  parseQuery,
  requireAdmin,
  requireAuth,
  requireCapability,
  requireMfaComplete,
  requireRecentAuth,
  requireVerifiedEmail,
  type AppDeps,
} from '../http/context.js';
import { csrfProtection, csrfRoute } from '../http/csrf.js';
import { limiter, userOrIp } from '../http/limiter.js';
import { buildInternalRouter } from './internal.js';
import { adminExport, adminTimesheets } from '../services/admin.js';
import * as admin from '../services/admin.js';
import { getAlert, listMyAlerts, reviewAlertAsOwner } from '../services/alerts.js';
import {
  currentShift,
  processAttendanceEvent,
  shiftDetail,
  shiftHistory,
  type ClockResult,
} from '../services/attendance.js';
import {
  correctionDetail,
  decideCorrectionRequest,
  myCorrections,
  ownerCorrections,
  requestCorrection,
} from '../services/corrections.js';
import {
  meResponse,
  onboardingState,
  switchOrganization,
  updateOnboarding,
} from '../services/me.js';
import { exportTimesheets, ownerInsights, ownerOverview, siteLive, timesheets } from '../services/owner.js';
import { ingestObservation } from '../services/presence.js';
import {
  createReport,
  deleteReport,
  getReport,
  listReports,
  updateReport,
} from '../services/reports.js';
import {
  createSiteReview,
  deleteSiteReview,
  listSiteReviews,
  updateSiteReview,
} from '../services/reviews.js';
import {
  acceptInvitationWorkflow,
  acceptSiteAssignment,
  addAssignment,
  changeSiteLifecycle,
  createOwnerSite,
  getSite,
  invitationPreview,
  inviteStaff,
  inviteTeamMember,
  listSiteInvitations,
  listSites,
  listTeamInvitations,
  lookupInvitation,
  orgMemberLookup,
  removeAssignment,
  revokeSiteInvitation,
  revokeTeamInvitation,
  setSiteInspector,
  setSiteTeamLead,
  siteRoster,
  staffAssignedSites,
  updateOwnerSite,
} from '../services/sites.js';
import {
  queryTeamMember,
  removeTeamMember,
  setTeamMemberStatus,
  teamMemberDetail,
  teamMembers,
} from '../services/team.js';

const objectId = (value: string, field = 'id') => {
  const parsed = objectIdSchema.safeParse(value);
  if (!parsed.success) {
    throw validationError('The identifier in the URL is not valid.', { [field]: ['Invalid id.'] });
  }
  return new ObjectId(parsed.data);
};

const param = (req: Request, name: string) => {
  const raw = req.params[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) throw validationError('The identifier in the URL is missing.');
  return value;
};

const mfaGate = (req: Request, _res: unknown, next: (error?: unknown) => void) => {
  try {
    requireMfaComplete(req);
    next();
  } catch (error) {
    next(error);
  }
};

const historyQuerySchema = z.object({
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const timesheetQuerySchema = z.object({
  siteId: objectIdSchema.optional(),
  from: isoDateTimeSchema,
  to: isoDateTimeSchema,
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const inviteSchema = z.strictObject({
  email: z.email(),
  note: z.string().trim().max(300).optional(),
});

const teamInviteSchema = z.strictObject({
  email: z.email(),
  note: z.string().trim().max(300).optional(),
  siteId: objectIdSchema.optional(),
});

const deviceSummary = (doc: DeviceDoc) => ({
  id: doc._id.toHexString(),
  deviceId: doc.deviceId,
  platform: doc.platform,
  appVersion: doc.appVersion,
  pushEnabled: doc.pushEnabled,
  lastSeenAt: doc.lastSeenAt.toISOString(),
  createdAt: doc.createdAt.toISOString(),
  revokedAt: doc.revokedAt?.toISOString() ?? null,
});

export function buildApiRouter(deps: AppDeps, logger: Logger): Router {
  const router = Router();

  const acceptLimit = limiter(deps, {
    windowMs: 60 * 60 * 1000,
    limit: 10,
    prefix: 'invite-accept:',
  });
  const previewLimit = limiter(deps, { windowMs: 60 * 1000, limit: 60, prefix: 'invite-preview:' });

  router.get(
    '/invitations/:token',
    previewLimit,
    asyncHandler(async (req, res) => {
      const { invitation, site, organizationName } = await lookupInvitation(
        deps.db,
        param(req, 'token'),
      );
      res.json(invitationPreview(invitation, site, organizationName));
    }),
  );

  router.post(
    '/invitations/accept',
    acceptLimit,
    asyncHandler(async (req, res) => {
      const input = parseBody(invitationAcceptSchema, req.body);
      const { invitation } = await lookupInvitation(deps.db, input.token);
      if (invitation.status !== 'PENDING' || invitation.expiresAt.getTime() <= Date.now()) {
        throw new AppError(
          410,
          'INVITATION_EXPIRED',
          'This invitation has expired or was already used. Ask for a new one.',
        );
      }
      const existing = await deps.db.c.users.findOne({ email: invitation.email });
      if (existing) {
        throw new AppError(
          409,
          'INVITATION_INVALID',
          'An account already exists for this email. Sign in instead of creating a new account.',
        );
      }
      let created;
      try {
        created = await deps.auth.api.signUpEmail({
          body: {
            email: invitation.email,
            password: input.password,
            name: input.name,
            callbackURL: `${deps.env.trustedWebOrigins[0] ?? 'http://localhost:3000'}/sign-in`,
          },
        });
      } catch {
        throw new AppError(
          422,
          'VALIDATION_ERROR',
          'The account could not be created. Check the password requirements and try again.',
        );
      }
      const userId = created.user.id;
      await deps.db.db.collection('session').deleteMany({ userId });
      const result = await acceptInvitationWorkflow(
        deps.db,
        { token: input.token, name: input.name, password: input.password, userId },
        { requestId: req.requestId },
      );
      res.status(201).json({
        ok: true,
        email: invitation.email,
        siteName: result.siteName,
        requiresEmailVerification: true,
      });
    }),
  );

  router.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'manage-api' });
  });

  router.use('/internal', buildInternalRouter(deps, logger));

  router.use(requireAuth(deps));
  router.use(csrfProtection(deps.env));
  router.use(requireVerifiedEmail);

  router.get('/csrf', csrfRoute(deps.env));
  router.post('/me/initial-password', limiter(deps, { windowMs: 60000, limit: 5, prefix: 'initial-password:', key: userOrIp }), asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const input = parseBody(initialPasswordSchema, req.body);
    const user = auth.context.user;
    const claimed = await deps.db.c.users.findOneAndUpdate({ _id: user._id, mustChangePassword: true,
      initialPasswordChanging: { $ne: true }, temporaryPasswordExpiresAt: { $gt: new Date() },
    }, { $set: { initialPasswordChanging: true } });
    if (!claimed) throw new AppError(409, 'CONFLICT', 'Temporary password expired or already used. Use Forgot password if needed.');
    try {
      await deps.auth.api.changePassword({ headers: fromNodeHeaders(req.headers), body: { ...input, revokeOtherSessions: false } });
      await deps.db.c.users.updateOne({ _id: user._id }, { $set: { mustChangePassword: false, initialPasswordChanging: false, temporaryPasswordExpiresAt: null } });
      await deps.db.db.collection('session').deleteMany({ userId: auth.user.id, token: { $ne: (await deps.auth.api.getSession({ headers: fromNodeHeaders(req.headers) }))?.session.token } });
      res.json({ ok: true });
    } catch (error) {
      await deps.db.c.users.updateOne({ _id: user._id }, { $set: { initialPasswordChanging: false } });
      throw error;
    }
  }));


  router.get(
    '/me',
    asyncHandler(async (req, res) => {
      res.json(meResponse(authOf(req)));
    }),
  );

  router.post(
    '/me/organization',
    asyncHandler(async (req, res) => {
      const input = parseBody(switchOrganizationSchema, req.body);
      res.json(await switchOrganization(deps.db, authOf(req), input.organizationId));
    }),
  );

  router.get(
    '/me/onboarding',
    asyncHandler(async (req, res) => {
      res.json(await onboardingState(deps.db, authOf(req)));
    }),
  );

  router.patch(
    '/me/onboarding',
    asyncHandler(async (req, res) => {
      const input = parseBody(onboardingUpdateSchema, req.body);
      res.json(await updateOnboarding(deps.db, authOf(req), input));
    }),
  );

  router.get(
    '/me/sites',
    asyncHandler(async (req, res) => {
      res.json(await staffAssignedSites(deps.db, authOf(req)));
    }),
  );

  router.post(
    '/devices',
    asyncHandler(async (req, res) => {
      const input = parseBody(deviceRegistrationSchema, req.body);
      const doc = await deps.db.c.devices.findOneAndUpdate(
        { userId: authOf(req).user.id, deviceId: input.deviceId },
        {
          $set: {
            platform: input.platform,
            pushToken: input.pushToken ?? null,
            pushEnabled: input.pushEnabled,
            appVersion: input.appVersion ?? null,
            lastSeenAt: new Date(),
            revokedAt: null,
          },
          $setOnInsert: {
            userId: authOf(req).user.id,
            deviceId: input.deviceId,
            createdAt: new Date(),
          },
        },
        { upsert: true, returnDocument: 'after' },
      );
      if (!doc) throw new AppError(500, 'INTERNAL_ERROR', 'The device could not be registered.');
      res.status(201).json(deviceSummary(doc));
    }),
  );

  router.get(
    '/devices',
    asyncHandler(async (req, res) => {
      const docs = await deps.db.c.devices
        .find({ userId: authOf(req).user.id })
        .sort({ lastSeenAt: -1 })
        .toArray();
      res.json(docs.map(deviceSummary));
    }),
  );

  router.delete(
    '/devices/:deviceId',
    asyncHandler(async (req, res) => {
      await deps.db.c.devices.updateOne(
        { userId: authOf(req).user.id, deviceId: param(req, 'deviceId') },
        { $set: { revokedAt: new Date(), pushEnabled: false, pushToken: null } },
      );
      res.json({ ok: true });
    }),
  );

  router.use(mfaGate);
  router.get('/activity', asyncHandler(async (req, res) => {
    const input = parseQuery(z.strictObject({ siteId: objectIdSchema.optional(), memberId: z.string().min(1).optional(), cursor: objectIdSchema.optional(), limit: z.coerce.number().int().min(1).max(100).default(25) }), req.query);
    res.json(await activityHistory(deps.db, authOf(req), input));
  }));

  router.post('/accounts', limiter(deps, { windowMs: 3600000, limit: 30, prefix: 'account-create:', key: userOrIp }), asyncHandler(async (req, res) => {
    requireRecentAuth(req);
    res.status(201).json(await createAccount(deps, authOf(req), parseBody(accountCreateSchema, req.body), req.requestId));
  }));
  router.patch('/team/:memberId/profile', asyncHandler(async (req, res) => {
    requireCapability(req, 'owner.team');
    const input = parseBody(staffProfileUpdateSchema, req.body);
    const result = await updateStaffProfile(deps.db, authOf(req), param(req, 'memberId'), input, req.requestId);
    if (input.email) await deps.auth.api.sendVerificationEmail({ body: { email: input.email, callbackURL: `${deps.env.trustedWebOrigins[0]}/sign-in` } });
    res.json(result);
  }));

  router.get(
    '/sites',
    asyncHandler(async (req, res) => {
      const query = parseQuery(
        z.object({ scope: z.enum(['current', 'previous']).default('current') }),
        req.query,
      );
      res.json(await listSites(deps.db, authOf(req), query.scope));
    }),
  );

  router.post(
    '/sites',
    limiter(deps, { windowMs: 60 * 60 * 1000, limit: 30, prefix: 'site-create:', key: userOrIp }),
    asyncHandler(async (req, res) => {
      if (!authOf(req).roles.includes('PLATFORM_ADMIN')) requireCapability(req, 'owner.sites');
      const input = parseBody(siteCreateSchema, req.body);
      res.status(201).json(await createOwnerSite(deps.db, authOf(req), input, req.requestId));
    }),
  );

  router.get(
    '/sites/:siteId',
    asyncHandler(async (req, res) => {
      res.json(await getSite(deps.db, authOf(req), objectId(param(req, 'siteId'), 'siteId')));
    }),
  );

  router.patch(
    '/sites/:siteId',
    asyncHandler(async (req, res) => {
      const input = parseBody(siteUpdateSchema, req.body);
      res.json(
        await updateOwnerSite(deps.db, authOf(req), objectId(param(req, 'siteId'), 'siteId'), input, req.requestId),
      );
    }),
  );

  router.get(
    '/sites/:siteId/roster',
    asyncHandler(async (req, res) => {
      res.json(await siteRoster(deps.db, authOf(req), objectId(param(req, 'siteId'), 'siteId')));
    }),
  );

  router.get(
    '/sites/:siteId/reviews',
    asyncHandler(async (req, res) => {
      res.json(
        await listSiteReviews(deps.db, authOf(req), objectId(param(req, 'siteId'), 'siteId')),
      );
    }),
  );

  router.post(
    '/sites/:siteId/reviews',
    limiter(deps, { windowMs: 60 * 60 * 1000, limit: 20, prefix: 'review-create:', key: userOrIp }),
    asyncHandler(async (req, res) => {
      const input = parseBody(siteReviewCreateSchema, req.body);
      res.status(201).json(
        await createSiteReview(
          deps.db,
          authOf(req),
          objectId(param(req, 'siteId'), 'siteId'),
          input,
          req.requestId,
        ),
      );
    }),
  );

  router.patch(
    '/sites/:siteId/reviews/:reviewId',
    asyncHandler(async (req, res) => {
      const input = parseBody(siteReviewUpdateSchema, req.body);
      res.json(
        await updateSiteReview(
          deps.db,
          authOf(req),
          objectId(param(req, 'siteId'), 'siteId'),
          objectId(param(req, 'reviewId'), 'reviewId'),
          input,
        ),
      );
    }),
  );

  router.delete(
    '/sites/:siteId/reviews/:reviewId',
    asyncHandler(async (req, res) => {
      res.json(
        await deleteSiteReview(
          deps.db,
          authOf(req),
          objectId(param(req, 'siteId'), 'siteId'),
          objectId(param(req, 'reviewId'), 'reviewId'),
        ),
      );
    }),
  );

  router.post(
    '/sites/:siteId/team-lead',
    asyncHandler(async (req, res) => {
      if (!authOf(req).roles.includes('PLATFORM_ADMIN')) requireCapability(req, 'owner.sites');
      const input = parseBody(teamLeadUpdateSchema, req.body);
      res.json(
        await setSiteTeamLead(
          deps.db,
          authOf(req),
          objectId(param(req, 'siteId'), 'siteId'),
          input,
          req.requestId,
        ),
      );
    }),
  );

  router.post(
    '/sites/:siteId/inspector',
    asyncHandler(async (req, res) => {
      if (!authOf(req).roles.includes('PLATFORM_ADMIN')) requireCapability(req, 'owner.sites');
      const input = parseBody(siteInspectorUpdateSchema, req.body);
      res.json(
        await setSiteInspector(
          deps.db,
          authOf(req),
          objectId(param(req, 'siteId'), 'siteId'),
          input,
          req.requestId,
        ),
      );
    }),
  );

  router.get(
    '/reports',
    asyncHandler(async (req, res) => {
      const query = parseQuery(
        z.object({ scope: z.enum(['mine', 'team']).default('mine') }),
        req.query,
      );
      res.json(await listReports(deps.db, authOf(req), query.scope));
    }),
  );

  router.post(
    '/reports',
    limiter(deps, { windowMs: 60 * 60 * 1000, limit: 60, prefix: 'report-create:', key: userOrIp }),
    asyncHandler(async (req, res) => {
      const input = parseBody(reportCreateSchema, req.body);
      res.status(201).json(await createReport(deps.db, authOf(req), input, req.requestId));
    }),
  );

  router.get(
    '/reports/:reportId',
    asyncHandler(async (req, res) => {
      res.json(
        await getReport(deps.db, authOf(req), objectId(param(req, 'reportId'), 'reportId')),
      );
    }),
  );

  router.patch(
    '/reports/:reportId',
    asyncHandler(async (req, res) => {
      const input = parseBody(reportUpdateSchema, req.body);
      res.json(
        await updateReport(
          deps.db,
          authOf(req),
          objectId(param(req, 'reportId'), 'reportId'),
          input,
          req.requestId,
        ),
      );
    }),
  );

  router.delete(
    '/reports/:reportId',
    asyncHandler(async (req, res) => {
      res.json(
        await deleteReport(
          deps.db,
          authOf(req),
          objectId(param(req, 'reportId'), 'reportId'),
          req.requestId,
        ),
      );
    }),
  );

  router.post(
    '/sites/:siteId/lifecycle',
    limiter(deps, { windowMs: 60 * 60 * 1000, limit: 30, prefix: 'site-lifecycle:', key: userOrIp }),
    asyncHandler(async (req, res) => {
      if (!authOf(req).roles.includes('PLATFORM_ADMIN')) requireCapability(req, 'owner.sites');
      const input = parseBody(siteLifecycleSchema, req.body);
      res.json(
        await changeSiteLifecycle(
          deps.db,
          authOf(req),
          objectId(param(req, 'siteId'), 'siteId'),
          input,
          req.requestId,
        ),
      );
    }),
  );

  router.get(
    '/sites/:siteId/member-candidates',
    asyncHandler(async (req, res) => {
      const site = await getSite(deps.db, authOf(req), objectId(param(req, 'siteId'), 'siteId'));
      const query = typeof req.query.q === 'string' ? req.query.q : '';
      res.json(await orgMemberLookup(deps.db, new ObjectId(site.organizationId), query));
    }),
  );

  router.post(
    '/sites/:siteId/assignments',
    asyncHandler(async (req, res) => {
      const input = parseBody(assignmentCreateSchema, req.body);
      res.status(201).json(
        await addAssignment(
          deps.db,
          authOf(req),
          objectId(param(req, 'siteId'), 'siteId'),
          input,
          req.requestId,
        ),
      );
    }),
  );

  router.post(
    '/sites/:siteId/assignments/accept',
    asyncHandler(async (req, res) => {
      res.json(
        await acceptSiteAssignment(
          deps.db,
          authOf(req),
          objectId(param(req, 'siteId'), 'siteId'),
          req.requestId,
        ),
      );
    }),
  );

  router.delete(
    '/sites/:siteId/assignments/:assignmentId',
    asyncHandler(async (req, res) => {
      if (!authOf(req).roles.includes('PLATFORM_ADMIN')) requireCapability(req, 'owner.team');
      const input = parseBody(assignmentRemoveSchema, req.body ?? {});
      res.json(
        await removeAssignment(
          deps.db,
          authOf(req),
          objectId(param(req, 'siteId'), 'siteId'),
          objectId(param(req, 'assignmentId'), 'assignmentId'),
          input,
          req.requestId,
        ),
      );
    }),
  );

  router.get(
    '/sites/:siteId/invitations',
    asyncHandler(async (req, res) => {
      res.json(await listSiteInvitations(deps.db, authOf(req), objectId(param(req, 'siteId'), 'siteId')));
    }),
  );

  router.post(
    '/sites/:siteId/invitations',
    limiter(deps, { windowMs: 60 * 60 * 1000, limit: 30, prefix: 'invite-create:', key: userOrIp }),
    asyncHandler(async (req, res) => {
      requireCapability(req, 'owner.team');
      const input = parseBody(inviteSchema, req.body);
      const result = await inviteStaff(
        deps.db,
        authOf(req),
        objectId(param(req, 'siteId'), 'siteId'),
        input,
        {
          requestId: req.requestId,
          webUrl: deps.env.trustedWebOrigins[0] ?? 'http://localhost:3000',
          allowDevToken: !deps.env.isProduction || deps.env.ENABLE_DEV_TOKENS,
          sendMail: (message) => deps.mailer.send(message),
          inviterName: authOf(req).user.name,
        },
      );
      res.status(201).json({
        invitation: result.invitation,
        developmentToken: result.developmentToken,
      });
    }),
  );

  router.delete(
    '/sites/:siteId/invitations/:invitationId',
    asyncHandler(async (req, res) => {
      requireCapability(req, 'owner.team');
      res.json(
        await revokeSiteInvitation(
          deps.db,
          authOf(req),
          objectId(param(req, 'siteId'), 'siteId'),
          objectId(param(req, 'invitationId'), 'invitationId'),
        ),
      );
    }),
  );

  router.get(
    '/team',
    asyncHandler(async (req, res) => {
      requireCapability(req, 'owner.team');
      res.json(await teamMembers(deps.db, authOf(req)));
    }),
  );

  router.get(
    '/team/invitations',
    asyncHandler(async (req, res) => {
      requireCapability(req, 'owner.team');
      res.json(await listTeamInvitations(deps.db, authOf(req)));
    }),
  );

  router.post(
    '/team/invitations',
    limiter(deps, { windowMs: 60 * 60 * 1000, limit: 30, prefix: 'invite-create:', key: userOrIp }),
    asyncHandler(async (req, res) => {
      requireCapability(req, 'owner.team');
      const input = parseBody(teamInviteSchema, req.body);
      const result = await inviteTeamMember(deps.db, authOf(req), input, {
        requestId: req.requestId,
        webUrl: deps.env.trustedWebOrigins[0] ?? 'http://localhost:3000',
        allowDevToken: !deps.env.isProduction || deps.env.ENABLE_DEV_TOKENS,
        sendMail: (message) => deps.mailer.send(message),
        inviterName: authOf(req).user.name,
      });
      res.status(201).json({
        invitation: result.invitation,
        developmentToken: result.developmentToken,
      });
    }),
  );

  router.delete(
    '/team/invitations/:invitationId',
    asyncHandler(async (req, res) => {
      requireCapability(req, 'owner.team');
      res.json(
        await revokeTeamInvitation(
          deps.db,
          authOf(req),
          objectId(param(req, 'invitationId'), 'invitationId'),
        ),
      );
    }),
  );

  router.get(
    '/team/:memberId',
    asyncHandler(async (req, res) => {
      requireCapability(req, 'owner.team');
      res.json(await teamMemberDetail(deps.db, authOf(req), param(req, 'memberId')));
    }),
  );

  router.patch(
    '/team/:memberId/status',
    asyncHandler(async (req, res) => {
      requireCapability(req, 'owner.team');
      const input = parseBody(memberStatusUpdateSchema, req.body);
      res.json(
        await setTeamMemberStatus(deps.db, authOf(req), param(req, 'memberId'), input, req.requestId),
      );
    }),
  );

  router.delete(
    '/team/:memberId',
    asyncHandler(async (req, res) => {
      requireCapability(req, 'owner.team');
      const input = parseBody(memberRemovalSchema, req.body);
      res.json(
        await removeTeamMember(deps.db, authOf(req), param(req, 'memberId'), input, req.requestId),
      );
    }),
  );

  router.post(
    '/team/:memberId/query',
    limiter(deps, { windowMs: 60 * 60 * 1000, limit: 60, prefix: 'member-query:', key: userOrIp }),
    asyncHandler(async (req, res) => {
      requireCapability(req, 'owner.team');
      const input = parseBody(memberQuerySchema, req.body);
      res.status(201).json(
        await queryTeamMember(deps.db, authOf(req), param(req, 'memberId'), input, req.requestId),
      );
    }),
  );

  router.get(
    '/shifts/current',
    asyncHandler(async (req, res) => {
      res.json(await currentShift(deps.db, authOf(req)));
    }),
  );

  router.get(
    '/shifts',
    asyncHandler(async (req, res) => {
      const query = parseQuery(historyQuerySchema, req.query);
      const to = query.to ? new Date(query.to) : new Date();
      const from = query.from
        ? new Date(query.from)
        : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
      if (from.getTime() >= to.getTime()) {
        throw validationError('The start of the range must be before the end.', {
          from: ['Use a date before the end.'],
        });
      }
      if (to.getTime() - from.getTime() > 92 * 24 * 60 * 60 * 1000) {
        throw validationError('Choose a history range of at most 92 days.');
      }
      res.json(await shiftHistory(deps.db, authOf(req), { from, to, cursor: query.cursor, limit: query.limit }));
    }),
  );

  router.get(
    '/shifts/:shiftId',
    asyncHandler(async (req, res) => {
      res.json(await shiftDetail(deps.db, authOf(req), objectId(param(req, 'shiftId'), 'shiftId')));
    }),
  );

  router.post(
    '/attendance/events',
    limiter(deps, { windowMs: 60 * 1000, limit: 60, prefix: 'attendance:', key: userOrIp }),
    asyncHandler(async (req, res) => {
      const input = parseBody(attendanceEventInputSchema, req.body);
      const header = req.header('idempotency-key');
      const key = header?.trim() || `attendance:${input.clientEventId}`;
      if (key.length > 200) throw validationError('The Idempotency-Key header is too long.');
      const requestHash = sha256(JSON.stringify(input));
      const result = await withIdempotency(
        deps.db.c,
        {
          actorId: authOf(req).user.id,
          key,
          operation: 'attendance.event',
          requestHash,
        },
        async () => ({
          statusCode: 200,
          body: await processAttendanceEvent(deps.db, authOf(req), input, req.requestId),
        }),
      );
      res.status(result.statusCode).json(result.body);
    }),
  );

  router.post(
    '/attendance/sync',
    limiter(deps, { windowMs: 60 * 1000, limit: 30, prefix: 'sync:', key: userOrIp }),
    asyncHandler(async (req, res) => {
      const input = parseBody(syncBatchSchema, req.body);
      const results = [];
      for (const event of input.events) {
        try {
          const result: ClockResult = await processAttendanceEvent(
            deps.db,
            authOf(req),
            event,
            req.requestId,
          );
          results.push({
            clientEventId: event.clientEventId,
            outcome: result.outcome,
            eventId: result.eventId,
            shiftId: result.shift?.id ?? null,
            message: result.message,
            reviewReason: result.reviewReason,
          });
        } catch (error) {
          results.push({
            clientEventId: event.clientEventId,
            outcome: 'REJECTED' as const,
            eventId: null,
            shiftId: null,
            message:
              error instanceof AppError
                ? error.message
                : 'This item could not be processed. Try syncing again.',
            reviewReason: null,
          });
        }
      }
      res.json({ results });
    }),
  );

  router.post(
    '/location/observations',
    limiter(deps, { windowMs: 60 * 1000, limit: 240, prefix: 'observation:', key: userOrIp }),
    asyncHandler(async (req, res) => {
      const input = parseBody(observationInputSchema, req.body);
      res.status(202).json(await ingestObservation(deps.db, authOf(req), input));
    }),
  );

  router.get(
    '/alerts',
    asyncHandler(async (req, res) => {
      const query = parseQuery(
        z.object({
          state: z.enum(['UNREAD', 'READ', 'REVIEWED']).optional(),
          cursor: z.string().max(200).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(25),
        }),
        req.query,
      );
      res.json(await listMyAlerts(deps.db, authOf(req), query));
    }),
  );

  router.get(
    '/alerts/:alertId',
    asyncHandler(async (req, res) => {
      res.json(await getAlert(deps.db, authOf(req), objectId(param(req, 'alertId'), 'alertId')));
    }),
  );

  router.post(
    '/alerts/:alertId/review',
    asyncHandler(async (req, res) => {
      requireCapability(req, 'owner.alerts');
      const input = parseBody(alertReviewSchema, req.body);
      res.json(
        await reviewAlertAsOwner(
          deps.db,
          authOf(req),
          objectId(param(req, 'alertId'), 'alertId'),
          input,
          req.requestId,
        ),
      );
    }),
  );

  router.post(
    '/corrections',
    limiter(deps, { windowMs: 60 * 60 * 1000, limit: 20, prefix: 'correction:', key: userOrIp }),
    asyncHandler(async (req, res) => {
      const input = parseBody(correctionCreateSchema, req.body);
      res.status(201).json(await requestCorrection(deps.db, authOf(req), input, req.requestId));
    }),
  );

  router.get(
    '/corrections',
    asyncHandler(async (req, res) => {
      const query = parseQuery(
        z.object({
          scope: z.enum(['mine', 'review']).optional(),
          status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(),
          cursor: z.string().max(200).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(25),
        }),
        req.query,
      );
      const auth = authOf(req);
      const scope =
        query.scope ??
        (auth.capabilities.includes('staff.history') ? 'mine' : 'review');
      if (scope === 'review') {
        requireCapability(req, 'owner.corrections');
        res.json(
          await ownerCorrections(deps.db, auth, {
            status: query.status,
            cursor: query.cursor,
            limit: query.limit,
          }),
        );
        return;
      }
      requireCapability(req, 'staff.history');
      res.json({ items: await myCorrections(deps.db, auth), nextCursor: null });
    }),
  );

  router.get(
    '/corrections/:correctionId',
    asyncHandler(async (req, res) => {
      res.json(
        await correctionDetail(
          deps.db,
          authOf(req),
          objectId(param(req, 'correctionId'), 'correctionId'),
        ),
      );
    }),
  );

  router.post(
    '/corrections/:correctionId/decision',
    asyncHandler(async (req, res) => {
      requireCapability(req, 'owner.corrections');
      const input = parseBody(correctionDecisionSchema, req.body);
      res.json(
        await decideCorrectionRequest(
          deps.db,
          authOf(req),
          objectId(param(req, 'correctionId'), 'correctionId'),
          input,
          req.requestId,
        ),
      );
    }),
  );

  router.get(
    '/owner/overview',
    asyncHandler(async (req, res) => {
      requireCapability(req, 'owner.overview');
      res.json(await ownerOverview(deps.db, authOf(req)));
    }),
  );

  router.get(
    '/owner/insights',
    asyncHandler(async (req, res) => {
      requireCapability(req, 'owner.overview');
      const query = parseQuery(ownerInsightsQuerySchema, req.query);
      res.json(
        await ownerInsights(deps.db, authOf(req), {
          siteId: query.siteId,
          from: new Date(query.from),
          to: new Date(query.to),
          limit: query.limit,
        }),
      );
    }),
  );

  router.get(
    '/sites/:siteId/live',
    asyncHandler(async (req, res) => {
      requireCapability(req, 'owner.overview');
      res.json(await siteLive(deps.db, authOf(req), objectId(param(req, 'siteId'), 'siteId')));
    }),
  );

  router.get(
    '/timesheets',
    asyncHandler(async (req, res) => {
      requireCapability(req, 'owner.exports');
      const query = parseQuery(timesheetQuerySchema, req.query);
      res.json(
        await timesheets(deps.db, authOf(req), {
          siteId: query.siteId,
          from: new Date(query.from),
          to: new Date(query.to),
          cursor: query.cursor,
          limit: query.limit,
        }),
      );
    }),
  );

  router.post(
    '/exports',
    limiter(deps, { windowMs: 60 * 60 * 1000, limit: 5, prefix: 'export:', key: userOrIp }),
    asyncHandler(async (req, res) => {
      const input = parseBody(exportRequestSchema, req.body);
      const auth = authOf(req);
      const isAdmin = auth.roles.includes('PLATFORM_ADMIN');
      if (isAdmin) {
        res.json(
          await adminExport(
            deps.db,
            auth,
            {
              organizationId: input.organizationId,
              siteId: input.siteId,
              from: new Date(input.from),
              to: new Date(input.to),
            },
            req.requestId,
          ),
        );
        return;
      }
      requireCapability(req, 'owner.exports');
      res.json(
        await exportTimesheets(
          deps.db,
          auth,
          {
            organizationId: input.organizationId,
            siteId: input.siteId,
            from: new Date(input.from),
            to: new Date(input.to),
          },
          req.requestId,
        ),
      );
    }),
  );

  const adminRouter = Router();
  adminRouter.use((req, _res, next) => {
    try {
      requireAdmin(req);
      next();
    } catch (error) {
      next(error);
    }
  });

  adminRouter.get(
    '/overview',
    asyncHandler(async (req, res) => {
      requireCapability(req, 'admin.organizations');
      res.json(await admin.overview(deps.db));
    }),
  );

  adminRouter.get(
    '/organizations',
    asyncHandler(async (req, res) => {
      requireCapability(req, 'admin.organizations');
      res.json(await admin.organizations(deps.db));
    }),
  );

  adminRouter.post(
    '/organizations',
    asyncHandler(async (req, res) => {
      requireCapability(req, 'admin.organizations');
      const input = parseBody(organizationCreateSchema, req.body);
      res.status(201).json(
        await admin.createOrganizationAdmin(deps.db, authOf(req), input, req.requestId),
      );
    }),
  );

  adminRouter.get(
    '/organizations/:organizationId',
    asyncHandler(async (req, res) => {
      requireCapability(req, 'admin.organizations');
      res.json(
        await admin.organizationDetail(
          deps.db,
          objectId(param(req, 'organizationId'), 'organizationId'),
        ),
      );
    }),
  );

  adminRouter.patch(
    '/organizations/:organizationId',
    asyncHandler(async (req, res) => {
      requireCapability(req, 'admin.organizations');
      requireRecentAuth(req);
      const input = parseBody(organizationUpdateSchema, req.body);
      res.json(
        await admin.updateOrganizationAdmin(
          deps.db,
          authOf(req),
          objectId(param(req, 'organizationId'), 'organizationId'),
          input,
          req.requestId,
        ),
      );
    }),
  );

  adminRouter.delete(
    '/organizations/:organizationId',
    asyncHandler(async (req, res) => {
      requireCapability(req, 'admin.organizations');
      requireRecentAuth(req);
      const input = parseBody(organizationDeleteSchema, req.body);
      res.json(
        await admin.deleteOrganizationAdmin(
          deps.db,
          authOf(req),
          objectId(param(req, 'organizationId'), 'organizationId'),
          input,
          req.requestId,
        ),
      );
    }),
  );

  adminRouter.post(
    '/organizations/:organizationId/members',
    limiter(deps, {
      windowMs: 60 * 60 * 1000,
      limit: 30,
      prefix: 'admin-invite:',
      key: userOrIp,
    }),
    asyncHandler(async (req, res) => {
      requireCapability(req, 'admin.users');
      requireRecentAuth(req);
      const input = parseBody(adminMemberInviteSchema, req.body);
      res.status(201).json(
        await admin.inviteOrganizationMemberAdmin(
          deps.db,
          authOf(req),
          objectId(param(req, 'organizationId'), 'organizationId'),
          {
            email: input.email,
            role: input.role,
            ...(input.siteId ? { siteId: objectId(input.siteId, 'siteId') } : {}),
            ...(input.note ? { note: input.note } : {}),
          },
          {
            requestId: req.requestId,
            webUrl: deps.env.trustedWebOrigins[0] ?? 'http://localhost:3000',
            allowDevToken: !deps.env.isProduction || deps.env.ENABLE_DEV_TOKENS,
            sendMail: (message) => deps.mailer.send(message),
            inviterName: authOf(req).user.name,
          },
          req.requestId,
        ),
      );
    }),
  );

  adminRouter.post(
    '/admins',
    limiter(deps, {
      windowMs: 60 * 60 * 1000,
      limit: 30,
      prefix: 'admin-create:',
      key: userOrIp,
    }),
    asyncHandler(async (req, res) => {
      requireCapability(req, 'admin.users');
      requireRecentAuth(req);
      const input = parseBody(adminInviteSchema, req.body);
      res.status(201).json(
        await admin.invitePlatformAdmin(
          deps.db,
          authOf(req),
          input,
          {
            requestId: req.requestId,
            webUrl: deps.env.trustedWebOrigins[0] ?? 'http://localhost:3000',
            allowDevToken: !deps.env.isProduction || deps.env.ENABLE_DEV_TOKENS,
            sendMail: (message) => deps.mailer.send(message),
            inviterName: authOf(req).user.name,
          },
          req.requestId,
        ),
      );
    }),
  );

  adminRouter.delete(
    '/users/:userId',
    asyncHandler(async (req, res) => {
      requireCapability(req, 'admin.users');
      requireRecentAuth(req);
      const input = parseBody(adminUserDeleteSchema, req.body);
      res.json(
        await admin.deleteUserAdmin(
          deps.db,
          authOf(req),
          param(req, 'userId'),
          input,
          req.requestId,
        ),
      );
    }),
  );

  adminRouter.post(
    '/users/:userId/reactivate',
    asyncHandler(async (req, res) => {
      requireCapability(req, 'admin.users');
      requireRecentAuth(req);
      const input = parseBody(adminUserReactivateSchema, req.body);
      res.json(
        await admin.reactivateUserAdmin(
          deps.db,
          authOf(req),
          param(req, 'userId'),
          input,
          req.requestId,
        ),
      );
    }),
  );

  adminRouter.patch('/users/:userId', asyncHandler(async (req, res) => {
    requireCapability(req, 'admin.users'); requireRecentAuth(req);
    res.json(await updateAccountProfile(deps, authOf(req), param(req, 'userId'), parseBody(accountProfileSchema, req.body), req.requestId));
  }));

  adminRouter.get(
    '/users',
    asyncHandler(async (req, res) => {
      requireCapability(req, 'admin.users');
      const organizationId =
        typeof req.query.organizationId === 'string' ? req.query.organizationId : undefined;
      res.json(await admin.adminUsers(deps.db, { organizationId }));
    }),
  );

  adminRouter.patch(
    '/memberships/:membershipId',
    asyncHandler(async (req, res) => {
      requireCapability(req, 'admin.users');
      requireRecentAuth(req);
      const input = parseBody(membershipUpdateSchema, req.body);
      res.json(
        await admin.updateMembershipAdmin(
          deps.db,
          authOf(req),
          objectId(param(req, 'membershipId'), 'membershipId'),
          input,
          req.requestId,
        ),
      );
    }),
  );

  adminRouter.get(
    '/sites',
    asyncHandler(async (req, res) => {
      requireCapability(req, 'admin.sites');
      res.json(await admin.platformSites(deps.db));
    }),
  );

  adminRouter.patch(
    '/sites/:siteId',
    asyncHandler(async (req, res) => {
      requireCapability(req, 'admin.sites');
      requireRecentAuth(req);
      const input = parseBody(
        platformSiteUpdateSchema.extend({ timezone: timezoneSchema.optional() }),
        req.body,
      );
      res.json(
        await admin.updateSiteAdmin(
          deps.db,
          authOf(req),
          objectId(param(req, 'siteId'), 'siteId'),
          input,
          req.requestId,
        ),
      );
    }),
  );

  adminRouter.get(
    '/audit',
    asyncHandler(async (req, res) => {
      requireCapability(req, 'admin.audit');
      const query = parseQuery(
        z.object({
          organizationId: objectIdSchema.optional(),
          actorId: z.string().max(100).optional(),
          action: z.string().max(100).optional(),
          from: isoDateTimeSchema.optional(),
          to: isoDateTimeSchema.optional(),
          cursor: z.string().max(200).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
        req.query,
      );
      res.json(
        await admin.auditEvents(deps.db, {
          organizationId: query.organizationId,
          actorId: query.actorId,
          action: query.action,
          from: query.from ? new Date(query.from) : undefined,
          to: query.to ? new Date(query.to) : undefined,
          cursor: query.cursor,
          limit: query.limit,
        }),
      );
    }),
  );

  adminRouter.get(
    '/health',
    asyncHandler(async (req, res) => {
      requireCapability(req, 'admin.health');
      res.json(await admin.health(deps.db, deps.env));
    }),
  );

  adminRouter.get(
    '/deliveries',
    asyncHandler(async (req, res) => {
      requireCapability(req, 'admin.health');
      const query = parseQuery(
        z.object({
          state: z.enum(['PENDING', 'LEASED', 'SENT', 'FAILED', 'DEAD', 'CANCELLED']).optional(),
          cursor: z.string().max(200).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
        req.query,
      );
      res.json(await admin.deliveries(deps.db, query));
    }),
  );

  adminRouter.post(
    '/deliveries/retry',
    asyncHandler(async (req, res) => {
      requireCapability(req, 'admin.health');
      requireRecentAuth(req);
      const input = parseBody(retryOutboxSchema, req.body);
      res.json(await admin.retryDeliveries(deps.db, authOf(req), input.outboxIds, req.requestId));
    }),
  );

  adminRouter.get(
    '/grants',
    asyncHandler(async (req, res) => {
      requireCapability(req, 'admin.users');
      res.json(await admin.grants(deps.db));
    }),
  );

  adminRouter.post(
    '/grants',
    asyncHandler(async (req, res) => {
      requireCapability(req, 'admin.users');
      requireRecentAuth(req);
      const input = parseBody(accessGrantCreateSchema, req.body);
      res.status(201).json(await admin.createGrant(deps.db, authOf(req), input, req.requestId));
    }),
  );

  adminRouter.delete(
    '/grants/:grantId',
    asyncHandler(async (req, res) => {
      requireCapability(req, 'admin.users');
      requireRecentAuth(req);
      res.json(
        await admin.revokeGrant(
          deps.db,
          authOf(req),
          objectId(param(req, 'grantId'), 'grantId'),
          req.requestId,
        ),
      );
    }),
  );

  adminRouter.get(
    '/organizations/:organizationId/timesheets',
    asyncHandler(async (req, res) => {
      const query = parseQuery(timesheetQuerySchema, req.query);
      res.json(
        await adminTimesheets(deps.db, authOf(req), {
          organizationId: param(req, 'organizationId'),
          siteId: query.siteId,
          from: new Date(query.from),
          to: new Date(query.to),
          cursor: query.cursor,
          limit: query.limit,
        }),
      );
    }),
  );

  router.use('/admin', adminRouter);

  return router;
}
