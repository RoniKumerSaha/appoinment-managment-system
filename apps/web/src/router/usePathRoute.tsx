/**
 * Tiny client-side router — W59.
 *
 * Hash-based, no external dependency. The URL hash is the source of
 * truth: `#/admin/clinic`, `#/admin/branches`, etc. App.tsx parses
 * the hash into an AdminSection + optional AdminSubPage. Anchor tags
 * (`<a href="#/admin/...">`) are intercepted by `<Link>` so navigation
 * doesn't trigger a full page reload.
 *
 * Why hash and not history API? Per the E1-S0-ui W59 deferral the
 * team ships the smallest thing that works. The hash approach sidesteps
 * the Vite dev proxy (which forwards `/admin/*` to the API and would
 * 404 on page reload for sub-pages like `/admin/branches/<id>/hours`).
 * A future hardening story can swap to the History API + an SPA
 * fallback when we control the production reverse proxy.
 *
 * Why not react-router? See note in `usePathRoute`. The admin
 * surface is a flat top-level navigation with one level of sub-pages,
 * which fits in ~70 lines of code.
 *
 * Scope:
 *   - Admin session only. The patient / doctor / receptionist flows
 *     don't carry a router today (their apps are self-contained —
 *     PatientApp, DoctorApp, ReceptionistApp render their own
 *     state machines). When those grow enough to need real routes,
 *     each will get its own hook.
 *   - Hash-only. The path part of the URL is ignored for the admin
 *     session — we read `window.location.hash` and the path can be
 *     anything (`/`, `/admin/clinic`, etc.). Hash routes are also
 *     shareable (just paste the URL).
 *   - Default: when the hash is empty or doesn't match any known
 *     admin route, redirect to `#/admin/clinic`. LoginPage doesn't
 *     touch the router.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import type { AdminSection, AdminSubPage } from '../AppShell';

export type ParsedRoute =
  | { kind: 'admin-top'; section: AdminSection }
  | { kind: 'admin-sub'; section: AdminSection; sub: AdminSubPage }
  | { kind: 'unknown'; hash: string };

const SECTION_FROM_PATH: Record<string, AdminSection> = {
  '/admin/clinic': 'clinic',
  '/admin/branches': 'branches',
  '/admin/doctors': 'doctors',
  '/admin/receptionists': 'receptionists',
  '/admin/types': 'types',
  '/admin/audit': 'audit',
};

const DEFAULT_HASH = '#/admin/clinic';
const DEFAULT_ADMIN_SECTION: AdminSection = 'clinic';

/** Read the hash without the leading `#`. */
function readHash(): string {
  if (typeof window === 'undefined') return '';
  const h = window.location.hash;
  if (h.length === 0 || h === '#') return '';
  return h.startsWith('#') ? h.slice(1) : h;
}

/**
 * Parse a hash path into a structured route. Empty hash → default
 * admin-top clinic.
 */
export function parsePath(path: string): ParsedRoute {
  // Normalize: trim trailing slash, ensure leading slash.
  let p = path.replace(/\/+$/, '');
  if (p === '') {
    return { kind: 'admin-top', section: DEFAULT_ADMIN_SECTION };
  }
  if (!p.startsWith('/')) {
    p = '/' + p;
  }

  // Try exact top-level admin prefix matches.
  if (p in SECTION_FROM_PATH) {
    return { kind: 'admin-top', section: SECTION_FROM_PATH[p]! };
  }

  // Try sub-page matches.
  const branchHoursMatch = p.match(/^\/admin\/branches\/([^/]+)\/hours$/);
  if (branchHoursMatch) {
    return {
      kind: 'admin-sub',
      section: 'branches',
      sub: { key: 'branch-hours', branchId: branchHoursMatch[1]! },
    };
  }
  const doctorAssignMatch = p.match(/^\/admin\/doctors\/([^/]+)\/assign$/);
  if (doctorAssignMatch) {
    return {
      kind: 'admin-sub',
      section: 'doctors',
      sub: { key: 'doctor-assign', doctorId: doctorAssignMatch[1]! },
    };
  }
  const doctorScheduleMatch = p.match(/^\/admin\/doctors\/([^/]+)\/schedule$/);
  if (doctorScheduleMatch) {
    return {
      kind: 'admin-sub',
      section: 'doctors',
      sub: { key: 'doctor-schedule', doctorId: doctorScheduleMatch[1]! },
    };
  }
  const doctorBlocksMatch = p.match(/^\/admin\/doctors\/([^/]+)\/blocks$/);
  if (doctorBlocksMatch) {
    return {
      kind: 'admin-sub',
      section: 'doctors',
      sub: { key: 'doctor-blocks', doctorId: doctorBlocksMatch[1]! },
    };
  }

  // Prefix matches for the parent section — when the user lands on
  // /admin/branches/foo (unknown sub), still render the parent.
  if (p.startsWith('/admin/branches')) {
    return { kind: 'admin-top', section: 'branches' };
  }
  if (p.startsWith('/admin/doctors')) {
    return { kind: 'admin-top', section: 'doctors' };
  }
  if (p.startsWith('/admin/receptionists')) {
    return { kind: 'admin-top', section: 'receptionists' };
  }
  if (p.startsWith('/admin/types')) {
    return { kind: 'admin-top', section: 'types' };
  }
  if (p.startsWith('/admin/audit')) {
    return { kind: 'admin-top', section: 'audit' };
  }
  if (p.startsWith('/admin/clinic')) {
    return { kind: 'admin-top', section: 'clinic' };
  }

  return { kind: 'unknown', hash: p };
}

