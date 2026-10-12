/**
 * e2e/helpers/api.ts — tiny fetch wrapper for the dev API.
 *
 * Talks to http://localhost:3001 directly. Used by `auth.setup.ts` to
 * obtain a real `StoredAuth` shape (token, claim, expires_at, profile)
 * and by the booking-loop cleanup path (PR 2) to cancel a booking
 * without driving the browser.
 *
 * Why a wrapper and not raw `fetch`: we want one place to add the
 * bearer header, time out, and surface useful errors. A failure inside
 * `auth.setup.ts` is the single worst kind of test bug (the whole
 * suite runs without auth) so we want the error message to be loud.
 *
 * The API base URL is fixed in dev (Vite proxies, but `auth.setup`
 * runs before any browser navigation, so it cannot ride the proxy).
 * If a future iteration runs against a remote dev API, the URL can
 * be made configurable via the `E2E_API_BASE` env var.
 */

const API_BASE = process.env.E2E_API_BASE ?? 'http://localhost:3001';

const DEFAULT_TIMEOUT_MS = 10_000;

export interface StoredAuth {
  token: string;
  claim: { role: string; sub: string; branch_ids?: string[]; scope?: string };
  expires_at: string;
  profile: Record<string, unknown>;
  [extra: string]: unknown;
}

class ApiProbeError extends Error {
  status: number;
  payload: unknown;
  constructor(message: string, status: number, payload: unknown) {
    super(message);
    this.name = 'ApiProbeError';
    this.status = status;
    this.payload = payload;
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let to: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    to = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms (is the API running on ${API_BASE}?)`)),
      ms,
    );
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (to) clearTimeout(to);
  }
}

async function postJson<T>(
  path: string,
  body: unknown,
  label: string,
  token: string | null = null,
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await withTimeout(
    fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
    DEFAULT_TIMEOUT_MS,
    label,
  );
  const text = await res.text();
  let payload: unknown = text;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON — keep the raw text for the error message.
  }
  if (!res.ok) {
    throw new ApiProbeError(
      `${label} → ${res.status} ${res.statusText}: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}`,
      res.status,
      payload,
    );
  }
  return payload as T;
}

async function getJson<T>(path: string, token: string | null, label: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await withTimeout(
    fetch(`${API_BASE}${path}`, { method: 'GET', headers }),
    DEFAULT_TIMEOUT_MS,
    label,
  );
  const text = await res.text();
  let payload: unknown = text;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    // not JSON
  }
  if (!res.ok) {
    throw new ApiProbeError(
      `${label} → ${res.status} ${res.statusText}: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}`,
      res.status,
      payload,
    );
  }
  return payload as T;
}

/** POST /auth/login/staff. */
export function loginStaff(role: 'admin' | 'doctor' | 'receptionist', email: string): Promise<StoredAuth> {
  return postJson<StoredAuth>(
    '/auth/login/staff',
    { role, email },
    `POST /auth/login/staff role=${role} email=${email}`,
  );
}

/** POST /patient/otp/verify-now. */
export function verifyPatientOtp(phone: string, code: string): Promise<StoredAuth> {
  return postJson<StoredAuth>(
    '/patient/otp/verify-now',
    { phone, code },
    `POST /patient/otp/verify-now phone=${phone}`,
  );
}

/**
 * GET /auth/me — used by `auth.setup.ts` to confirm the API is up.
 * Returns the parsed body; throws on non-2xx.
 */
export function getMe(token: string): Promise<{ claim: StoredAuth['claim']; profile?: unknown }> {
  return getJson('/auth/me', token, 'GET /auth/me');
}

/**
 * GET /healthz — no-auth probe. Asserts the API is reachable before
 * we waste time driving the auth flow.
 */
export async function probeHealth(): Promise<void> {
  const res = await withTimeout(fetch(`${API_BASE}/healthz`), DEFAULT_TIMEOUT_MS, 'GET /healthz');
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API /healthz returned ${res.status}: ${text || '<empty body>'}`);
  }
}

