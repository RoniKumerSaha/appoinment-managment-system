/**
 * API client for apps/web.
 *
 * E1-S0-ui is the first story to consume the admin API. W10 (this story)
 * adds real staff login + patient OTP + session rehydration. The dev-mode
 * `x-auth-claim` header from E1-S0-ui is preserved as a fallback for
 * offline development with no backend; the preferred path is a real
 * `Authorization: Bearer <jwt>` whose token lives in `localStorage` under
 * the `medislot.auth` key.
 *
 * The session store is the React-y wrapper at `apps/web/src/auth/store.ts`.
 * This file is the low-level transport: it knows how to attach the right
 * header, surface API errors as `ApiError(status, code)`, and dispatch a
 * 401 to the store so the UI can re-route to the login screen.
 */
const API_BASE = ''; // same origin via Vite proxy in dev

// ─── Public types ──────────────────────────────────────────────────────

export type AuthRole = 'patient' | 'receptionist' | 'doctor' | 'admin';
export type AuthScope = 'self' | 'branch' | 'clinic' | 'global';

export interface AuthClaim {
  sub: string;
  role: AuthRole;
  branch_ids: string[];
  scope: AuthScope;
  doctor_id?: string;
  expires_at: number;
  jti: string;
}

export interface Profile {
  full_name: string | null;
  email: string;
  branch_id: string | null;
  branch_name: string | null;
  tz: string | null;
}

export interface LoginResponse {
  token: string;
  claim: AuthClaim;
  expires_at: string;
  profile: Profile;
}

export interface ClinicCounts {
  branches_total: number;
  branches_active: number;
  branches_inactive: number;
  doctors_total: number;
  doctors_active: number;
  doctors_inactive: number;
  receptionists_total: number;
  receptionists_active: number;
  receptionists_inactive: number;
  patients_total: number;
}

export interface ClinicDto {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  counts: ClinicCounts;
}

// ─── Error envelope ────────────────────────────────────────────────────

/** The body of a failed API response. Only the fields the API actually
 *  sends are typed; `error` is the machine-readable code, and the rest
 *  are route-specific payloads (e.g. the `impact` block on a 409 from
 *  `PATCH /admin/branches/:id/hours`). */
export interface ApiErrorBody {
  error?: unknown;
  fields?: unknown;
  impact?: unknown;
  warning?: unknown;
  future_appointment_count?: unknown;
  [key: string]: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** The parsed response body. Carries route-specific payloads that the
   *  status + code alone cannot express — the 409 `impact` summary is
   *  the case that matters: the conflict screen needs the affected
   *  appointment count and the list of affected doctors, and neither is
   *  derivable from `code`. */
  readonly body: ApiErrorBody;
  constructor(status: number, code: string, body: ApiErrorBody = {}) {
    super(`api_${status}:${code}`);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

// ─── Dev fallback header (E1-S0-ui) ────────────────────────────────────

const ADMIN_CLAIM = {
  sub: 'admin-main',
  role: 'admin',
  branch_ids: ['__clinic_anchor__'],
  scope: 'clinic',
} as const;
const ADMIN_CLAIM_HEADER = JSON.stringify(ADMIN_CLAIM);

// ─── Token store (private; auth/store.ts reads / writes) ───────────────

const TOKEN_KEY = 'medislot.auth';

/**
 * What the stored session looks like to the transport.
 *
 *   'none'     — no `medislot.auth` key at all. A cold load with no
 *                previous session; the dev admin fallback may apply.
 *   'expired'  — a session exists but its token is unusable (expired,
 *                malformed, or within 60s of expiry). The session is
 *                REAL, so the dev fallback must NOT apply: sending the
 *                admin claim instead would silently impersonate a
 *                privileged role and the call would be rejected with
 *                a confusing `forbidden_role` (or worse, succeed with
 *                the wrong authority). We send no credential and let
 *                the API answer 401, which the store turns into a
 *                sign-out.
 *   'valid'    — a usable token; the value is the token itself.
 */
type StoredSession =
  | { kind: 'none' }
  | { kind: 'expired' }
  | { kind: 'valid'; token: string };

function readSession(): StoredSession {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    if (!raw) return { kind: 'none' };
    const parsed = JSON.parse(raw) as { token?: unknown; expires_at?: unknown };
    if (
      typeof parsed.token !== 'string' ||
      typeof parsed.expires_at !== 'string'
    ) {
      // The key exists but is not a usable session. Treat it as a real
      // (broken) session rather than "no session" — the user believes
      // they are signed in and must be told to sign in again.
      return { kind: 'expired' };
    }
    // Drop tokens 60s before they expire so a request in flight doesn't get
    // 401'd mid-call.
    if (Date.parse(parsed.expires_at) - 60_000 < Date.now()) {
      return { kind: 'expired' };
    }
    return { kind: 'valid', token: parsed.token };
  } catch {
    // Unparseable JSON in the key → same reasoning as above: a broken
    // session, not an absent one.
    return { kind: 'expired' };
  }
}

let onUnauthorized: (() => void) | null = null;

/** Register a callback that fires when the API returns 401. The auth
 *  store uses this to clear localStorage and re-route to the login page. */
export function setOnUnauthorized(cb: (() => void) | null): void {
  onUnauthorized = cb;
}

// ─── request() ─────────────────────────────────────────────────────────

/**
 * Options for a single request.
 *
 * `treat401AsAuthFailure` marks a request as an AUTH ATTEMPT rather
 * than an authenticated call. The two are handled differently:
 *
 *   - An authenticated call that gets a 401 means the session died
 *     (expired, revoked). The app must sign the user out and send
 *     them back to the login screen.
 *   - An AUTH ATTEMPT that gets a 401 means the credentials were
 *     wrong. There is no session to sign out of, and the login form
 *     must stay on screen to show the error.
 *
 * Without this distinction a wrong password signed the user out of
 * the form itself: the 401 fired the `onUnauthorized` callback, which
 * called `logout()`, which reset the hash to the chooser and
 * unmounted `StaffLoginPage` — so the "invalid_credentials" banner
 * never rendered and the user was bounced to a blank chooser with no
 * explanation.
 */
interface RequestOptions extends RequestInit {
  /**
   * True when this request is an attempt to ESTABLISH a session
   * (sign-in, OTP verification). A 401 is then a credentials
   * failure, not an expired session, and must not sign the user out.
   */
  treat401AsAuthFailure?: boolean;
}

async function request<T>(
  path: string,
  init: RequestOptions = {},
): Promise<T> {
  const { treat401AsAuthFailure, ...rest } = init;
  const session = readSession();
  const authHeader: HeadersInit =
    session.kind === 'valid'
      ? { authorization: `Bearer ${session.token}` }
      : session.kind === 'none'
        ? // Dev fallback: no session at all. Lets the UI boot against a
          // backend that has no auth requirement (the E1-S0-ui
          // scaffolding). NEVER used when a session exists — see
          // `StoredSession` for why.
          { 'x-auth-claim': ADMIN_CLAIM_HEADER }
        : // A session exists but is unusable. Send NO credential: the
          // API answers 401, `onUnauthorized` fires, and the store
          // clears the session and re-routes to the login page. Sending
          // the admin claim here would impersonate a privileged role
          // and surface as a baffling `forbidden_role` (or, worse,
          // succeed with authority the user does not have).
          {};

  const res = await fetch(`${API_BASE}${path}`, {
    ...rest,
    headers: {
      ...authHeader,
      'content-type': 'application/json',
      ...(rest.headers ?? {}),
    },
  });

  if (res.status === 401) {
    // A 401 on an AUTH ATTEMPT is a credentials failure, not an
    // expired session — do NOT sign the user out, or the login form
    // is unmounted before it can show the error.
    if (!treat401AsAuthFailure) onUnauthorized?.();
    const body = await readErrorBody(res);
    const code =
      typeof body['error'] === 'string' ? (body['error'] as string) : 'unauthenticated';
    throw new ApiError(401, code, body);
  }

  if (!res.ok) {
    const body = await readErrorBody(res);
    const code =
      typeof body['error'] === 'string' ? (body['error'] as string) : 'unknown_error';
    throw new ApiError(res.status, code, body);
  }
  return (await res.json()) as T;
}

/** Parse a failed response's body. A non-JSON body (an HTML error page
 *  from a proxy, an empty 204-shaped body) yields an empty object rather
 *  than throwing — the status + code are still useful on their own. */
async function readErrorBody(res: Response): Promise<ApiErrorBody> {
  try {
    const parsed = (await res.json()) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as ApiErrorBody;
    }
  } catch {
    // Body wasn't JSON — fall through to the empty body.
  }
  return {};
}

