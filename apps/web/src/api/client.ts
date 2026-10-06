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

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(`api_${status}:${code}`);
    this.status = status;
    this.code = code;
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

function readTokenFromStorage(): string | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { token?: unknown; expires_at?: unknown };
    if (typeof parsed.token !== 'string' || typeof parsed.expires_at !== 'string') {
      return null;
    }
    // Drop tokens 60s before they expire so a request in flight doesn't get
    // 401'd mid-call.
    if (Date.parse(parsed.expires_at) - 60_000 < Date.now()) {
      return null;
    }
    return parsed.token;
  } catch {
    return null;
  }
}

let onUnauthorized: (() => void) | null = null;

/** Register a callback that fires when the API returns 401. The auth
 *  store uses this to clear localStorage and re-route to the login page. */
export function setOnUnauthorized(cb: (() => void) | null): void {
  onUnauthorized = cb;
}

// ─── request() ─────────────────────────────────────────────────────────

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const bearer = readTokenFromStorage();
  const authHeader: HeadersInit = bearer
    ? { authorization: `Bearer ${bearer}` }
    : { 'x-auth-claim': ADMIN_CLAIM_HEADER };

  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...authHeader,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

  if (res.status === 401) {
    onUnauthorized?.();
    let code = 'unauthenticated';
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === 'string') code = body.error;
    } catch {
      // Body wasn't JSON — keep the default.
    }
    throw new ApiError(401, code);
  }

  if (!res.ok) {
    let code = 'unknown_error';
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === 'string') code = body.error;
    } catch {
      // Body wasn't JSON — keep `unknown_error`.
    }
    throw new ApiError(res.status, code);
  }
  return (await res.json()) as T;
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

export function loginStaff(input: {
  role: 'admin' | 'doctor' | 'receptionist';
  email: string;
}): Promise<LoginResponse> {
  return request<LoginResponse>('/auth/login/staff', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function verifyPatientOtp(input: {
  phone: string;
  code: string;
}): Promise<LoginResponse> {
  return request<LoginResponse>('/patient/otp/verify-now', {
    method: 'POST',
    body: JSON.stringify(input),
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
  created_at: string;
  updated_at: string;
}

export function listBranches(
  filter?: 'active' | 'inactive',
): Promise<BranchDto[]> {
  const qs = filter ? `?active=${filter === 'active' ? 'true' : 'false'}` : '';
  return request<BranchDto[]>(`/admin/branches${qs}`, { method: 'GET' });
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
  body: { name?: string; active?: boolean },
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
}): Promise<DoctorWithBranchesDto> {
  return request<DoctorWithBranchesDto>('/admin/doctors', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function patchDoctor(
  id: string,
  body: { full_name?: string; active?: boolean },
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
}

export interface PublicBranchDto {
  id: string;
  name: string;
  tz: string;
}

export interface PublicAppointmentTypeDto {
  id: string;
  name: string;
  duration_minutes: number;
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
    | null;
}

export function getAvailability(input: {
  doctor_id: string;
  branch_id: string;
  date: string; // YYYY-MM-DD UTC
  appointment_type_id: string;
  patient_phone?: string;
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
}): Promise<AppointmentTypeDto> {
  return request<AppointmentTypeDto>('/admin/appointment-types', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function patchAppointmentType(
  id: string,
  body: { name?: string; is_active?: boolean },
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
  | 'No-Show';

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