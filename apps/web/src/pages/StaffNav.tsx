/**
 * StaffNav — the section links in the doctor + receptionist top nav.
 *
 * The admin surface has always had a section nav (AppShell: Clinic |
 * Branches | Doctors | …). The doctor and receptionist surfaces had
 * NONE — just a wordmark and a Sign out button. Every screen those
 * two roles use was reachable only by hand-typing a URL
 * (`#/doctor?page=series`) or by finding a context link buried in
 * another page. A doctor could not get from the affected queue to the
 * recurring-series form, and a receptionist could not get from Today
 * to the availability browser without using a small teal quick-link.
 *
 * This component renders the nav links and owns the hash navigation.
 * It is deliberately role-agnostic: the caller supplies the list of
 * sections and which one is active.
 *
 * Navigation is HASH-based (`#/doctor?page=series`), matching the
 * rest of the app. Hash routing survives a page reload — a
 * `history.pushState` route would 404 on refresh because the dev
 * proxy forwards unknown paths to the API.
 *
 * The active section is tracked by the URL, not by local state: the
 * nav re-reads `window.location.hash` on every `hashchange`, so
 * clicking a link, pasting a URL, and using the browser Back button
 * all land on the same place.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

/** One section in the staff nav. */
export interface StaffNavItem {
  /** The `?page=` value, e.g. `today`. Also the view key. */
  key: string;
  /** The visible label, e.g. "Today". */
  label: string;
  /** Optional description used as the tooltip. */
  title?: string;
}

export interface StaffNavProps {
  /** The sections to show, in order. */
  items: StaffNavItem[];
  /** The `?page=` value of the current view. */
  active: string;
  /**
   * The hash path the nav lives under, e.g. `#/doctor`. The full URL
   * for a section is `${base}?page=${key}`.
   */
  base: string;
  /** Prefix for the test ids, e.g. `doctor` → `doctor-nav-today`. */
  testIdPrefix: string;
  /**
   * Maps a `?page=` value that is NOT a section onto the section it
   * belongs to.
   *
   * The doctor flow has pages that are steps of a section rather than
   * sections of their own — `preview`, `confirm` and `backout` are
   * stages of the recurring-series flow. Without an alias, landing on
   * `#/doctor?page=preview` would leave every nav link unhighlighted
   * (the URL names a page, but no link matches it).
   */
  aliases?: Record<string, string>;
}

/**
 * Build the hash URL for a section.
 *
 * The `?page=` query string lives INSIDE the hash fragment (the app
 * is hash-routed), so the shape is `#/doctor?page=series` — not
 * `#/doctor` with `?page=series` as a search string.
 * `readDeepLinkParam` reads the fragment first for exactly this
 * reason.
 */
export function staffNavHash(base: string, key: string): string {
  return `${base}?page=${key}`;
}

/**
 * Read the `page` param out of the current hash.
 *
 * Returns `null` when the hash has no `?page=` — the caller treats
 * that as the role's default section.
 */
function readPageFromHash(): string | null {
  if (typeof window === 'undefined') return null;
  const hash = window.location.hash;
  const q = hash.indexOf('?');
  if (q === -1) return null;
  return new URLSearchParams(hash.slice(q + 1)).get('page');
}

export function StaffNav({
  items,
  active,
  base,
  testIdPrefix,
  aliases,
}: StaffNavProps): ReactNode {
  // Track the hash so the active link follows the browser's Back /
  // Forward buttons as well as our own clicks.
  const [hashPage, setHashPage] = useState<string | null>(() =>
    readPageFromHash(),
  );

  useEffect(() => {
    const onHash = (): void => setHashPage(readPageFromHash());
    window.addEventListener('hashchange', onHash);
    // The hash may have changed between first render and this effect.
    onHash();
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // The active section is the URL's, falling back to the caller's
  // (the app's own view state) when the URL carries no `?page=`.
  //
  // A URL naming a page that is not a section (an alias) resolves to
  // its section. A URL naming something we don't recognise at all
  // falls back to `active` — otherwise NO link would be highlighted,
  // which reads as "the nav is broken" rather than "unknown page".
  const resolved = hashPage ?? active;
  const current = useMemo(() => {
    if (items.some((i) => i.key === resolved)) return resolved;
    const aliased = aliases?.[resolved];
    if (aliased !== undefined && items.some((i) => i.key === aliased)) {
      return aliased;
    }
    return active;
  }, [resolved, active, items, aliases]);

  const onNavigate = useCallback((key: string) => {
    if (typeof window === 'undefined') return;
    const next = staffNavHash(base, key);
    if (window.location.hash === next) return;
    window.location.hash = next;
  }, [base]);

  return (
    <div className="staff-nav__links" role="navigation" aria-label="Sections">
      {items.map((item) => {
        const isActive = item.key === current;
        return (
          <button
            key={item.key}
            type="button"
            className={
              'staff-nav__link' + (isActive ? ' staff-nav__link--active' : '')
            }
            data-testid={`${testIdPrefix}-nav-${item.key}`}
            aria-current={isActive ? 'page' : undefined}
            title={item.title ?? item.label}
            onClick={() => onNavigate(item.key)}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
