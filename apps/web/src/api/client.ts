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