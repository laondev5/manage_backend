import type {
  AlertState,
  Capability,
  ExpectedHours,
  NotificationPreferences,
  PresenceState,
  Role,
  SitePolicy,
  SyncState,
} from '../contracts/index.js';
import type { Db, ObjectId } from 'mongodb';

export type GeoPointDoc = {
  type: 'Point';
  coordinates: [longitude: number, latitude: number];
};

export type OrganizationDoc = {
  _id: ObjectId;
  name: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';
  contactEmail: string;
  timezone: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  /** Soft delete. Historical attendance and audit records keep their organizationId. */
  deletedAt?: Date | null;
  deletedBy?: string | null;
  deletionReason?: string | null;
};

export type OnboardingDoc = {
  detailsConfirmed: boolean;
  siteReviewed: boolean;
  readinessCompleted: boolean;
  siteDetailsDone: boolean;
  boundaryDone: boolean;
  inviteDone: boolean;
  alertsReviewed: boolean;
  completedAt: Date | null;
};

export type MembershipDoc = {
  /** Explicit coordinate-edit permission; only effective for a supervisor. */
  canUpdateSiteLocation?: boolean;
  _id: ObjectId;
  organizationId: ObjectId;
  userId: string;
  role: Role;
  status: 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
  title: string | null;
  onboarding: OnboardingDoc;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type SitePolicyDoc = SitePolicy;

export type SiteDoc = {
  _id: ObjectId;
  organizationId: ObjectId;
  name: string;
  address: string;
  location: GeoPointDoc;
  timezone: string;
  ownerIds: string[];
  policy: SitePolicyDoc;
  policyVersion: number;
  expectedHours: ExpectedHours | null;
  notificationPreferences: NotificationPreferences;
  status: 'ACTIVE' | 'INACTIVE';
  /** Staff member the owner designated as on-site team lead. */
  teamLeadId?: string | null;
  /** Staff member or the owner designated to inspect this site. */
  inspectorId?: string | null;
  /** Set when an owner archives the site; archived sites stay in previous-sites history. */
  archivedAt?: Date | null;
  /** Soft delete: hidden everywhere, while attendance records stay append-only. */
  deletedAt?: Date | null;
  version: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
};

export type SitePolicyHistoryDoc = {
  _id: ObjectId;
  siteId: ObjectId;
  organizationId: ObjectId;
  version: number;
  policy: SitePolicyDoc;
  center: GeoPointDoc;
  timezone: string;
  createdBy: string;
  createdAt: Date;
};

export type AssignmentDoc = {
  _id: ObjectId;
  organizationId: ObjectId;
  siteId: ObjectId;
  memberId: string;
  membershipId: ObjectId;
  permissionScope: 'CLOCK_ONLY' | 'CLOCK_AND_HISTORY';
  effectiveFrom: Date;
  effectiveTo: Date | null;
  /** Null until the staff member accepts the assignment in the app. */
  acceptedAt?: Date | null;
  createdBy: string;
  endedBy?: string | null;
  createdAt: Date;
};

export type PresenceDoc = {
  state: PresenceState;
  candidateSince: Date | null;
  lastQualifiedAt: Date | null;
  lastAccuracyMeters: number | null;
  lastDistanceMeters: number | null;
  updatedAt: Date;
};

export type ShiftDoc = {
  _id: ObjectId;
  organizationId: ObjectId;
  siteId: ObjectId;
  userId: string;
  clientShiftId: string;
  status: 'WORKING' | 'ENDED';
  reviewState: 'ACCEPTED' | 'NEEDS_REVIEW' | 'REJECTED';
  startedAt: Date;
  endedAt: Date | null;
  startCapturedAt: Date;
  endCapturedAt: Date | null;
  startEventId: ObjectId | null;
  endEventId: ObjectId | null;
  presence: PresenceDoc;
  policyVersion: number;
  siteTimezone: string;
  reviewReason: string | null;
  staleFlaggedAt: Date | null;
  lastSyncAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type AttendanceEventDoc = {
  _id: ObjectId;
  organizationId: ObjectId;
  siteId: ObjectId;
  shiftId: ObjectId;
  userId: string;
  deviceId: string;
  clientEventId: string;
  clientShiftId: string;
  type: 'CLOCK_IN' | 'CLOCK_OUT' | 'CLOCK_OUT_EXCEPTION' | 'AMENDMENT';
  outcome: 'ACCEPTED' | 'NEEDS_REVIEW' | 'REJECTED';
  capturedAt: Date;
  receivedAt: Date;
  receivedOffsetSeconds: number;
  location: GeoPointDoc | null;
  accuracyMeters: number | null;
  distanceMeters: number | null;
  sitePolicyVersion: number;
  reviewReason: string | null;
  note: string | null;
  syncState: SyncState;
  correctionId: ObjectId | null;
  requestId: string;
  createdAt: Date;
};

export type ObservationDoc = {
  _id: ObjectId;
  organizationId: ObjectId;
  siteId: ObjectId;
  shiftId: ObjectId;
  userId: string;
  clientObservationId: string;
  location: GeoPointDoc;
  accuracyMeters: number;
  capturedAt: Date;
  receivedAt: Date;
  source: 'FOREGROUND' | 'BACKGROUND' | 'MANUAL';
  policyVersion: number;
  classification: 'INSIDE' | 'OUTSIDE' | 'UNCERTAIN' | 'STALE';
  distanceMeters: number;
  action: string;
  createdAt: Date;
};

export type IncidentDoc = {
  _id: ObjectId;
  organizationId: ObjectId;
  siteId: ObjectId;
  shiftId: ObjectId;
  userId: string;
  state: 'CANDIDATE' | 'CONFIRMED' | 'RETURNED' | 'CANCELLED';
  open: boolean;
  detectedAt: Date;
  confirmedAt: Date | null;
  returnedAt: Date | null;
  cancelledAt: Date | null;
  cancelledReason: string | null;
  lastEvidenceAt: Date;
  detectionLocation: GeoPointDoc | null;
  detectionAccuracyMeters: number | null;
  distanceMeters: number | null;
  radiusMeters: number;
  policyVersion: number;
  createdAt: Date;
  updatedAt: Date;
};

export type CorrectionDoc = {
  _id: ObjectId;
  organizationId: ObjectId;
  siteId: ObjectId;
  shiftId: ObjectId;
  workerId: string;
  requestedBy: string;
  originalStartAt: Date;
  originalEndAt: Date | null;
  proposedStartAt: Date;
  proposedEndAt: Date | null;
  reason: string;
  requestNote: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  reviewerId: string | null;
  reviewerNote: string | null;
  reviewedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type ReportDoc = {
  _id: ObjectId;
  organizationId: ObjectId;
  /** Null when the report covers the general team rather than one site. */
  siteId: ObjectId | null;
  authorId: string;
  /** GENERAL has no site, SITE is written by assigned staff, INSPECTION by the site inspector. */
  kind: 'GENERAL' | 'SITE' | 'INSPECTION';
  title: string;
  body: string;
  /** 'html' for rich text written in the app; 'text' for older plain-text reports. */
  bodyFormat: 'text' | 'html';
  /** Extra titled rich text blocks the reporter added. */
  fields: { heading: string; body: string }[];
  /** Day the report is about; defaults to the creation date. */
  reportDate: Date;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  /** Soft delete: the author can remove a report without destroying history. */
  deletedAt: Date | null;
};

export type SiteReviewDoc = {
  _id: ObjectId;
  organizationId: ObjectId;
  siteId: ObjectId;
  memberId: string;
  rating: number;
  comment: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

export type InvitationDoc = {
  _id: ObjectId;
  organizationId: ObjectId;
  /** Null for a general-team invitation with no site assignment. */
  siteId: ObjectId | null;
  email: string;
  role: 'STAFF' | 'SITE_OWNER' | 'PLATFORM_ADMIN';
  tokenHash: string;
  status: 'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'REVOKED';
  note: string | null;
  createdBy: string;
  createdAt: Date;
  expiresAt: Date;
  acceptedAt: Date | null;
  acceptedBy: string | null;
};

export type DeviceDoc = {
  _id: ObjectId;
  userId: string;
  deviceId: string;
  platform: 'ios' | 'android';
  pushToken: string | null;
  pushEnabled: boolean;
  appVersion: string | null;
  lastSeenAt: Date;
  createdAt: Date;
  revokedAt: Date | null;
};

export type AlertDoc = {
  _id: ObjectId;
  organizationId: ObjectId;
  siteId: ObjectId;
  incidentId: ObjectId;
  recipientId: string;
  workerId: string;
  channel: 'IN_APP';
  state: AlertState;
  detectedAt: Date;
  receivedAt: Date;
  lastUpdateAt: Date | null;
  reviewDecision: 'ACKNOWLEDGED' | 'CONTACTED' | 'DISMISSED' | null;
  reviewNote: string | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  readAt?: Date | null;
  createdAt: Date;
};

export type OutboxDoc = {
  _id: ObjectId;
  logicalKey: string;
  organizationId: ObjectId;
  siteId: ObjectId;
  incidentId: ObjectId;
  alertId: ObjectId;
  recipientId: string;
  channel: 'EMAIL' | 'PUSH';
  state: 'PENDING' | 'LEASED' | 'SENT' | 'FAILED' | 'DEAD' | 'CANCELLED';
  attempts: number;
  nextAttemptAt: Date;
  leaseOwner: string | null;
  leaseUntil: Date | null;
  lastError: string | null;
  providerMessageId: string | null;
  providerAcceptedAt: Date | null;
  deliveryReportedAt: Date | null;
  retriedBy?: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type AuditHeadDoc = {
  _id: 'main';
  sequence: number;
  hash: string;
  updatedAt: Date;
};

export type AuditDoc = {
  _id: ObjectId;
  sequence: number;
  at: Date;
  actorId: string | null;
  actorName: string | null;
  actorRole: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  organizationId: ObjectId | null;
  siteId: ObjectId | null;
  requestId: string | null;
  summary: string;
  meta: Record<string, unknown>;
  hash: string;
  previousHash: string | null;
};

export type IdempotencyDoc = {
  _id: ObjectId;
  actorId: string;
  key: string;
  operation: string;
  requestHash: string;
  statusCode: number;
  responseBody: unknown;
  createdAt: Date;
  expiresAt: Date;
};

export type AccessGrantDoc = {
  _id: ObjectId;
  adminUserId: string;
  organizationId: ObjectId;
  siteId: ObjectId | null;
  capability: Capability;
  expiresAt: Date;
  reason: string;
  createdBy: string;
  createdAt: Date;
  revokedAt: Date | null;
};

export type ProviderEventDoc = {
  _id: string;
  provider: 'resend';
  type: string;
  eventId: string;
  receivedAt: Date;
  payloadDigest: string;
  processedAt: Date | null;
};

export type RateLimitDoc = {
  _id: string;
  count: number;
  resetAt: Date;
};

export type WorkerHeartbeatDoc = {
  _id: 'worker';
  lastHeartbeatAt: Date;
  workerId: string;
  state: 'idle' | 'working';
  /** A long-running loop or a scheduled tick. Older rows default to `loop`. */
  mode?: 'loop' | 'scheduled';
  /** How long a heartbeat stays healthy for this runtime. Older rows default to 60. */
  staleAfterSeconds?: number;
};

export type ExportDoc = {
  _id: ObjectId;
  organizationId: ObjectId;
  siteId: ObjectId | null;
  requestedBy: string;
  from: Date;
  to: Date;
  rowCount: number;
  createdAt: Date;
};

export type AuthUserDoc = {
  mustChangePassword?: boolean;
  temporaryPasswordExpiresAt?: Date | null;
  initialPasswordChanging?: boolean;
  temporaryPasswordUsedAt?: Date | null;
  phone?: string;
  _id: ObjectId | string;
  id?: string;
  name: string;
  email: string;
  /** Set by an administrator; disabled accounts cannot authenticate or act. */
  status?: 'ACTIVE' | 'DISABLED';
  disabledAt?: Date | null;
  disabledReason?: string | null;
  /** Set when a platform admin deletes an account. The document is retained for history. */
  deletedAt?: Date | null;
  deletedBy?: string | null;
  deletedReason?: string | null;
  emailVerified: boolean;
  twoFactorEnabled?: boolean | null;
  createdAt: Date;
  updatedAt?: Date;
};

export type Collections = {
  organizations: import('mongodb').Collection<OrganizationDoc>;
  memberships: import('mongodb').Collection<MembershipDoc>;
  sites: import('mongodb').Collection<SiteDoc>;
  sitePolicies: import('mongodb').Collection<SitePolicyHistoryDoc>;
  assignments: import('mongodb').Collection<AssignmentDoc>;
  shifts: import('mongodb').Collection<ShiftDoc>;
  attendanceEvents: import('mongodb').Collection<AttendanceEventDoc>;
  observations: import('mongodb').Collection<ObservationDoc>;
  incidents: import('mongodb').Collection<IncidentDoc>;
  corrections: import('mongodb').Collection<CorrectionDoc>;
  reports: import('mongodb').Collection<ReportDoc>;
  siteReviews: import('mongodb').Collection<SiteReviewDoc>;
  invitations: import('mongodb').Collection<InvitationDoc>;
  devices: import('mongodb').Collection<DeviceDoc>;
  alerts: import('mongodb').Collection<AlertDoc>;
  outbox: import('mongodb').Collection<OutboxDoc>;
  auditEvents: import('mongodb').Collection<AuditDoc>;
  auditHeads: import('mongodb').Collection<AuditHeadDoc>;
  idempotency: import('mongodb').Collection<IdempotencyDoc>;
  accessGrants: import('mongodb').Collection<AccessGrantDoc>;
  providerEvents: import('mongodb').Collection<ProviderEventDoc>;
  rateLimits: import('mongodb').Collection<RateLimitDoc>;
  workerHeartbeats: import('mongodb').Collection<WorkerHeartbeatDoc>;
  exports: import('mongodb').Collection<ExportDoc>;
  users: import('mongodb').Collection<AuthUserDoc>;
};

export function collections(db: Db): Collections {
  return {
    organizations: db.collection<OrganizationDoc>('organizations'),
    memberships: db.collection<MembershipDoc>('memberships'),
    sites: db.collection<SiteDoc>('sites'),
    sitePolicies: db.collection<SitePolicyHistoryDoc>('sitePolicies'),
    assignments: db.collection<AssignmentDoc>('assignments'),
    shifts: db.collection<ShiftDoc>('shifts'),
    attendanceEvents: db.collection<AttendanceEventDoc>('attendanceEvents'),
    observations: db.collection<ObservationDoc>('observations'),
    incidents: db.collection<IncidentDoc>('incidents'),
    corrections: db.collection<CorrectionDoc>('corrections'),
    reports: db.collection<ReportDoc>('reports'),
    siteReviews: db.collection<SiteReviewDoc>('siteReviews'),
    invitations: db.collection<InvitationDoc>('invitations'),
    devices: db.collection<DeviceDoc>('devices'),
    alerts: db.collection<AlertDoc>('alerts'),
    outbox: db.collection<OutboxDoc>('outbox'),
    auditEvents: db.collection<AuditDoc>('auditEvents'),
    auditHeads: db.collection<AuditHeadDoc>('auditHeads'),
    idempotency: db.collection<IdempotencyDoc>('idempotency'),
    accessGrants: db.collection<AccessGrantDoc>('accessGrants'),
    providerEvents: db.collection<ProviderEventDoc>('providerEvents'),
    rateLimits: db.collection<RateLimitDoc>('rateLimits'),
    workerHeartbeats: db.collection<WorkerHeartbeatDoc>('workerHeartbeats'),
    exports: db.collection<ExportDoc>('exports'),
    users: db.collection<AuthUserDoc>('user'),
  };
}

export const pointDoc = (longitude: number, latitude: number): GeoPointDoc => ({
  type: 'Point',
  coordinates: [longitude, latitude],
});

export const userIdOf = (user: AuthUserDoc): string =>
  typeof user._id === 'string' ? user._id : user._id.toHexString();
