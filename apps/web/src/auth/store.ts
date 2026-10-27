/**
 * Auth store — token persistence + React sync.
 *
 * Single source of truth for "is anyone signed in?" Wraps `localStorage`
 * (key: `medislot.auth`) and exposes a `useAuth()` hook via
 * `useSyncExternalStore` so every component re-renders on login / logout /
 * expiry without prop-drilling.
 *
 * The dev-mode `x-auth-claim` header from E1-S0-ui is intentionally
 * preserved as a fallback in `request()` (see `apps/web/src/api/client.ts`)
 * for offline development without a backend. The token store is the
 * preferred path; the fallback fires only when there is no token in
 * storage (i.e. cold load with no previous session).
 *
 * Three actions:
 *   - `loginAsStaff({role, email})`     → POST /auth/login/staff
 *   - `verifyPatientOtp({phone, code})` → POST /patient/otp/verify-now
 *   - `logout()`                        → clear localStorage
 *
 * Each action updates the store's internal state; subscribers re-render.
 */
import { useSyncExternalStore } from 'react';
import {
  loginStaff as apiLoginStaff,
  verifyPatientOtp as apiVerifyPatientOtp,
  type AuthClaim,
  type Profile,
} from '../api/client';

export interface StoredAuth {
  token: string;
  claim: AuthClaim;
  expires_at: string;
  profile: Profile;
}

const TOKEN_KEY = 'medislot.auth';

type Listener = () => void;

const listeners = new Set<Listener>();
let current: StoredAuth | null = null;
try {
  const raw = localStorage.getItem(TOKEN_KEY);
  if (raw) {
    const parsed = JSON.parse(raw) as StoredAuth;
    if (
      parsed &&
      typeof parsed.token === 'string' &&
      parsed.claim &&
      typeof parsed.expires_at === 'string'
    ) {
      current = parsed;
    }
  }
} catch {
  // localStorage may be unavailable (SSR, sandbox); current stays null.
}

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): StoredAuth | null {
  return current;
}

function getServerSnapshot(): StoredAuth | null {
  return null;
}

export function useAuth(): AuthState {
  const stored = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const expired =
    stored !== null && Date.parse(stored.expires_at) - 60_000 < Date.now();
  return {
    stored,
    expired,
    isAuthenticated: stored !== null && !expired,
  };
}

export interface AuthState {
  stored: StoredAuth | null;
  expired: boolean;
  isAuthenticated: boolean;
}

function setStored(next: StoredAuth): void {
  current = next;
  try {
    localStorage.setItem(TOKEN_KEY, JSON.stringify(next));
  } catch {
    // Ignore quota / disabled storage errors; the in-memory copy still drives
    // the UI. The next page load will be anonymous.
  }
  emit();
}

export function clearAuth(): void {
  current = null;
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Ignore.
  }
  emit();
}

/**
 * Staff sign-in.
 *
 * `password` is optional — omit it to use the dev-only email-only path
 * (refused outside dev/test by the API). Supply it to authenticate with
 * the account's stored credential.
 */
export async function loginAsStaff(input: {
  role: 'admin' | 'doctor' | 'receptionist';
  email: string;
  password?: string;
}): Promise<StoredAuth> {
  const res = await apiLoginStaff(input);
  setStored(res);
  return res;
}

export async function verifyPatientOtp(input: {
  phone: string;
  code: string;
}): Promise<StoredAuth> {
  const res = await apiVerifyPatientOtp(input);
  setStored(res);
  return res;
}

export function logout(): void {
  clearAuth();
}