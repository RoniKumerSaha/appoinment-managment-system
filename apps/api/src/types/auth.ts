/**
 * Auth claim envelope.
 *
 * The shape is binding for every API guard. Session tokens must carry exactly
 * these fields. The body of a request is NEVER trusted to provide claims.
 *
 * E0-S3 will replace the stub parser in middleware/auth.ts with a real provider;
 * the claim shape is stable so guards written against it do not change.
 */
export type Role = 'patient' | 'receptionist' | 'doctor' | 'admin';

export type Scope = 'self' | 'branch' | 'clinic' | 'global';

export interface AuthClaim {
  /** Stable subject identifier (patient phone hash, staff user id, etc.). */
  sub: string;
  /** Role determines which guards apply. */
  role: Role;
  /**
   * Branches the actor may access. An empty array is rejected at middleware
   * for staff tokens; patient tokens may legitimately have an empty array
   * because patient sessions filter by phone, not branch.
   */
  branch_ids: string[];
  /** Authoritative scope label; cross-branch URLs fail-closed at the guard. */
  scope: Scope;
  /** Required when role === 'doctor' on doctor-only routes. */
  doctor_id?: string;
}

export interface AuthContext {
  claim: AuthClaim | null;
}
