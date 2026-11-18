import type {
  AdminOverview,
  AdminUserSummary,
  AlertDetail,
  AlertReview,
  AlertSummary,
  AttendanceEventInput,
  AuditEvent,
  CorrectionCreateInput,
  CorrectionDetail,
  CorrectionSummary,
  CurrentShiftResponse,
  DeviceSummary,
  Health,
  InvitationSummary,
  MeResponse,
  observationInputSchema,
  OnboardingState,
  OrganizationSummary,
  OwnerOverview,
  Page,
  ReportCreateInput,
  ReportSummary,
  ReportUpdateInput,
  RosterEntry,
  ShiftDetail,
  ShiftSummary,
  SiteDetail,
  SiteReview,
  SiteReviewCreateInput,
  SiteReviewList,
  SiteReviewUpdateInput,
  SiteSummary,
  SyncItemResult,
  TeamMemberDetail,
  TeamMemberQuery,
  TeamMemberSummary,
  TimesheetRow,
} from '../contracts/index.js';
import type { z } from 'zod';

export type ApiErrorPayload = {
  code: string;
  message: string;
  fields?: Record<string, string[]>;
  requestId: string;
};

export type InvitationPreview = {
  email: string;
  siteName: string | null;
  organizationName: string;
  expiresAt: string;
  status: 'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'REVOKED';
  note: string | null;
};

export type MemberCandidate = {
  memberId: string;
  name: string;
  email: string;
};

export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields?: Record<string, string[]>;
  readonly requestId: string;

  constructor(status: number, payload: ApiErrorPayload) {
    super(payload.message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = payload.code;
    this.fields = payload.fields;
    this.requestId = payload.requestId;
  }
}

export type HeaderProvider = () =>
  | Record<string, string>
  | Promise<Record<string, string>>;

export type TransportOptions = {
  baseUrl: string;
  getHeaders?: HeaderProvider;
  credentials?: NonNullable<RequestInit['credentials']>;
  fetchImpl?: typeof fetch;
  clientKind?: 'web' | 'native';
};

export type RequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  raw?: boolean;
};

export class ApiClient {
  private readonly baseUrl: string;
  private readonly getHeaders?: HeaderProvider;
  private readonly credentials: NonNullable<RequestInit['credentials']>;
  private readonly fetchImpl: typeof fetch;
  private readonly clientKind: 'web' | 'native';