// ─── Endpoints ─────────────────────────────────────────────────────────

export function getClinic(): Promise<ClinicDto> {
  return request<ClinicDto>('/admin/clinic', { method: 'GET' });
}

export function patchClinic(name: string): Promise<ClinicDto> {
  return request<ClinicDto>('/admin/clinic', {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  });
}

/**
 * Staff login.
 *
 * `password` is optional. When supplied, the API verifies it against the
 * account's stored bcrypt hash and the login works in every environment.
 * When omitted, the API falls back to the dev-only email-only path,
 * which is refused outside dev/test.
 */
export function loginStaff(input: {
  role: 'admin' | 'doctor' | 'receptionist';
  email: string;
  password?: string;
}): Promise<LoginResponse> {
  return request<LoginResponse>('/auth/login/staff', {
    method: 'POST',
    body: JSON.stringify(input),
    // A 401 here means "wrong credentials" — the form must stay on
    // screen and show the error, not sign the user out.
    treat401AsAuthFailure: true,
  });
}

export function verifyPatientOtp(input: {
  phone: string;
  code: string;
}): Promise<LoginResponse> {
  return request<LoginResponse>('/patient/otp/verify-now', {
    method: 'POST',
    body: JSON.stringify(input),
    // Same as `loginStaff`: a 401 is a bad OTP, not a dead session.
    treat401AsAuthFailure: true,
  });
}

export function getMe(): Promise<LoginResponse> {
  return request<LoginResponse>('/auth/me', { method: 'GET' });
}

// ─── Branches (E1-S1) ────────────────────────────────────────────────

export interface BranchDto {
  id: string;
  clinic_id: string;
  name: string;
  active: boolean;
  /** IANA timezone. The branch's wall-clock zone for hours + slots. */
  tz: string;
  /** Street address. Nullable — a branch may not have one yet. */
  address: string | null;
  created_at: string;
  updated_at: string;
}

export function listBranches(
  filter?: 'active' | 'inactive',
): Promise<BranchDto[]> {
  const qs = filter ? `?active=${filter === 'active' ? 'true' : 'false'}` : '';
  return request<BranchDto[]>(`/admin/branches${qs}`, { method: 'GET' });
}

// ─── Admin dashboard stats ─────────────────────────────────────
//
// The admin dashboards used to derive their counts from a hash of
// the entity id, so the numbers looked plausible but were not
// real. `GET /admin/stats` answers the same questions from the
// actual tables.

export interface AdminStatsBranch {
  id: string;
  doctor_count: number;
  future_appointment_count: number;
}

export interface AdminStatsDoctor {
  id: string;
  specialty: string | null;
  future_appointment_count: number;
}

export interface AdminStatsReceptionist {
  id: string;
  appointments_today: number;
}

export interface AdminStatsAppointmentType {
  id: string;
  bookings_count: number;
}

export interface AdminStats {
  branches: AdminStatsBranch[];
  doctors: AdminStatsDoctor[];
  receptionists: AdminStatsReceptionist[];
  appointment_types: AdminStatsAppointmentType[];
}

export function getAdminStats(): Promise<AdminStats> {
  return request<AdminStats>('/admin/stats', { method: 'GET' });
}

export function getBranch(id: string): Promise<BranchDto> {
  return request<BranchDto>(`/admin/branches/${id}`, { method: 'GET' });
}

