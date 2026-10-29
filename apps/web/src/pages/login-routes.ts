/**
 * login-routes — the hash routes for the split login screens.
 *
 * The login used to be ONE page with two cards on it (staff sign-in
 * on the left, patient OTP on the right). It is now three screens:
 *
 *   `#/login`          → the chooser (the app root's landing screen)
 *   `#/login/staff`    → staff sign-in (role + email + password)
 *   `#/login/patient`  → patient sign-in (phone + 6-digit OTP)
 *
 * Why its own reader rather than an extension of `usePathRoute`:
 * `usePathRoute` is the ADMIN router — its `ParsedRoute` union only
 * knows `admin-top` / `admin-sub`, and it is consulted by `App.tsx`
 * AFTER the authenticated shell is chosen. The login renders BEFORE
 * any shell, for an unauthenticated visitor, so folding it into the
 * admin router would mean teaching the admin parser about auth.
 *
 * Why hash-based: the whole app is hash-routed (`#/admin/clinic`,
 * `#/doctor?page=series`). A `history.pushState` route would 404 on
 * refresh because the Vite dev proxy forwards unknown paths to the
 * API.
 *
 * The default is `choose`, which is what makes `page.goto('/')` land
 * on a usable login screen: with no hash at all, the reader returns
 * `choose` and the chooser renders.
 */
import { useEffect, useState } from 'react';
import {
  LOGIN_CHOOSE_HASH,
  LOGIN_STAFF_HASH,
  LOGIN_PATIENT_HASH,
} from '../auth/login-hashes';

/** Which login screen is on display. */
export type LoginRoute = 'choose' | 'staff' | 'patient';

export { LOGIN_CHOOSE_HASH, LOGIN_STAFF_HASH, LOGIN_PATIENT_HASH };

/**
 * Parse a hash into a login route.
 *
 * Anything that is not a recognised login hash — including the empty
 * hash, an admin hash, or a typo — falls back to `choose`. The chooser
 * is the safe landing spot: it is always reachable and it links to
 * both of the real forms.
 */
export function parseLoginRoute(hash: string): LoginRoute {
  // Strip the leading '#' and any trailing slashes.
  let p = hash.startsWith('#') ? hash.slice(1) : hash;
  p = p.replace(/\/+$/, '');
  if (p === '' || p === '/') return 'choose';
  if (p === '/login') return 'choose';
  if (p === '/login/staff') return 'staff';
  if (p === '/login/patient') return 'patient';
  return 'choose';
}

/** Read the current hash without the leading `#`. */
function readHash(): string {
  if (typeof window === 'undefined') return '';
  return window.location.hash;
}

/**
 * Reactively track the login route.
 *
 * The `hashchange` listener matters: navigating between the two
 * login screens is a hash-only change, which does NOT remount the
 * SPA, so a mount-only read would never see the new route.
 */
export function useLoginRoute(): LoginRoute {
  const [route, setRoute] = useState<LoginRoute>(() =>
    parseLoginRoute(readHash()),
  );

  useEffect(() => {
    const onHash = (): void => setRoute(parseLoginRoute(readHash()));
    window.addEventListener('hashchange', onHash);
    // The hash may have changed between the first render and this
    // effect running — re-read once to close that gap.
    onHash();
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  return route;
}

/** Write a login route into the URL. */
export function pushLoginRoute(route: LoginRoute): void {
  if (typeof window === 'undefined') return;
  const next =
    route === 'staff'
      ? LOGIN_STAFF_HASH
      : route === 'patient'
        ? LOGIN_PATIENT_HASH
        : LOGIN_CHOOSE_HASH;
  if (window.location.hash === next) return;
  window.location.hash = next;
}
