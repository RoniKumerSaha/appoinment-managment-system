/**
 * API client for apps/web.
 *
 * E1-S0-ui is the first story to consume the admin API. Until a real staff
 * login lands (deferred per W10), the web app authenticates as the seeded
 * admin via the dev-mode `x-auth-claim` debug header (see
 * `apps/api/src/middleware/auth.ts`). The header is silently dropped by
 * the API when `NODE_ENV === 'production'`, so the dev affordance cannot
 * leak to production.
 *
 * `__clinic_anchor__` is the sentinel branch_id used by every admin caller
 * — admin routes ignore branch_ids (admin scope lives at `scope: 'clinic'`
 * per AD-8). The sentinel is also used by the test helper
 * `apps/api/test/__helpers__/admin-token.ts`.
 *
 * Every request throws an `ApiError` on non-2xx; the caller decides how to
 * render the envelope. The `code` is the API's `{error: <string>}` value.
 */

const API_BASE = ''; // same origin via Vite proxy in dev

/**
 * The exact claim shape the API's `parseClaimHeader` expects (see
 * `apps/api/src/middleware/auth.ts:37-70`).
 */
const ADMIN_CLAIM = {
  sub: 'admin-main',
  role: 'admin',
  branch_ids: ['__clinic_anchor__'],
  scope: 'clinic',
} as const;

const ADMIN_CLAIM_HEADER = JSON.stringify(ADMIN_CLAIM);

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

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(`api_${status}:${code}`);
    this.status = status;
    this.code = code;
  }
}

const authHeaders: HeadersInit = {
  'x-auth-claim': ADMIN_CLAIM_HEADER,
  'content-type': 'application/json',
};

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...authHeaders,
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    // The API always returns `{error: <code>}` on non-2xx. Fall back to
    // a stable code if the body is unexpectedly empty.
    let code = 'unknown_error';
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === 'string') code = body.error;
    } catch {
      // body wasn't JSON — keep `unknown_error`.
    }
    throw new ApiError(res.status, code);
  }
  return (await res.json()) as T;
}

export function getClinic(): Promise<ClinicDto> {
  return request<ClinicDto>('/admin/clinic', { method: 'GET' });
}

export function patchClinic(name: string): Promise<ClinicDto> {
  return request<ClinicDto>('/admin/clinic', {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  });
}