export function createBranch(name: string): Promise<BranchDto> {
  return request<BranchDto>('/admin/branches', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

export function patchBranch(
  id: string,
  body: { name?: string; active?: boolean; address?: string | null; tz?: string },
): Promise<BranchDto> {
  return request<BranchDto>(`/admin/branches/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

// ─── Branch hours (E1-S2) ─────────────────────────────────────────

export interface HoursRow {
  day_of_week: number; // 0..6 (Sun..Sat)
  open_time: string | null; // HH:MM (24h)
  close_time: string | null; // HH:MM (24h)
  is_closed: boolean;
}

export interface BranchHoursDto {
  branch_id: string;
  tz: string;
  address: string | null;
  hours: HoursRow[];
}

export interface AffectedDoctor {
  doctor_id: string;
  doctor_name: string;
  count: number;
}

export interface AffectedAppointment {
  appointment_id: string;
  start_datetime: string;
  end_datetime: string;
  doctor_id: string;
  appointment_type_id: string;
  reason: 'closed_day' | 'before_open_or_after_close';
}

export interface HoursImpactSummary {
  count_affected: number;
  affected?: AffectedAppointment[];
  affected_doctors: AffectedDoctor[];
  requires_doctor_acknowledgement: boolean;
}

export interface BranchHoursCommitResponse {
  branch: { id: string; tz: string; address: string | null; updated_at: string };
  hours: HoursRow[];
  impact: { count_affected: number; requires_doctor_acknowledgement: boolean };
}

export function getBranchHours(branchId: string): Promise<BranchHoursDto> {
  return request<BranchHoursDto>(`/admin/branches/${branchId}/hours`, {
    method: 'GET',
  });
}

export function previewBranchHoursImpact(
  branchId: string,
  hours: HoursRow[],
  includeAffected = false,
): Promise<HoursImpactSummary> {
  const qs = includeAffected ? '?include_affected=true' : '';
  return request<HoursImpactSummary>(
    `/admin/branches/${branchId}/hours-impact${qs}`,
    {
      method: 'POST',
      body: JSON.stringify({ hours }),
    },
  );
}

export function patchBranchHours(
  branchId: string,
  body: { hours?: HoursRow[]; address?: string | null; tz?: string },
  acknowledgeDoctorImpact = false,
): Promise<BranchHoursCommitResponse> {
  const qs = acknowledgeDoctorImpact ? '?acknowledge_doctor_impact=true' : '';
  return request<BranchHoursCommitResponse>(
    `/admin/branches/${branchId}/hours${qs}`,
    {
      method: 'PATCH',
      body: JSON.stringify(body),
    },
  );
}

// ─── Recurring series (E6-S1) ────────────────────────────────
//
// The preview route is READ-ONLY: it validates every occurrence of the
// series in isolation and returns which ones would be created and which
// would be skipped (with a reason). The confirm route takes the
// `preview_id` the preview returned — it re-validates and creates the
// rows, so the client never re-sends the series shape.

export type RecurrenceKind = 'weekly' | 'every_two_weeks' | 'custom_days';

export interface RecurringSeriesInput {
  doctor_id: string;
  branch_id: string;
  appointment_type_id: string;
  patient_phone: string;
  patient_first_name: string | null;
  recurrence_kind: RecurrenceKind;
  recurrence_interval_days: number;
  /** YYYY-MM-DD in the branch's timezone. */
  start_date: string;
  /** HH:MM in the branch's timezone. */
  time_of_day: string;
  duration_minutes: number;
  occurrences_or_until_date: number;
}

export interface RecurringOccurrence {
  index: number;
  start_datetime: string;
  end_datetime: string;
  local_date: string;
}

export interface RecurringSkippedOccurrence extends RecurringOccurrence {
  reason: string;
}

export interface RecurringPreviewResponse {
  /** Handle for `POST /recurring/confirm`. */
  preview_id: string;
  branch: { id: string; tz: string };
  recurrence: {
    kind: RecurrenceKind;
    interval_days: number;
    start_date: string;
    time_of_day: string;
    duration_minutes: number;
  };
  will_create: RecurringOccurrence[];
  skipped_with_reason: RecurringSkippedOccurrence[];
}

export interface RecurringCreatedOccurrence {
  id: string;
  occurrence_index: number;
  start_datetime: string;
  end_datetime: string;
  local_date: string;
}

export interface RecurringSkippedAtConfirm {
  occurrence_index: number;
  start_datetime: string;
  end_datetime: string;
  local_date: string;
  reason: string;
}

export interface RecurringConfirmResponse {
  series_id: string;
  created: RecurringCreatedOccurrence[];
  skipped: RecurringSkippedAtConfirm[];
}

export function previewRecurringSeries(
  body: RecurringSeriesInput,
): Promise<RecurringPreviewResponse> {
  return request<RecurringPreviewResponse>('/recurring/preview', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function confirmRecurringSeries(
  previewId: string,
): Promise<RecurringConfirmResponse> {
  return request<RecurringConfirmResponse>('/recurring/confirm', {
    method: 'POST',
    body: JSON.stringify({ preview_id: previewId }),
  });
}

// ─── Receptionists (E1-S4) ─────────────────────────────────────

export interface ReceptionistBranchDto {
  id: string;
  name: string;
  tz: string;
  active: boolean;
}

export interface ReceptionistWithBranchDto {
  id: string;
  branch_id: string;
  full_name: string;
  email: string;
  active: boolean;
  branch: ReceptionistBranchDto;
  created_at: string;
  updated_at: string;
}

export interface ReceptionistPatchResponse extends ReceptionistWithBranchDto {
  warning: string | null;
  future_appointment_count: number;
}

export function listReceptionists(filter?: {
  active?: boolean;
  branch_id?: string;
}): Promise<ReceptionistWithBranchDto[]> {
  const params: string[] = [];
  if (typeof filter?.active === 'boolean') {
    params.push(`active=${filter.active ? 'true' : 'false'}`);
  }
  if (filter?.branch_id) {
    params.push(`branch_id=${encodeURIComponent(filter.branch_id)}`);
  }
  const qs = params.length > 0 ? `?${params.join('&')}` : '';
  return request<ReceptionistWithBranchDto[]>(`/admin/receptionists${qs}`, {
    method: 'GET',
  });
}

export function getReceptionist(id: string): Promise<ReceptionistWithBranchDto> {
  return request<ReceptionistWithBranchDto>(
    `/admin/receptionists/${id}`,
    { method: 'GET' },
  );
}

export function createReceptionist(input: {
  full_name: string;
  email: string;
  branch_id: string;
}): Promise<ReceptionistWithBranchDto> {
  return request<ReceptionistWithBranchDto>('/admin/receptionists', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function patchReceptionist(
  id: string,
  body: { full_name?: string; active?: boolean; branch_id?: string },
): Promise<ReceptionistPatchResponse> {
  return request<ReceptionistPatchResponse>(`/admin/receptionists/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

// ─── Doctors (E1-S3) ────────────────────────────────────────

export interface DoctorBranchDto {
  id: string;
  name: string;
  tz: string;
  active: boolean;
}

export interface DoctorWithBranchesDto {
  id: string;
  clinic_id: string;
  full_name: string;
  email: string;
  active: boolean;
  /** E7-UX. Nullable — the card renders "Not set" when it is null. */
  specialty: string | null;
  branches: DoctorBranchDto[];
  created_at: string;
  updated_at: string;
}

// The PATCH response shape carries `warning` + `future_appointment_count`
// when the deactivate hit future-appointment territory. The route only
// emits `warning` when non-null (admin-branch-doctors.ts:586-588), so the
// client treats it as optional.
export interface DoctorPatchResponse extends DoctorWithBranchesDto {
  warning?: string | null;
  future_appointment_count?: number;
}

export function listDoctors(filter?: {
  active?: boolean;
  branch_id?: string;
}): Promise<DoctorWithBranchesDto[]> {
  const params: string[] = [];
  if (typeof filter?.active === 'boolean') {
    params.push(`active=${filter.active ? 'true' : 'false'}`);
  }
  if (filter?.branch_id) {
    params.push(`branch_id=${encodeURIComponent(filter.branch_id)}`);
  }
  const qs = params.length > 0 ? `?${params.join('&')}` : '';
  return request<DoctorWithBranchesDto[]>(`/admin/doctors${qs}`, {
    method: 'GET',
  });
}

export function getDoctor(id: string): Promise<DoctorWithBranchesDto> {
  return request<DoctorWithBranchesDto>(
    `/admin/doctors/${id}`,
    { method: 'GET' },
  );
}

export function createDoctor(input: {
  full_name: string;
  email: string;
  branch_ids: string[];
  /** E7-UX. Optional — omit to leave it unset. */
  specialty?: string | null;
}): Promise<DoctorWithBranchesDto> {
  return request<DoctorWithBranchesDto>('/admin/doctors', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function patchDoctor(
  id: string,
  body: { full_name?: string; active?: boolean; specialty?: string | null },
): Promise<DoctorPatchResponse> {
  return request<DoctorPatchResponse>(`/admin/doctors/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export function putDoctorBranches(
  id: string,
  branchIds: string[],
): Promise<DoctorWithBranchesDto> {
  return request<DoctorWithBranchesDto>(
    `/admin/doctors/${id}/branches`,
    {
      method: 'PUT',
      body: JSON.stringify({ branch_ids: branchIds }),
    },
  );
}

// ─── Doctor schedule (E2-S1) ───────────────────────────────

export interface ScheduleRowDto {
  branch_id: string;
  day_of_week: number; // 0..6 (Sun..Sat)
  start_time: string; // HH:MM:SS
  end_time: string; // HH:MM:SS
  effective_from: string; // YYYY-MM-DD
  effective_to: string | null; // YYYY-MM-DD or null
}

export interface DoctorScheduleDto {
  doctor_id: string;
  schedule: ScheduleRowDto[];
}

export interface AffectedScheduleAppointment {
  id: string;
  patient_phone_masked: string;
  doctor_id: string;
  branch_id: string;
  start_datetime: string;
  end_datetime: string;
  status: string;
}

export interface DoctorScheduleImpactResponse {
  future_appointment_count: number;
  affected_appointments: AffectedScheduleAppointment[];
}

export interface DoctorScheduleCommitResponse {
  inserted_count: number;
  schedule: ScheduleRowDto[];
}

export function getDoctorSchedule(doctorId: string): Promise<DoctorScheduleDto> {
  return request<DoctorScheduleDto>(
    `/admin/doctors/${doctorId}/schedule`,
    { method: 'GET' },
  );
}

export function previewDoctorScheduleImpact(
  doctorId: string,
  rows: ScheduleRowDto[],
): Promise<DoctorScheduleImpactResponse> {
  return request<DoctorScheduleImpactResponse>(
    `/admin/doctors/${doctorId}/schedule-impact`,
    {
      method: 'POST',
      body: JSON.stringify({ rows }),
    },
  );
}

export function postDoctorSchedule(
  doctorId: string,
  rows: ScheduleRowDto[],
): Promise<DoctorScheduleCommitResponse> {
  return request<DoctorScheduleCommitResponse>(
    `/admin/doctors/${doctorId}/schedule`,
    {
      method: 'POST',
      body: JSON.stringify({ rows }),
    },
  );
}

// ─── Doctor blocks (E2-S2) ────────────────────────────────

export interface DoctorBlockDto {
  id: string;
  doctor_id: string;
  branch_id: string;
  start_datetime: string;
  end_datetime: string;
  reason: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface DoctorBlockImpactResponse {
  future_appointment_count: number;
  affected_appointments: AffectedScheduleAppointment[];
}

export interface CreateDoctorBlockInput {
  branch_id: string;
  start_datetime: string;
  end_datetime: string;
  reason: string | null;
}

export function listDoctorBlocks(
  doctorId: string,
  filter?: { from?: string; to?: string },
): Promise<{ blocks: DoctorBlockDto[] }> {
  const params: string[] = [];
  if (filter?.from) params.push(`from=${encodeURIComponent(filter.from)}`);
  if (filter?.to) params.push(`to=${encodeURIComponent(filter.to)}`);
  const qs = params.length > 0 ? `?${params.join('&')}` : '';
  return request<{ blocks: DoctorBlockDto[] }>(
    `/admin/doctors/${doctorId}/blocks${qs}`,
    { method: 'GET' },
  );
}

export function previewDoctorBlockImpact(
  doctorId: string,
  body: CreateDoctorBlockInput,
): Promise<DoctorBlockImpactResponse> {
  return request<DoctorBlockImpactResponse>(
    `/admin/doctors/${doctorId}/blocks-impact`,
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
  );
}

export function createDoctorBlock(
  doctorId: string,
  body: CreateDoctorBlockInput,
): Promise<DoctorBlockDto> {
  return request<DoctorBlockDto>(`/admin/doctors/${doctorId}/blocks`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function deleteDoctorBlock(
  doctorId: string,
  blockId: string,
): Promise<void> {
  return request<void>(
    `/admin/doctors/${doctorId}/blocks/${blockId}`,
    { method: 'DELETE' },
  );
}

// ─── Public catalog (E3-ui) ───────────────────────────────

export interface PublicDoctorDto {
  id: string;
  full_name: string;
  /** E7-UX: shown on the doctor card and the doctor-pill. Nullable
   *  (admin hasn't filled it in yet) — UI falls back to "General
   *  practice". */
  specialty: string | null;
  /** E7-UX: derived count of `doctor_branch` rows for this doctor.
   *  Used to render "N branches" on the doctor card without a
   *  separate round-trip. */
  branch_count: number;
}

export interface PublicBranchHourDto {
  /** 0 = Sun, 1 = Mon, …, 6 = Sat (Postgres EXTRACT(dow …)). */
  day_of_week: number;
  /** "HH:MM" in branch-local wall-clock time, or null on a closed day. */
  open_time: string | null;
  /** "HH:MM" in branch-local wall-clock time, or null on a closed day. */
  close_time: string | null;
  is_closed: boolean;
}

export interface PublicBranchDto {
  id: string;
  name: string;
  tz: string;
  /** E7-UX: 2-line street address. Nullable (pre-0015 branch). */
  address: string | null;
  /** E7-UX: 7-row weekly hours derived from `branch_weekly_hours`.
   *  Empty array if no rows are present (pre-0015 branch). */
  hours: PublicBranchHourDto[];
}

export interface PublicAppointmentTypeDto {
  id: string;
  name: string;
  duration_minutes: number;
  /** E7-UX: one-line description shown on the type card. Nullable
   *  (admin hasn't filled it in yet) — UI falls back to a generic
   *  string or hides the line. */
  description: string | null;
}

export function listPublicDoctors(): Promise<{ doctors: PublicDoctorDto[] }> {
  return request<{ doctors: PublicDoctorDto[] }>('/public/doctors', {
    method: 'GET',
  });
}

export function listPublicBranches(doctorId?: string): Promise<{ branches: PublicBranchDto[] }> {
  const qs = doctorId ? `?doctor_id=${encodeURIComponent(doctorId)}` : '';
  return request<{ branches: PublicBranchDto[] }>(`/public/branches${qs}`, {
    method: 'GET',
  });
}

export function listPublicAppointmentTypes(): Promise<{
  appointment_types: PublicAppointmentTypeDto[];
}> {
  return request<{ appointment_types: PublicAppointmentTypeDto[] }>(
    '/public/appointment-types',
    { method: 'GET' },
  );
}

// ─── Staff catalog (doctor / receptionist pickers) ───────────────
//
// The doctor and receptionist screens need a doctor picker and an
// appointment-type picker. They used to call the `/admin/*` catalog
// routes for that, but those are gated by `adminScope` and return 403
// `forbidden_role` for a doctor or receptionist — so the pickers
// silently stayed EMPTY and the walk-in booking flow, the availability
// browser, and the doctor's recurring-series form were unusable for
// exactly the two roles that use them.
//
// `/staff-catalog/*` returns the SAME DTO shapes as the admin catalog
// routes (so the existing filtering logic is unchanged) but is open to
// any authenticated caller.

export function listStaffDoctors(filter?: {
  active?: boolean;
  branch_id?: string;
}): Promise<DoctorWithBranchesDto[]> {
  const params: string[] = [];
  if (typeof filter?.active === 'boolean') {
    params.push(`active=${filter.active ? 'true' : 'false'}`);
  }
  if (filter?.branch_id) {
    params.push(`branch_id=${encodeURIComponent(filter.branch_id)}`);
  }
  const qs = params.length > 0 ? `?${params.join('&')}` : '';
  return request<DoctorWithBranchesDto[]>(`/staff-catalog/doctors${qs}`, {
    method: 'GET',
  });
}

export function listStaffAppointmentTypes(filter?: {
  active?: boolean;
}): Promise<AppointmentTypeDto[]> {
  const qs =
    typeof filter?.active === 'boolean'
      ? `?active=${filter.active ? 'true' : 'false'}`
      : '';
  return request<AppointmentTypeDto[]>(`/staff-catalog/appointment-types${qs}`, {
    method: 'GET',
  });
}

export function listStaffBranches(
  filter?: 'active' | 'inactive',
): Promise<BranchDto[]> {
  const qs = filter ? `?active=${filter === 'active' ? 'true' : 'false'}` : '';
  return request<BranchDto[]>(`/staff-catalog/branches${qs}`, {
    method: 'GET',
  });
}

// ─── Availability + bookings (E3-S1 / E3-S2) ───────────────────

export interface AvailabilitySlot {
  start_datetime: string;
  end_datetime: string;
}

export interface AvailabilityResponse {
  slots: AvailabilitySlot[];
  reason?:
    | 'past_date'
    | 'outside_30d_window'
    | 'branch_closed'
    | 'doctor_unavailable'
    | 'no_fit'
    | 'all_booked'
    | 'all_blocked'
    | 'patient_has_future_with_doctor'
    | null;
}

export function getAvailability(input: {
  doctor_id: string;
  branch_id: string;
  date: string; // YYYY-MM-DD UTC
  appointment_type_id: string;
  patient_phone?: string;
  /** The appointment being rescheduled. The server excludes this row
   *  from the FR-027 / FR-029 / existing-appointment checks so the
   *  appointment does not collide with itself. Without it the preview
   *  returns zero slots for the patient who holds the appointment. */
  exclude_appointment_id?: string;
}): Promise<AvailabilityResponse> {
  const params: string[] = [
    `doctor_id=${encodeURIComponent(input.doctor_id)}`,
    `branch_id=${encodeURIComponent(input.branch_id)}`,
    `date=${encodeURIComponent(input.date)}`,
    `appointment_type_id=${encodeURIComponent(input.appointment_type_id)}`,
  ];
  if (input.patient_phone) {
    params.push(`patient_phone=${encodeURIComponent(input.patient_phone)}`);
  }
  if (input.exclude_appointment_id) {
    params.push(
      `exclude_appointment_id=${encodeURIComponent(input.exclude_appointment_id)}`,
    );
  }
  return request<AvailabilityResponse>(
    `/availability?${params.join('&')}`,
    { method: 'GET' },
  );
}

export interface CreatedAppointment {
  id: string;
  doctor_id: string;
  branch_id: string;
  appointment_type_id: string;
  start_datetime: string;
  end_datetime: string;
  status: 'Scheduled';
  tz: string;
  patient_id: string;
}

export interface CreatedBookingResponse {
  appointment: CreatedAppointment;
}

export function createBooking(input: {
  doctor_id: string;
  branch_id: string;
  appointment_type_id: string;
  start_datetime: string;
  end_datetime: string;
  slot_duration_minutes: number;
  patient_phone: string;
  patient_name: string;
}): Promise<CreatedBookingResponse> {
  return request<CreatedBookingResponse>('/bookings', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

// ─── Patient profile (E3-S3) ─────────────────────────────────

export interface PatientProfileDto {
  phone_number: string;
  full_name: string | null;
}

export function getPatientProfile(phone: string): Promise<{ patient: PatientProfileDto }> {
  return request<{ patient: PatientProfileDto }>(
    `/patient/profile?phone=${encodeURIComponent(phone)}`,
    { method: 'GET' },
  );
}

export interface AppointmentTypeDto {
  id: string;
  clinic_id: string;
  name: string;
  duration_minutes: number;
  is_active: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
  description: string | null;
}

// PATCH always emits warning + future_appointment_count on the response.
export interface AppointmentTypePatchResponse extends AppointmentTypeDto {
  warning: string | null;
  future_appointment_count: number;
}

export function listAppointmentTypes(
  filter?: { active?: boolean },
): Promise<AppointmentTypeDto[]> {
  const qs =
    typeof filter?.active === 'boolean'
      ? `?active=${filter.active ? 'true' : 'false'}`
      : '';
  return request<AppointmentTypeDto[]>(`/admin/appointment-types${qs}`, {
    method: 'GET',
  });
}

export function getAppointmentType(id: string): Promise<AppointmentTypeDto> {
  return request<AppointmentTypeDto>(`/admin/appointment-types/${id}`, {
    method: 'GET',
  });
}

export function createAppointmentType(input: {
  name: string;
  duration_minutes: number;
  description?: string | null;
}): Promise<AppointmentTypeDto> {
  return request<AppointmentTypeDto>('/admin/appointment-types', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function patchAppointmentType(
  id: string,
  body: {
    name?: string;
    is_active?: boolean;
    description?: string | null;
    duration_minutes?: number;
  },
): Promise<AppointmentTypePatchResponse> {
  return request<AppointmentTypePatchResponse>(
    `/admin/appointment-types/${id}`,
    {
      method: 'PATCH',
      body: JSON.stringify(body),
    },
  );
}

// ─── Receptionist today (E5-S4) ─────────────────────────────────

export type ReceptionistAppointmentStatus =
  | 'Scheduled'
  | 'Cancelled'
  | 'Completed'
  | 'No-show';

export interface ReceptionistTodayAppointment {
  id: string;
  doctor_id: string;
  doctor_name: string;
  // E7-S3 — the API returns `patient_phone` but NOT `patient_name`.
  // The receptionist identifies the patient on arrival by phone.
  patient_phone: string;
  appointment_type_id: string;
  appointment_type_name: string;
  start_datetime: string; // ISO UTC
  end_datetime: string; // ISO UTC
  status: ReceptionistAppointmentStatus;
}

export interface ReceptionistTodayBranch {
  id: string;
  name: string;
  tz: string;
}

export interface ReceptionistTodayFilters {
  doctor_id: string | null;
  status: ReceptionistAppointmentStatus | null;
  date: string | null;
}

export interface ReceptionistTodayResponse {
  date: string; // YYYY-MM-DD in branch.tz
  branch: ReceptionistTodayBranch;
  filters: ReceptionistTodayFilters;
  appointments: ReceptionistTodayAppointment[];
}

export interface ReceptionistTodayInput {
  status?: ReceptionistAppointmentStatus;
  doctor_id?: string;
  date?: string; // YYYY-MM-DD in branch.tz
}

export function getReceptionistToday(
  input: ReceptionistTodayInput = {},
): Promise<ReceptionistTodayResponse> {
  const params: string[] = [];
  if (input.status) params.push(`status=${encodeURIComponent(input.status)}`);
  if (input.doctor_id) {
    params.push(`doctor_id=${encodeURIComponent(input.doctor_id)}`);
  }
  if (input.date) params.push(`date=${encodeURIComponent(input.date)}`);
  const qs = params.length > 0 ? `?${params.join('&')}` : '';
  return request<ReceptionistTodayResponse>(
    `/reception/branch/today${qs}`,
    { method: 'GET' },
  );
}

// ─── Receptionist day schedule (F-15) ────────────────────────────

/** One booked slot in the receptionist's day calendar.
 *
 *  The patient is identified by first-name initial only (F-15) —
 *  there is no name and no phone on this shape. */
export interface ReceptionScheduleBooked {
  id: string;
  doctor_id: string;
  doctor_name: string;
  appointment_type_id: string | null;
  appointment_type_name: string | null;
  patient_initial: string;
  start_datetime: string;
  end_datetime: string;
}

export interface ReceptionScheduleResponse {
  date: string; // YYYY-MM-DD in branch.tz
  branch: { id: string; name: string; tz: string };
  booked: ReceptionScheduleBooked[];
}

export function getReceptionSchedule(input: {
  date?: string;
  doctor_id?: string;
} = {}): Promise<ReceptionScheduleResponse> {
  const params: string[] = [];
  if (input.date) params.push(`date=${encodeURIComponent(input.date)}`);
  if (input.doctor_id) {
    params.push(`doctor_id=${encodeURIComponent(input.doctor_id)}`);
  }
  const qs = params.length > 0 ? `?${params.join('&')}` : '';
  return request<ReceptionScheduleResponse>(
    `/reception/branch/schedule${qs}`,
    { method: 'GET' },
  );
}

// ─── Receptionist cancel (E5-S3) ─────────────────────────────────

export interface ReceptionistCancelInput {
  appointment_id: string;
  reason: string;
}

export interface ReceptionistCancelAppointment {
  id: string;
  branch_id: string;
  doctor_id: string;
  appointment_type_id: string;
  start_datetime: string;
  end_datetime: string;
  status: 'Cancelled';
}

export interface ReceptionistCancelResponse {
  appointment: ReceptionistCancelAppointment;
}

export function receptionistCancel(
  input: ReceptionistCancelInput,
): Promise<ReceptionistCancelResponse> {
  return request<ReceptionistCancelResponse>(
    `/reception/appointments/${encodeURIComponent(input.appointment_id)}/cancel`,
    {
      method: 'POST',
      body: JSON.stringify({ reason: input.reason }),
    },
  );
}

// ─── Patient self-service (E4-S1 / E4-S2 / E4-S3 / E4-S4) ─────

export interface PatientAppointmentDto {
  id: string;
  doctor_id: string;
  branch_id: string;
  appointment_type_id: string;
  start_datetime: string;
  end_datetime: string;
  status: 'Scheduled';
  tz: string;
}

export interface PatientAppointmentsResponse {
  appointments: PatientAppointmentDto[];
}

export function listPatientAppointments(): Promise<PatientAppointmentsResponse> {
  return request<PatientAppointmentsResponse>('/patient/appointments', {
    method: 'GET',
  });
}

// E4-S2 — patient cancel. Server returns 404 with a typed envelope
// for terminal-state rows; the route is the executor (atomic, audited).
export interface PatientCancelAppointment {
  id: string;
  branch_id: string;
  doctor_id: string;
  appointment_type_id: string;
  start_datetime: string;
  end_datetime: string;
  status: 'Cancelled';
}

export interface PatientCancelResponse {
  appointment: PatientCancelAppointment;
}

export function patientCancel(
  appointmentId: string,
): Promise<PatientCancelResponse> {
  return request<PatientCancelResponse>(
    `/patient/appointments/${encodeURIComponent(appointmentId)}/cancel`,
    { method: 'POST' },
  );
}

// ─── Patient recurring series (E6-S4, mock 33) ───────────────────

export interface RecurringSeriesOccurrence {
  id: string;
  start_datetime: string;
  end_datetime: string;
  status: 'Scheduled' | 'Cancelled' | 'Completed' | 'No-show';
}

export interface PatientRecurringSeries {
  series_id: string;
  doctor_id: string;
  doctor_name: string;
  branch_id: string;
  branch_name: string;
  tz: string;
  appointment_type_id: string | null;
  appointment_type_name: string | null;
  duration_minutes: number | null;
  occurrence_count: number;
  series_start: string;
  occurrences: RecurringSeriesOccurrence[];
}

export function getPatientRecurringSeries(): Promise<{
  series: PatientRecurringSeries[];
}> {
  return request<{ series: PatientRecurringSeries[] }>(
    '/patient/recurring-series',
    { method: 'GET' },
  );
}

// ─── Doctor recurring series (mock 40) ──────────────────────────

export interface DoctorRecurringSeries {
  series_id: string;
  doctor_id: string;
  doctor_name: string;
  branch_id: string;
  branch_name: string;
  tz: string;
  appointment_type_id: string | null;
  appointment_type_name: string | null;
  duration_minutes: number | null;
  patient_phone: string;
  series_start: string;
  created_at: string;
  created_by: string;
  occurrence_count: number;
  scheduled_count: number;
  cancelled_count: number;
  completed_count: number;
  occurrences: RecurringSeriesOccurrence[];
}

export interface DoctorRecurringAuditRow {
  id: string;
  appointment_id: string | null;
  actor_role: string;
  actor_id: string;
  event: string;
  payload: Record<string, unknown> | null;
  created_at: string;
}

export interface DoctorRecurringSeriesResponse {
  series: DoctorRecurringSeries;
  audit: DoctorRecurringAuditRow[];
}

export function getDoctorRecurringSeries(
  seriesId: string,
): Promise<DoctorRecurringSeriesResponse> {
  return request<DoctorRecurringSeriesResponse>(
    `/doctor/recurring-series/${encodeURIComponent(seriesId)}`,
    { method: 'GET' },
  );
}

// E4-S3 — patient reschedule. Doctor is locked (FR-040). The body
// carries (new_branch_id, new_appointment_type_id, new_start_datetime,
// new_end_datetime, new_slot_duration_minutes).
export interface PatientRescheduleInput {
  new_branch_id: string;
  new_appointment_type_id: string;
  new_start_datetime: string; // ISO UTC
  new_end_datetime: string; // ISO UTC
  new_slot_duration_minutes: number;
}

export interface PatientRescheduleAppointment {
  id: string;
  branch_id: string;
  doctor_id: string;
  appointment_type_id: string;
  start_datetime: string;
  end_datetime: string;
  status: 'Scheduled';
}

export interface PatientRescheduleResponse {
  appointment: PatientRescheduleAppointment;
}

export function patientReschedule(
  appointmentId: string,
  input: PatientRescheduleInput,
): Promise<PatientRescheduleResponse> {
  return request<PatientRescheduleResponse>(
    `/patient/appointments/${encodeURIComponent(appointmentId)}/reschedule`,
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
  );
}

// E4-S4 — deep-link lookup. Returns `can_cancel` / `can_reschedule`
// so the client can render a "manage your appointment" landing
// after a deep-link redirect.
export interface PatientDeepLinkAppointment {
  id: string;
  branch_id: string;
  doctor_id: string;
  appointment_type_id: string;
  start_datetime: string;
  end_datetime: string;
  status: string;
}

export interface PatientDeepLinkResponse {
  appointment_id: string;
  can_cancel: boolean;
  can_reschedule: boolean;
  appointment: PatientDeepLinkAppointment;
}

export function getPatientDeepLink(
  appointmentId: string,
): Promise<PatientDeepLinkResponse> {
  return request<PatientDeepLinkResponse>(
    `/patient/appointments/${encodeURIComponent(appointmentId)}/deep-link`,
    { method: 'GET' },
  );
}

// ─── Doctor self-service (E6-S2 / E6-S3) ───────────────────

// E6-S3 — affected queue. Read-side counterpart of E1-S2's
// admin impact-preview. Returns the doctor's Scheduled rows
// that fall outside the current `branch_weekly_hours`.
export type DoctorAffectedReason =
  | 'closed_day'
  | 'before_open_or_after_close';

export interface DoctorAffectedAppointment {
  appointment_id: string;
  branch_id: string;
  doctor_id: string;
  patient_phone: string;
  appointment_type_id: string;
  start_datetime: string; // ISO UTC
  end_datetime: string;   // ISO UTC
  status: string;
  /** When the appointment was booked (ISO UTC). Lets the doctor surface
   *  show the REAL booking age. */
  created_at: string;
  reason: DoctorAffectedReason;
}

export interface DoctorAffectedResponse {
  count: number;
  branch_id: string | null;
  date: string | null;
  appointments: DoctorAffectedAppointment[];
}

export interface DoctorAffectedInput {
  branch_id?: string;
  date?: string;
}

export function getDoctorAffected(
  input: DoctorAffectedInput = {},
): Promise<DoctorAffectedResponse> {
  const params = new URLSearchParams();
  if (typeof input.branch_id === 'string' && input.branch_id.length > 0) {
    params.set('branch_id', input.branch_id);
  }
  if (typeof input.date === 'string' && input.date.length > 0) {
    params.set('date', input.date);
  }
  const q = params.toString();
  return request<DoctorAffectedResponse>(
    `/doctor/affected${q.length > 0 ? `?${q}` : ''}`,
    { method: 'GET' },
  );
}

// ─── Doctor today dashboard (mock 12 / doctor.md Act 3) ───────
//
// The doctor's OWN day list. The receptionist's counterpart is
// `/reception/branch/today`, but that one is branch-wide; this one
// is bound to `claim.doctor_id`, so a doctor only ever sees their
// own appointments.
//
// This is the surface from which mark-status, cancel and the audit
// drawer are reachable for ORDINARY appointments. The affected
// queue lists only the rows that fell outside their branch's
// operating hours, so before this endpoint existed those actions
// were effectively unreachable in normal operation.

export type DoctorAppointmentStatus =
  | 'Scheduled'
  | 'Completed'
  | 'Cancelled'
  | 'No-show';

export interface DoctorTodayAppointment {
  id: string;
  branch_id: string;
  branch_name: string;
  /** The branch's IANA timezone — times render in local wall-clock. */
  branch_tz: string;
  doctor_id: string;
  patient_phone: string;
  appointment_type_id: string;
  appointment_type_name: string;
  start_datetime: string; // ISO UTC
  end_datetime: string;   // ISO UTC
  status: DoctorAppointmentStatus;
}

export interface DoctorTodayBranch {
  id: string;
  name: string;
  tz: string;
}

export interface DoctorTodayResponse {
  /** The calendar day (YYYY-MM-DD) the list shows. */
  date: string;
  doctor_id: string;
  branches: DoctorTodayBranch[];
  filters: {
    branch_id: string | null;
    status: string | null;
    date: string | null;
  };
  appointments: DoctorTodayAppointment[];
}

export interface DoctorTodayInput {
  branch_id?: string;
  status?: DoctorAppointmentStatus;
  date?: string;
}

export function getDoctorToday(
  input: DoctorTodayInput = {},
): Promise<DoctorTodayResponse> {
  const params = new URLSearchParams();
  if (typeof input.branch_id === 'string' && input.branch_id.length > 0) {
    params.set('branch_id', input.branch_id);
  }
  if (typeof input.status === 'string' && input.status.length > 0) {
    params.set('status', input.status);
  }
  if (typeof input.date === 'string' && input.date.length > 0) {
    params.set('date', input.date);
  }
  const q = params.toString();
  return request<DoctorTodayResponse>(
    `/doctor/today${q.length > 0 ? `?${q}` : ''}`,
    { method: 'GET' },
  );
}

// ─── Doctor self-service schedule + block time ────────────────
//
// `doctor.md` Act 1 (Schedule editor) and Act 2 (Block time) are
// doctor sections, but the only implementation was the admin-only
// `/admin/doctors/:id/schedule` + `/admin/doctors/:id/blocks`
// (gated by `adminScope`). These client calls hit the new
// doctor-scoped routes, which bind to `claim.doctor_id` server-side.

export interface DoctorScheduleRow {
  branch_id: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
  effective_from: string;
  effective_to: string | null;
}

export interface DoctorScheduleResponse {
  doctor_id: string;
  schedule: DoctorScheduleRow[];
}

export function getMyDoctorSchedule(): Promise<DoctorScheduleResponse> {
  return request<DoctorScheduleResponse>('/doctor/schedule', { method: 'GET' });
}

/** Preview: how many future appointments the proposed schedule would
 *  invalidate. No DB write. */
export interface DoctorScheduleImpactResponse {
  future_appointment_count: number;
  affected_appointments: Array<{
    id: string;
    patient_phone_masked: string;
    doctor_id: string;
    branch_id: string;
    start_datetime: string;
    end_datetime: string;
    status: string;
  }>;
}

export function previewMyDoctorSchedule(
  rows: DoctorScheduleRow[],
): Promise<DoctorScheduleImpactResponse> {
  return request<DoctorScheduleImpactResponse>('/doctor/schedule-impact', {
    method: 'POST',
    body: JSON.stringify({ rows }),
  });
}

/** Full-set replace. 409 `schedule_invalidates_future_appointments` when
 *  the proposed hours would orphan a future booking.
 *
 *  `acknowledge` is the doctor's explicit "save anyway" — without it the
 *  API refuses the write and returns the affected appointments so the
 *  doctor can decide. */
export function saveMyDoctorSchedule(
  rows: DoctorScheduleRow[],
  acknowledge = false,
): Promise<{ inserted_count: number; schedule: DoctorScheduleRow[] }> {
  return request<{ inserted_count: number; schedule: DoctorScheduleRow[] }>(
    '/doctor/schedule',
    { method: 'POST', body: JSON.stringify({ rows, acknowledge }) },
  );
}

export interface DoctorBlock {
  id: string;
  doctor_id: string;
  branch_id: string;
  start_datetime: string;
  end_datetime: string;
  reason: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export function listMyDoctorBlocks(input?: {
  from?: string;
  to?: string;
}): Promise<{ blocks: DoctorBlock[] }> {
  const params = new URLSearchParams();
  if (input?.from) params.set('from', input.from);
  if (input?.to) params.set('to', input.to);
  const q = params.toString();
  return request<{ blocks: DoctorBlock[] }>(
    `/doctor/blocks${q.length > 0 ? `?${q}` : ''}`,
    { method: 'GET' },
  );
}

export interface DoctorBlockInput {
  branch_id: string;
  start_datetime: string;
  end_datetime: string;
  reason?: string;
}

export function previewMyDoctorBlock(
  input: DoctorBlockInput,
): Promise<DoctorScheduleImpactResponse> {
  return request<DoctorScheduleImpactResponse>('/doctor/blocks-impact', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function createMyDoctorBlock(input: DoctorBlockInput): Promise<DoctorBlock> {
  return request<DoctorBlock>('/doctor/blocks', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function deleteMyDoctorBlock(blockId: string): Promise<void> {
  return request<void>(`/doctor/blocks/${encodeURIComponent(blockId)}`, {
    method: 'DELETE',
  });
}

// E6-S2 — doctor move. Atomic two-slot transaction; body schema
// accepts (new_branch_id, new_start_datetime, new_end_datetime)
// only — never a new_doctor_id or new_appointment_type_id
// (BR-058 type lock + FR-040 doctor lock).
export interface DoctorMoveInput {
  new_branch_id: string;
  new_start_datetime: string; // ISO UTC
  new_end_datetime: string;   // ISO UTC
}

export interface DoctorMoveAppointment {
  id: string;
  branch_id: string;
  doctor_id: string;
  appointment_type_id: string;
  start_datetime: string;
  end_datetime: string;
  status: string;
}

export interface DoctorMoveResponse {
  appointment: DoctorMoveAppointment;
}

export function doctorMove(
  appointmentId: string,
  input: DoctorMoveInput,
): Promise<DoctorMoveResponse> {
  return request<DoctorMoveResponse>(
    `/doctor/affected/${encodeURIComponent(appointmentId)}/move`,
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
  );
}

// E5-S1 — staff mark-status (Completed | No-show). The body
// schema accepts `{status: 'Completed' | 'No-show'}` only.
//
// The casing is NOT cosmetic: the DB column is the
// `appointment_status` enum {Scheduled, Completed, Cancelled,
// No-show} — lowercase 's'. The API mirrors the enum verbatim, so
// sending 'No-Show' (capital S) is rejected with 400
// `invalid_status` before the SQL ever runs.
//
// Atomic + GIST-protected (E5-S1 spec). Returns the updated
// appointment row.
export type MarkStatus = 'Completed' | 'No-show';

export interface MarkStatusInput {
  status: MarkStatus;
}

export interface MarkStatusAppointment {
  id: string;
  branch_id: string;
  doctor_id: string;
  appointment_type_id: string;
  start_datetime: string;
  end_datetime: string;
  status: MarkStatus;
}

export interface MarkStatusResponse {
  appointment: MarkStatusAppointment;
}

export function markAppointmentStatus(
  appointmentId: string,
  input: MarkStatusInput,
): Promise<MarkStatusResponse> {
  return request<MarkStatusResponse>(
    `/appointments/${encodeURIComponent(appointmentId)}/mark-status`,
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
  );
}

// E5-S2 — staff doctor cancel. Reason required (FR-035 /
// BR-037). The body schema accepts `{reason: string}`. The
// server trims + caps at 500 chars. The doctor is the actor
// (claim.role === 'doctor', doubly-bound scope).
export interface DoctorCancelInput {
  reason: string;
}

export interface DoctorCancelAppointment {
  id: string;
  branch_id: string;
  doctor_id: string;
  appointment_type_id: string;
  start_datetime: string;
  end_datetime: string;
  status: 'Cancelled';
}

export interface DoctorCancelResponse {
  appointment: DoctorCancelAppointment;
}

export function doctorCancel(
  appointmentId: string,
  input: DoctorCancelInput,
): Promise<DoctorCancelResponse> {
  return request<DoctorCancelResponse>(
    `/appointments/${encodeURIComponent(appointmentId)}/cancel`,
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
  );
}

// ─── Appointment audit reads (E7-S2) ───────────────────────

// E7-S2 — doctor audit drawer (mock 30). Per-appointment
// audit log keyed by appointment_id. Doubly-bound scope:
// claim.role === 'doctor' AND appointment.doctor_id ===
// claim.doctor_id. Same envelope for "doesn't exist" and
// "exists but not yours" (E7-S3 privacy filter).
export interface DoctorAuditRow {
  id: string;
  appointment_id: string | null;
  actor_role: string;
  actor_id: string;
  event: string;
  payload: Record<string, unknown> | null;
  created_at: string; // ISO UTC
}

export interface DoctorAuditResponse {
  appointment_id: string;
  patient_phone: string;
  count: number;
  audit: DoctorAuditRow[];
}

export function getDoctorAppointmentAudit(
  appointmentId: string,
): Promise<DoctorAuditResponse> {
  return request<DoctorAuditResponse>(
    `/doctor/appointments/${encodeURIComponent(appointmentId)}/audit`,
    { method: 'GET' },
  );
}

// E7-S2 — receptionist audit drawer. Receptionist branch-scope.
export interface ReceptionAuditRow {
  id: string;
  appointment_id: string | null;
  actor_role: string;
  actor_id: string;
  event: string;
  payload: Record<string, unknown> | null;
  created_at: string;
}

export interface ReceptionAuditResponse {
  appointment_id: string;
  patient_phone: string;
  count: number;
  audit: ReceptionAuditRow[];
}

export function getReceptionistAppointmentAudit(
  appointmentId: string,
): Promise<ReceptionAuditResponse> {
  return request<ReceptionAuditResponse>(
    `/reception/appointments/${encodeURIComponent(appointmentId)}/audit`,
    { method: 'GET' },
  );
}

// E7-S2 — admin policy envelope (the admin never sees
// appointment-audit per PRD §2.4). The endpoint exists so the
// admin surface doesn't 404 on the spec's expected path.
export interface AdminAuditEnvelope {
  appointments_audit_reads: 'rejected_per_role_policy';
  reason: string;
  reference: string;
  doctor_endpoint: string;
  receptionist_endpoint: string;
  future_work: string;
}

export function getAdminAudit(): Promise<AdminAuditEnvelope> {
  return request<AdminAuditEnvelope>('/admin/audit', { method: 'GET' });
}