/**
 * POST /patient/appointments/:id/cancel — PR-2 cleanup helper.
 * The endpoint enforces `claim.sub === patient_phone`, so the caller
 * must pass the booking's owning patient.
 *
 * Returns 200 on success. Throws on any other status.
 */
export function cancelPatientBooking(token: string, appointmentId: string): Promise<unknown> {
  return postJson(
    `/patient/appointments/${encodeURIComponent(appointmentId)}/cancel`,
    {},
    `POST /patient/appointments/${appointmentId}/cancel`,
    token,
  )
    .catch((err) => {
      // For idempotent cleanup, a "not_found_appointment_in_terminal_state"
      // is fine — the booking is already cancelled and we're done.
      if (
        err instanceof ApiProbeError &&
        typeof err.payload === 'object' &&
        err.payload !== null &&
        (err.payload as { error?: string }).error ===
          'not_found_appointment_in_terminal_state'
      ) {
        return null;
      }
      throw err;
    });
}

// ─── Catalog lookups (PR-2) ──────────────────────────────────────

export interface PublicDoctor {
  id: string;
  full_name: string;
  specialty: string | null;
  branch_count: number;
}

export interface PublicBranch {
  id: string;
  name: string;
  tz: string;
  address: string | null;
  hours: Array<{
    day_of_week: number;
    open_time: string | null;
    close_time: string | null;
    is_closed: boolean;
  }>;
}

export interface PublicAppointmentType {
  id: string;
  name: string;
  duration_minutes: number;
  description: string | null;
}

export function listPublicDoctors(token: string): Promise<{ doctors: PublicDoctor[] }> {
  return getJson('/public/doctors', token, 'GET /public/doctors');
}

export function listPublicBranches(
  token: string,
  doctorId: string,
): Promise<{ branches: PublicBranch[] }> {
  return getJson(
    `/public/branches?doctor_id=${encodeURIComponent(doctorId)}`,
    token,
    'GET /public/branches',
  );
}

export function listPublicAppointmentTypes(
  token: string,
): Promise<{ appointment_types: PublicAppointmentType[] }> {
  return getJson(
    '/public/appointment-types',
    token,
    'GET /public/appointment-types',
  );
}

// ─── Patient booking helpers (PR-2) ──────────────────────────────

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

export interface PatientAppointmentRow {
  id: string;
  doctor_id: string;
  doctor_name: string;
  branch_id: string;
  branch_name: string;
  appointment_type_id: string;
  appointment_type_name: string;
  start_datetime: string;
  end_datetime: string;
  tz: string;
  type_duration: number;
  status: 'Scheduled';
}

/** GET /patient/appointments — list the calling patient's future bookings. */
export function listPatientAppointments(
  token: string,
): Promise<{ appointments: PatientAppointmentRow[] }> {
  return getJson('/patient/appointments', token, 'GET /patient/appointments');
}

/**
 * POST /bookings — create a booking. The body is a public surface
 * (no auth) so the call can be made with `token === null`; the
 * server's doubly-bound guards still apply for staff callers.
 */
export function createBooking(
  token: string | null,
  body: {
    doctor_id: string;
    branch_id: string;
    appointment_type_id: string;
    start_datetime: string;
    end_datetime: string;
    slot_duration_minutes: number;
    patient_phone: string;
    patient_name: string;
  },
): Promise<{ appointment: CreatedAppointment }> {
  return postJson('/bookings', body, 'POST /bookings', token).catch(
    async (err) => {
      // Re-throw ApiProbeError with the parsed payload attached so
      // specs can assert on `err.code`. The transport already keeps
      // payload in `err.payload`.
      throw err;
    },
  );
}

/**
 * GET /patient/appointments/:id/deep-link — fetch can_cancel /
 * can_reschedule flags + the row shape.
 */
