import type { CreateIndexesOptions, Db, IndexDescription } from 'mongodb';
import type { Collections } from './collections.js';

export type IndexSpec = {
  collection: keyof Collections;
  name: string;
  key: IndexDescription['key'];
  options?: CreateIndexesOptions;
};

export const indexSpecs: IndexSpec[] = [
  {
    collection: 'memberships',
    name: 'membership_org_user_unique',
    key: { organizationId: 1, userId: 1 },
    options: { unique: true },
  },
  { collection: 'memberships', name: 'membership_user_status', key: { userId: 1, status: 1 } },
  {
    collection: 'memberships',
    name: 'membership_org_role_status',
    key: { organizationId: 1, role: 1, status: 1 },
  },

  { collection: 'sites', name: 'site_org_status', key: { organizationId: 1, status: 1 } },
  { collection: 'sites', name: 'site_owner', key: { ownerIds: 1, status: 1 } },
  {
    collection: 'sitePolicies',
    name: 'site_policy_version_unique',
    key: { siteId: 1, version: 1 },
    options: { unique: true },
  },
  {
    collection: 'sitePolicies',
    name: 'site_policy_site_recent',
    key: { siteId: 1, version: -1 },
  },

  { collection: 'assignments', name: 'assignment_site_active', key: { siteId: 1, effectiveTo: 1 } },
  { collection: 'assignments', name: 'assignment_member_active', key: { memberId: 1, effectiveTo: 1 } },
  {
    collection: 'assignments',
    name: 'assignment_site_member_from_unique',
    key: { siteId: 1, memberId: 1, effectiveFrom: 1 },
    options: { unique: true },
  },

  {
    collection: 'shifts',
    name: 'shift_one_active_per_user',
    key: { userId: 1 },
    options: { unique: true, partialFilterExpression: { status: 'WORKING' } },
  },
  {
    collection: 'shifts',
    name: 'shift_client_shift_unique',
    key: { userId: 1, clientShiftId: 1 },
    options: { unique: true },
  },
  { collection: 'shifts', name: 'shift_site_recent', key: { siteId: 1, startedAt: -1 } },
  { collection: 'shifts', name: 'shift_user_recent', key: { userId: 1, startedAt: -1 } },
  { collection: 'shifts', name: 'shift_org_status', key: { organizationId: 1, status: 1 } },
  { collection: 'shifts', name: 'shift_status_started', key: { status: 1, startedAt: 1 } },
  { collection: 'shifts', name: 'shift_presence_state', key: { 'presence.state': 1, status: 1 } },

  {
    collection: 'attendanceEvents',
    name: 'attendance_event_replay_unique',
    key: { userId: 1, deviceId: 1, clientEventId: 1 },
    options: { unique: true },
  },
  {
    collection: 'attendanceEvents',
    name: 'attendance_event_shift_time',
    key: { shiftId: 1, capturedAt: 1 },
  },
  {
    collection: 'attendanceEvents',
    name: 'attendance_event_site_received',
    key: { siteId: 1, receivedAt: -1 },
  },
  {
    collection: 'attendanceEvents',
    name: 'attendance_event_user_received',
    key: { userId: 1, receivedAt: -1 },
  },
  {
    collection: 'attendanceEvents',
    name: 'attendance_event_captured_at',
    key: { capturedAt: 1 },
  },

  {
    collection: 'observations',
    name: 'observation_client_unique',
    key: { userId: 1, clientObservationId: 1 },
    options: { unique: true },
  },
  {
    collection: 'observations',
    name: 'observation_shift_time',
    key: { shiftId: 1, capturedAt: -1 },
  },
  { collection: 'observations', name: 'observation_retention', key: { createdAt: 1 } },

  {
    collection: 'incidents',
    name: 'incident_open_shift_unique',
    key: { shiftId: 1 },
    options: { unique: true, partialFilterExpression: { open: true } },
  },
  {
    collection: 'incidents',
    name: 'incident_site_state',
    key: { organizationId: 1, siteId: 1, state: 1 },
  },
  { collection: 'incidents', name: 'incident_shift_recent', key: { shiftId: 1, createdAt: -1 } },

  {
    collection: 'corrections',
    name: 'correction_pending_shift_unique',
    key: { shiftId: 1 },
    options: { unique: true, partialFilterExpression: { status: 'PENDING' } },
  },
  {
    collection: 'corrections',
    name: 'correction_org_status',
    key: { organizationId: 1, status: 1, createdAt: -1 },
  },
  { collection: 'corrections', name: 'correction_shift', key: { shiftId: 1, createdAt: -1 } },

  { collection: 'reports', name: 'report_author_recent', key: { authorId: 1, createdAt: -1 } },
  { collection: 'reports', name: 'report_site_recent', key: { siteId: 1, createdAt: -1 } },
  { collection: 'reports', name: 'report_org_recent', key: { organizationId: 1, createdAt: -1 } },

  {
    collection: 'siteReviews',
    name: 'site_review_member_unique',
    key: { siteId: 1, memberId: 1 },
    options: { unique: true, partialFilterExpression: { deletedAt: null } },
  },
  {
    collection: 'siteReviews',
    name: 'site_review_site_recent',
    key: { siteId: 1, createdAt: -1 },
  },

  { collection: 'sites', name: 'site_team_lead', key: { teamLeadId: 1 } },

  {
    collection: 'invitations',
    name: 'invitation_token_unique',
    key: { tokenHash: 1 },
    options: { unique: true },
  },
  { collection: 'invitations', name: 'invitation_email_status', key: { email: 1, status: 1 } },
  {
    collection: 'invitations',
    name: 'invitation_site_recent',
    key: { siteId: 1, createdAt: -1 },
  },

  {
    collection: 'devices',
    name: 'device_user_unique',
    key: { userId: 1, deviceId: 1 },
    options: { unique: true },
  },
  { collection: 'devices', name: 'device_push_token', key: { pushToken: 1 } },

  {
    collection: 'alerts',
    name: 'alert_incident_recipient_unique',
    key: { incidentId: 1, recipientId: 1 },
    options: { unique: true },
  },
  {
    collection: 'alerts',
    name: 'alert_recipient_state',
    key: { recipientId: 1, state: 1, createdAt: -1 },
  },
  { collection: 'alerts', name: 'alert_site_recent', key: { siteId: 1, createdAt: -1 } },

  {
    collection: 'outbox',
    name: 'outbox_logical_unique',
    key: { logicalKey: 1 },
    options: { unique: true },
  },
  { collection: 'outbox', name: 'outbox_due', key: { state: 1, nextAttemptAt: 1 } },
  { collection: 'outbox', name: 'outbox_lease', key: { state: 1, leaseUntil: 1 } },
  { collection: 'outbox', name: 'outbox_recipient', key: { recipientId: 1, createdAt: -1 } },

  { collection: 'auditEvents', name: 'audit_at', key: { at: -1 } },
  { collection: 'auditEvents', name: 'audit_org_at', key: { organizationId: 1, at: -1 } },
  { collection: 'auditEvents', name: 'audit_actor_at', key: { actorId: 1, at: -1 } },
  { collection: 'auditEvents', name: 'audit_action', key: { action: 1, at: -1 } },
  { collection: 'auditEvents', name: 'audit_sequence_unique', key: { sequence: 1 }, options: { unique: true } },

  {
    collection: 'idempotency',
    name: 'idempotency_actor_key_unique',
    key: { actorId: 1, key: 1 },
    options: { unique: true },
  },
  {
    collection: 'idempotency',
    name: 'idempotency_ttl',
    key: { expiresAt: 1 },
    options: { expireAfterSeconds: 0 },
  },

  { collection: 'accessGrants', name: 'grant_admin_capability', key: { adminUserId: 1, capability: 1 } },
  { collection: 'accessGrants', name: 'grant_org', key: { organizationId: 1, revokedAt: 1 } },

  {
    collection: 'providerEvents',
    name: 'provider_event_received',
    key: { provider: 1, receivedAt: -1 },
  },

  {
    collection: 'rateLimits',
    name: 'rate_limit_ttl',
    key: { resetAt: 1 },
    options: { expireAfterSeconds: 60 },
  },

  { collection: 'exports', name: 'export_org_recent', key: { organizationId: 1, createdAt: -1 } },
];