/**
 * Inverse of `parsePath`: build a hash path from a section + sub.
 * Always returns the full `#/admin/...` string.
 */
export function buildPath(
  section: AdminSection,
  sub?: AdminSubPage | null,
): string {
  switch (section) {
    case 'clinic':
      return '#/admin/clinic';
    case 'branches':
      if (sub?.key === 'branch-hours') {
        return `#/admin/branches/${sub.branchId}/hours`;
      }
      return '#/admin/branches';
    case 'doctors':
      if (sub?.key === 'doctor-assign') {
        return `#/admin/doctors/${sub.doctorId}/assign`;
      }
      if (sub?.key === 'doctor-schedule') {
        return `#/admin/doctors/${sub.doctorId}/schedule`;
      }
      if (sub?.key === 'doctor-blocks') {
        return `#/admin/doctors/${sub.doctorId}/blocks`;
      }
      return '#/admin/doctors';
    case 'receptionists':
      return '#/admin/receptionists';
    case 'types':
      return '#/admin/types';
    case 'audit':
      return '#/admin/audit';
  }
}

/**
 * Strip the leading `#` from a `buildPath` so the result can be
 * passed back through `parsePath`.
 */
function stripHash(hash: string): string {
  return hash.startsWith('#') ? hash.slice(1) : hash;
}

/**
 * Parse the current `window.location.hash` reactively. The hook
 * re-renders on `hashchange` and on our own navigations.
 */
export function usePathRoute(): {
  route: ParsedRoute;
  navigate: (path: string) => void;
} {
  const [hash, setHash] = useState<string>(() => readHash());

  useEffect(() => {
    const onHash = (): void => {
      setHash(readHash());
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const navigate = useCallback((path: string): void => {
    if (typeof window === 'undefined') return;
    if (window.location.hash === path) return;
    window.location.hash = path;
    // hashchange fires asynchronously, but we still set state so the
    // UI updates without waiting for the event.
    setHash(stripHash(path));
  }, []);

  const route = useMemo(() => parsePath(hash), [hash]);
  return { route, navigate };
}

/**
 * `<Link>` — same shape as `<a>` but intercepts left-clicks and uses
 * the router. Modifier keys, middle clicks, and target="_blank" pass
 * through to the browser's default behaviour.
 */
export interface LinkProps {
  to: string;
  className?: string;
  children: ReactNode;
  title?: string;
  'aria-label'?: string;
  'aria-current'?: 'page' | 'step' | 'location' | 'date' | 'time' | 'true' | 'false';
  onClick?: () => void;
}

export function Link({
  to,
  className,
  children,
  title,
  onClick,
  ...rest
}: LinkProps) {
  const onClickInternal = useCallback(
    (e: MouseEvent<HTMLAnchorElement>): void => {
      if (e.defaultPrevented) return;
      if (e.button !== 0) return; // left-click only
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const target = e.currentTarget.target;
      if (target && target !== '' && target !== '_self') return;
      e.preventDefault();
      if (typeof window !== 'undefined') {
        if (window.location.hash !== to) {
          window.location.hash = to;
        }
      }
      onClick?.();
    },
    [to, onClick],
  );
  return (
    <a
      href={to}
      className={className}
      title={title}
      onClick={onClickInternal}
      {...rest}
    >
      {children}
    </a>
  );
}

export const DEFAULT_PATH = DEFAULT_HASH;