export function getPatientDeepLink(
  token: string,
  appointmentId: string,
): Promise<{
  appointment_id: string;
  can_cancel: boolean;
  can_reschedule: boolean;
  appointment: {
    id: string;
    branch_id: string;
    doctor_id: string;
    appointment_type_id: string;
    start_datetime: string;
    end_datetime: string;
    status: string;
  };
}> {
  return getJson(
    `/patient/appointments/${encodeURIComponent(appointmentId)}/deep-link`,
    token,
    'GET /patient/appointments/:id/deep-link',
  );
}

/**
 * POST /patient/appointments/:id/reschedule. The body is the public
 * 5-field shape (no `new_doctor_id` per FR-040 doctor lock).
 */
export function reschedulePatientAppointment(
  token: string,
  appointmentId: string,
  body: {
    new_branch_id: string;
    new_appointment_type_id: string;
    new_start_datetime: string;
    new_end_datetime: string;
    new_slot_duration_minutes: number;
  },
): Promise<{ appointment: CreatedAppointment }> {
  return postJson(
    `/patient/appointments/${encodeURIComponent(appointmentId)}/reschedule`,
    body,
    'POST /patient/appointments/:id/reschedule',
    token,
  );
}

// ─── Doctor helpers (PR-2) ───────────────────────────────────────

export interface DoctorAffectedRow {
  appointment_id: string;
  branch_id: string;
  doctor_id: string;
  patient_phone: string;
  appointment_type_id: string;
  start_datetime: string;
  end_datetime: string;
  status: string;
  reason: 'closed_day' | 'before_open_or_after_close';
}

export function listDoctorAffected(
  token: string,
  input: { branch_id?: string; date?: string } = {},
): Promise<{
  count: number;
  branch_id: string | null;
  date: string | null;
  appointments: DoctorAffectedRow[];
}> {
  const params = new URLSearchParams();
  if (input.branch_id) params.set('branch_id', input.branch_id);
  if (input.date) params.set('date', input.date);
  const qs = params.toString();
  return getJson(
    `/doctor/affected${qs ? `?${qs}` : ''}`,
    token,
    'GET /doctor/affected',
  );
}

export function moveAffectedAppointment(
  token: string,
  appointmentId: string,
  body: {
    new_branch_id: string;
    new_start_datetime: string;
    new_end_datetime: string;
  },
): Promise<{ appointment: { id: string; status: string } }> {
  return postJson(
    `/doctor/affected/${encodeURIComponent(appointmentId)}/move`,
    body,
    'POST /doctor/affected/:id/move',
    token,
  );
}

export function doctorCancel(
  token: string,
  appointmentId: string,
  reason: string,
): Promise<{ appointment: { id: string; status: string } }> {
  return postJson(
    `/appointments/${encodeURIComponent(appointmentId)}/cancel`,
    { reason },
    'POST /appointments/:id/cancel',
    token,
  );
}

export function markAppointmentStatus(
  token: string,
  appointmentId: string,
  status: 'Completed' | 'No-Show',
): Promise<{ appointment: { id: string; status: string } }> {
  return postJson(
    `/appointments/${encodeURIComponent(appointmentId)}/mark-status`,
    { status },
    'POST /appointments/:id/mark-status',
    token,
  );
}

export interface DoctorAuditRow {
  id: string;
  appointment_id: string | null;
  actor_role: string;
  actor_id: string;
  event: string;
  payload: Record<string, unknown> | null;
  created_at: string;
}

export function getDoctorAppointmentAudit(
  token: string,
  appointmentId: string,
): Promise<{
  appointment_id: string;
  patient_phone: string;
  count: number;
  audit: DoctorAuditRow[];
}> {
  return getJson(
    `/doctor/appointments/${encodeURIComponent(appointmentId)}/audit`,
    token,
    'GET /doctor/appointments/:id/audit',
  );
}

export { ApiProbeError };
