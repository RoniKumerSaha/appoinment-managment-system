/**
 * Auth claim envelope.
 *
 * The shape is binding for every API guard. Session tokens must carry exactly
 * these fields. The body of a request is NEVER trusted to provide claims.
 *
 * E0-S3 wires a real JWT provider on top of this envelope. The frozen core
 * (sub / role / branch_ids / scope / doctor_id?) is preserved from E0-S1;
 * E0-S3 adds `expires_at` (derived from the JWT `exp`) and `jti` (for the
 * future W9 denylist story).
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
  readonly branch_ids: readonly string[];
  /** Authoritative scope label; cross-branch URLs fail-closed at the guard. */
  scope: Scope;
  /** Required when role === 'doctor' on doctor-only routes. */
  doctor_id?: string;
  /** Unix-epoch seconds at which the token expires. Derived from `exp`. */
  expires_at: number;
  /** Unique token id (UUID v4). Enables future W9 denylist without re-issuing. */
  jti: string;
}

export interface AuthContext {
  claim: AuthClaim | null;
}