  constructor(options: TransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.getHeaders = options.getHeaders;
    this.credentials = options.credentials ?? 'include';
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.clientKind = options.clientKind ?? 'web';
  }

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(this.clientKind === 'native' ? { 'X-Manage-Client': 'native' } : {}),
      ...(options.headers ?? {}),
      ...(this.getHeaders ? await this.getHeaders() : {}),
    };
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers,
      credentials: this.credentials,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
    if (response.status === 204) return undefined as T;
    const contentType = response.headers.get('content-type') ?? '';
    if (options.raw && response.ok) {
      return (await response.text()) as unknown as T;
    }
    const payload = contentType.includes('application/json')
      ? await response.json()
      : { message: await response.text() };
    if (!response.ok) {
      const error = payload as {
        error?: ApiErrorPayload;
        message?: string;
      };
      throw new ApiClientError(
        response.status,
        error.error ?? {
          code: 'INTERNAL_ERROR',
          message: error.message ?? 'The request could not be completed.',
          requestId: response.headers.get('x-request-id') ?? 'unknown',
        },
      );
    }
    return payload as T;
  }

  get<T>(path: string, options?: RequestOptions) {
    return this.request<T>(path, { ...options, method: 'GET' });
  }

  post<T>(path: string, body?: unknown, options?: RequestOptions) {
    return this.request<T>(path, { ...options, method: 'POST', body });
  }

  patch<T>(path: string, body?: unknown, options?: RequestOptions) {
    return this.request<T>(path, { ...options, method: 'PATCH', body });
  }

  delete<T>(path: string, options?: RequestOptions) {
    return this.request<T>(path, { ...options, method: 'DELETE' });
  }

  me() {
    return this.get<MeResponse>('/api/v1/me');
  }

  switchOrganization(organizationId: string) {
    return this.post<{ ok: true }>('/api/v1/me/organization', { organizationId });
  }

  onboarding() {
    return this.get<OnboardingState>('/api/v1/me/onboarding');
  }

  updateOnboarding(step: string, value: boolean) {
    return this.patch<OnboardingState>('/api/v1/me/onboarding', { step, value });
  }

  sites(scope: 'current' | 'previous' = 'current') {
    const search = new URLSearchParams();
    if (scope !== 'current') search.set('scope', scope);
    const suffix = search.toString();
    return this.get<SiteSummary[]>(`/api/v1/sites${suffix ? `?${suffix}` : ''}`);
  }

  site(siteId: string) {
    return this.get<SiteDetail>(`/api/v1/sites/${siteId}`);
  }

  createSite(input: unknown) {
    return this.post<SiteDetail>('/api/v1/sites', input);
  }

  updateSite(siteId: string, input: unknown) {
    return this.patch<SiteDetail>(`/api/v1/sites/${siteId}`, input);
  }

  siteLifecycle(
    siteId: string,
    input: { action: 'archive' | 'restore' | 'delete'; version: number; note?: string },
  ) {
    return this.post<SiteDetail>(`/api/v1/sites/${siteId}/lifecycle`, input);
  }

  roster(siteId: string) {
    return this.get<RosterEntry[]>(`/api/v1/sites/${siteId}/roster`);
  }

  invitations(siteId: string) {
    return this.get<InvitationSummary[]>(`/api/v1/sites/${siteId}/invitations`);
  }

  invite(siteId: string, email: string, note?: string) {
    return this.post<{ invitation: InvitationSummary; developmentToken: string | null }>(
      `/api/v1/sites/${siteId}/invitations`,
      { email, note },
    );
  }

  revokeInvitation(siteId: string, invitationId: string) {
    return this.delete<{ ok: true }>(`/api/v1/sites/${siteId}/invitations/${invitationId}`);
  }

  memberCandidates(siteId: string, query = '') {
    const search = new URLSearchParams();
    if (query) search.set('q', query);
    return this.get<MemberCandidate[]>(
      `/api/v1/sites/${siteId}/member-candidates?${search.toString()}`,
    );
  }

  teamMembers() {
    return this.get<TeamMemberSummary[]>('/api/v1/team');
  }

  teamMember(memberId: string) {
    return this.get<TeamMemberDetail>(`/api/v1/team/${encodeURIComponent(memberId)}`);
  }

  setMemberStatus(
    memberId: string,
    input: { status: 'ACTIVE' | 'SUSPENDED'; reason: string; expectedVersion: number },
  ) {
    return this.patch<TeamMemberDetail>(`/api/v1/team/${encodeURIComponent(memberId)}/status`, input);
  }

  queryMember(memberId: string, input: { message: string; siteId?: string }) {
    return this.post<TeamMemberQuery>(`/api/v1/team/${encodeURIComponent(memberId)}/query`, input);
  }

  teamInvitations() {
    return this.get<InvitationSummary[]>('/api/v1/team/invitations');
  }

  inviteTeamMember(input: { email: string; note?: string; siteId?: string }) {
    return this.post<{ invitation: InvitationSummary; developmentToken: string | null }>(
      '/api/v1/team/invitations',
      input,
    );
  }

  revokeTeamInvitation(invitationId: string) {
    return this.delete<{ ok: true }>(`/api/v1/team/invitations/${encodeURIComponent(invitationId)}`);
  }

  assignMember(
    siteId: string,
    input: { memberId: string; permissionScope: 'CLOCK_ONLY' | 'CLOCK_AND_HISTORY' },
  ) {
    return this.post<{
      id: string;
      memberId: string;
      siteId: string;
      effectiveFrom: string;
      permissionScope: string;
    }>(`/api/v1/sites/${siteId}/assignments`, input);
  }

  removeAssignment(siteId: string, assignmentId: string) {
    return this.delete<{ ok: true }>(`/api/v1/sites/${siteId}/assignments/${assignmentId}`);
  }

  acceptAssignment(siteId: string) {
    return this.post<{ siteId: string; acceptedAt: string }>(
      `/api/v1/sites/${siteId}/assignments/accept`,
    );
  }

  setTeamLead(siteId: string, memberId: string | null) {
    return this.post<{ siteId: string; teamLeadId: string | null; teamLeadName: string | null }>(
      `/api/v1/sites/${siteId}/team-lead`,
      { memberId },
    );
  }

  setInspector(siteId: string, inspectorId: string | null) {
    return this.post<{
      siteId: string;
      inspectorId: string | null;
      inspectorName: string | null;
      inspectingSelf: boolean;
    }>(`/api/v1/sites/${siteId}/inspector`, { inspectorId });
  }

  reports(scope: 'mine' | 'team' = 'mine') {
    const search = new URLSearchParams();
    if (scope !== 'mine') search.set('scope', scope);
    const suffix = search.toString();
    return this.get<ReportSummary[]>(`/api/v1/reports${suffix ? `?${suffix}` : ''}`);
  }

  report(reportId: string) {
    return this.get<ReportSummary>(`/api/v1/reports/${reportId}`);
  }

  createReport(input: ReportCreateInput) {
    return this.post<ReportSummary>('/api/v1/reports', input);
  }

  updateReport(reportId: string, input: ReportUpdateInput) {
    return this.patch<ReportSummary>(`/api/v1/reports/${reportId}`, input);
  }

  deleteReport(reportId: string) {
    return this.delete<{ ok: true }>(`/api/v1/reports/${reportId}`);
  }

  siteReviews(siteId: string) {
    return this.get<SiteReviewList>(`/api/v1/sites/${siteId}/reviews`);
  }

  createReview(siteId: string, input: SiteReviewCreateInput) {
    return this.post<SiteReview>(`/api/v1/sites/${siteId}/reviews`, input);
  }

  updateReview(siteId: string, reviewId: string, input: SiteReviewUpdateInput) {
    return this.patch<SiteReview>(`/api/v1/sites/${siteId}/reviews/${reviewId}`, input);
  }

  deleteReview(siteId: string, reviewId: string) {
    return this.delete<{ ok: true }>(`/api/v1/sites/${siteId}/reviews/${reviewId}`);
  }

  invitationPreview(token: string) {
    return this.get<InvitationPreview>(`/api/v1/invitations/${encodeURIComponent(token)}`);
  }

  acceptInvitation(input: { token: string; name: string; password: string }) {
    return this.post<{
      ok: true;
      email: string;
      siteName: string | null;
      requiresEmailVerification: boolean;
    }>('/api/v1/invitations/accept', input);
  }

  currentShift() {
    return this.get<CurrentShiftResponse>('/api/v1/shifts/current');
  }

  shift(shiftId: string) {
    return this.get<ShiftDetail>(`/api/v1/shifts/${shiftId}`);
  }

  history(params: { from?: string; to?: string; cursor?: string; limit?: number } = {}) {
    const search = new URLSearchParams();
    if (params.from) search.set('from', params.from);
    if (params.to) search.set('to', params.to);
    if (params.cursor) search.set('cursor', params.cursor);
    if (params.limit) search.set('limit', String(params.limit));
    return this.get<Page<ShiftSummary>>(`/api/v1/shifts?${search.toString()}`);
  }

  clock(event: AttendanceEventInput, idempotencyKey: string) {
    return this.post<{
      outcome: SyncItemResult['outcome'];
      eventId: string | null;
      shift: ShiftSummary | null;
      message: string;
      reviewReason: string | null;
    }>('/api/v1/attendance/events', event, {
      headers: { 'Idempotency-Key': idempotencyKey },
    });
  }

  sync(events: AttendanceEventInput[]) {
    return this.post<{ results: SyncItemResult[] }>('/api/v1/attendance/sync', { events });
  }

  sendObservation(observation: z.infer<typeof observationInputSchema>) {
    return this.post<{ accepted: boolean; presence: string; recordedAt: string; reason: string | null }>(
      '/api/v1/location/observations',
      observation,
    );
  }

  alerts(params: { state?: string; cursor?: string; limit?: number } = {}) {
    const search = new URLSearchParams();
    if (params.state) search.set('state', params.state);
    if (params.cursor) search.set('cursor', params.cursor);
    if (params.limit) search.set('limit', String(params.limit));
    return this.get<Page<AlertSummary>>(`/api/v1/alerts?${search.toString()}`);
  }

  alert(alertId: string) {
    return this.get<AlertDetail>(`/api/v1/alerts/${alertId}`);
  }

  reviewAlert(alertId: string, input: AlertReview) {
    return this.post<AlertDetail>(`/api/v1/alerts/${alertId}/review`, input);
  }

  createCorrection(input: CorrectionCreateInput) {
    return this.post<CorrectionSummary>('/api/v1/corrections', input);
  }

  corrections(
    params: { scope?: 'mine' | 'review'; status?: string; cursor?: string; limit?: number } = {},
  ) {
    const search = new URLSearchParams();
    if (params.scope) search.set('scope', params.scope);
    if (params.status) search.set('status', params.status);
    if (params.cursor) search.set('cursor', params.cursor);
    if (params.limit) search.set('limit', String(params.limit));
    return this.get<Page<CorrectionSummary>>(`/api/v1/corrections?${search.toString()}`);
  }

  correction(correctionId: string) {
    return this.get<CorrectionDetail>(`/api/v1/corrections/${correctionId}`);
  }

  decideCorrection(correctionId: string, input: unknown) {
    return this.post<CorrectionDetail>(`/api/v1/corrections/${correctionId}/decision`, input);
  }

  ownerOverview() {
    return this.get<OwnerOverview>('/api/v1/owner/overview');
  }

  timesheets(params: { siteId?: string; from: string; to: string; cursor?: string }) {
    const search = new URLSearchParams({ from: params.from, to: params.to });
    if (params.siteId) search.set('siteId', params.siteId);
    if (params.cursor) search.set('cursor', params.cursor);
    return this.get<Page<TimesheetRow>>(`/api/v1/timesheets?${search.toString()}`);
  }

  exportTimesheets(input: { organizationId: string; siteId?: string; from: string; to: string }) {
    return this.post<{ filename: string; rowCount: number; csv: string }>('/api/v1/exports', input);
  }

  registerDevice(input: unknown) {
    return this.post<DeviceSummary>('/api/v1/devices', input);
  }

  devices() {
    return this.get<DeviceSummary[]>('/api/v1/devices');
  }

  revokeDevice(deviceId: string) {
    return this.delete<{ ok: true }>(`/api/v1/devices/${deviceId}`);
  }

  adminOverview() {
    return this.get<AdminOverview>('/api/v1/admin/overview');
  }

  organizations() {
    return this.get<OrganizationSummary[]>('/api/v1/admin/organizations');
  }

  users() {
    return this.get<AdminUserSummary[]>('/api/v1/admin/users');
  }

  platformSites() {
    return this.get<Array<SiteSummary & { organizationName: string; staffCount: number }>>(
      '/api/v1/admin/sites',
    );
  }

  audit(params: { action?: string; cursor?: string; limit?: number } = {}) {
    const search = new URLSearchParams();
    if (params.action) search.set('action', params.action);
    if (params.cursor) search.set('cursor', params.cursor);
    if (params.limit) search.set('limit', String(params.limit));
    return this.get<Page<AuditEvent>>(`/api/v1/admin/audit?${search.toString()}`);
  }

  health() {
    return this.get<Health>('/api/v1/admin/health');
  }

  csrf() {
    return this.get<{ token: string }>('/api/v1/csrf');
  }
}
