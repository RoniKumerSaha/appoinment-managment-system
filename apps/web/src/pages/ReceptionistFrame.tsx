/**
 * ReceptionistFrame — top-level frame for the receptionist dashboard +
 * cancel flows.
 *
 * Distinct from PatientFrame (E3-ui) and AppShell (E1-S0-ui). Mockups
 * 13 / 15 / 26 share a thinner top nav (MediSlot wordmark + actor chip
 * "Reem Al-Harbi · Reception") with no section nav. Body is 1100px
 * (mock 13) — different from the 1200px patient frame.
 *
 * The frame is sticky so the long today list / cancel flow keeps the
 * nav visible while scrolling.
 *
 * The nav DID have no section links — the receptionist's four screens
 * (Today / Book walk-in / Availability / Cancel) were reachable only
 * via the small teal quick-links on the Today page or a hand-typed
 * URL. The frame now takes an optional `navItems` list and renders
 * the shared `StaffNav`, so the section links live in the URL and
 * survive a reload.
 *
 * Pixel-perfect match to:
 *   - docs/design/mockups/v1/mockups/13-recep-today.html (nav)
 *   - docs/design/mockups/v1/mockups/15-recep-cancel.html (nav)
 *   - docs/design/mockups/v1/mockups/26-recep-checkin.html (nav)
 */
import type { ReactNode } from 'react';
import { useAuth, logout } from '../auth/store';
import { BrandMark } from '../brand/BrandMark';
import { StaffNav, type StaffNavItem } from './StaffNav';
import { RECEPTIONIST_NAV, RECEPTIONIST_NAV_ALIASES } from './staff-nav-items';
import './styles/receptionist-frame.css';
import './styles/staff-nav.css';

interface ReceptionistFrameProps {
  children: ReactNode;
  onSignOut?: () => void;
  /** The section links to show in the nav. Omit for a nav with none. */
  navItems?: StaffNavItem[];
  /** The `?page=` key of the section currently on screen. */
  activeNav?: string;
  /**
   * Maps a `?page=` value that is not a section onto the section it
   * belongs to. The recurring flow's `preview` / `confirm` screens
   * are steps of the `series` section, so without an alias the nav
   * would highlight nothing while they are open.
   *
   * Defaults to `RECEPTIONIST_NAV_ALIASES`; pass an explicit map (or
   * an empty one) to override.
   */
  aliases?: Record<string, string>;
}

function initialsOf(name: string | null, email: string): string {
  if (name && name.length > 0) {
    const parts = name.trim().split(/\s+/);
    const first = parts[0]?.[0] ?? '';
    const last = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? '' : '';
    return (first + last).toUpperCase() || email.slice(0, 2).toUpperCase();
  }
  return email.slice(0, 2).toUpperCase();
}

export function ReceptionistFrame({
  children,
  onSignOut,
  navItems,
  activeNav,
  aliases = RECEPTIONIST_NAV_ALIASES,
}: ReceptionistFrameProps) {
  const { stored } = useAuth();
  const profile = stored?.profile ?? null;
  const role = stored?.claim.role ?? 'receptionist';
  // The display name falls back to the email when the profile has no
// full_name. It used to fall back to a hardcoded 'Reem Al-Harbi',
// which meant every receptionist without a name on file appeared in
// the header under someone else's name.
const displayName = profile?.full_name ?? profile?.email ?? 'Receptionist';
  const initials = initialsOf(
    profile?.full_name ?? null,
    profile?.email ?? 'reception',
  );
  const onClickSignOut = (): void => {
    if (onSignOut) onSignOut();
    logout();
  };
  const roleLabel =
    role === 'receptionist'
      ? 'Reception'
      : role === 'doctor'
        ? 'Doctor'
        : role === 'admin'
          ? 'Administrator'
          : 'Patient';

  // Default to the receptionist's own section list so every screen
  // that renders this frame gets the nav — Today, Cancel, Create and
  // Availability all use this frame, and each of them used to render
  // a nav with no links at all.
  const resolvedNav = navItems ?? RECEPTIONIST_NAV;
  return (
    <div className="recep-frame__root" data-testid="recep-frame">
      <nav className="recep-frame__nav" data-testid="recep-frame-nav">
        <div className="recep-frame__brand" data-testid="recep-frame-brand">
          <BrandMark size={28} className="recep-frame__brand-logo" />
          MediSlot
          {/*
            The role pill. The receptionist nav used to weld the role
            onto the actor's name ("Reem Al-Harbi · Reception"), so
            the four role surfaces announced themselves in three
            different ways. The pill matches the doctor's and the
            patient's exactly.
          */}
          <span
            className="recep-frame__role-pill"
            data-testid="recep-frame-role-pill"
          >
            {roleLabel}
          </span>
        </div>
        {resolvedNav.length > 0 && (
          <StaffNav
            items={resolvedNav}
            active={activeNav ?? resolvedNav[0]!.key}
            base="#/reception"
            testIdPrefix="recep"
            aliases={aliases}
          />
        )}
        <div className="recep-frame__user">
          <span className="recep-frame__user-name">
            {/* The role lives in the pill next to the wordmark now —
                repeating it here read as a stutter. */}
            {displayName}
          </span>
          <div className="recep-frame__avatar" aria-hidden="true">
            {initials}
          </div>
          <button
            type="button"
            className="recep-frame__signout"
            onClick={onClickSignOut}
            title="Sign out"
          >
            Sign out
          </button>
        </div>
      </nav>
      <div className="recep-frame__body">{children}</div>
    </div>
  );
}