export async function ensureIndexes(db: Db): Promise<void> {
  const grouped = new Map<string, IndexSpec[]>();
  for (const spec of indexSpecs) {
    const list = grouped.get(spec.collection) ?? [];
    list.push(spec);
    grouped.set(spec.collection, list);
  }
  for (const [name, specs] of grouped) {
    await db.collection(name).createIndexes(
      specs.map((spec) => ({
        key: spec.key,
        name: spec.name,
        ...spec.options,
      })),
    );
  }
}

export type IndexVerification = {
  ok: boolean;
  issues: string[];
};

export async function verifyIndexes(db: Db): Promise<IndexVerification> {
  const issues: string[] = [];
  const grouped = new Map<string, IndexSpec[]>();
  for (const spec of indexSpecs) {
    const list = grouped.get(spec.collection) ?? [];
    list.push(spec);
    grouped.set(spec.collection, list);
  }
  for (const [name, specs] of grouped) {
    let existing: Record<string, unknown>[] = [];
    try {
      existing = await db.collection(name).listIndexes().toArray();
    } catch {
      issues.push(`${name}: collection or indexes are missing`);
      continue;
    }
    const byName = new Map(existing.map((index) => [String(index.name), index]));
    for (const spec of specs) {
      const index = byName.get(spec.name);
      if (!index) {
        issues.push(`${name}.${spec.name}: missing`);
        continue;
      }
      if (Boolean(index.unique) !== Boolean(spec.options?.unique)) {
        issues.push(`${name}.${spec.name}: unique mismatch`);
      }
      if (spec.options?.partialFilterExpression) {
        const actual = JSON.stringify(index.partialFilterExpression ?? null);
        const expected = JSON.stringify(spec.options.partialFilterExpression);
        if (actual !== expected) issues.push(`${name}.${spec.name}: partial filter mismatch`);
      }
    }
  }
  return { ok: issues.length === 0, issues };
}
