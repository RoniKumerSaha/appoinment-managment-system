/**
 * DoctorFrame — top-level frame for the doctor-facing flow.
 *
 * Distinct from the admin AppShell (E1-S0-ui), PatientFrame
 * (E3-ui, 1200px), and ReceptionistFrame (E5-S4, 1100px):
 * the doctor sees a sticky nav with logo + actor chip + Sign out,
 * 1100px body.
 *
 * The nav DID have no left-side section links — the doctor's surface
 * was the affected queue (E6-S3) plus the resolve flows (E6-S2), and
 * the recurring screens (E6-S1) were reachable only by hand-typing
 * `#/doctor?page=series`. A doctor had no way to move between the
 * queue and the recurring-series form. The frame now takes an
 * optional `navItems` list and renders the shared `StaffNav`, so the
 * section links live in the URL and survive a reload.
 *
 * Pixel-perfect port of mockup 06 (Kanban), mockup 24 (Resolve),
 * mockup 37 (Resolution Saved).
 */
import type { ReactNode } from 'react';
import { useAuth, logout } from '../auth/store';
import { BrandMark } from '../brand/BrandMark';
import { StaffNav, type StaffNavItem } from './StaffNav';
import { DOCTOR_NAV, DOCTOR_NAV_ALIASES } from './staff-nav-items';
import './styles/doctor-frame.css';
import './styles/staff-nav.css';

interface DoctorFrameProps {
  children: ReactNode;
  /** The section links to show in the nav. Omit for a nav with none. */
  navItems?: StaffNavItem[];
  /** The `?page=` key of the section currently on screen. */
  activeNav?: string;
}

export function DoctorFrame({ children, navItems, activeNav }: DoctorFrameProps) {
  const { stored } = useAuth();
  const profile = stored?.profile;
  const claim = stored?.claim;

  const displayName = profile?.full_name ?? 'Doctor';
  const initials = displayName
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');

  const onClickSignOut = (): void => {
    logout();
  };

  // Default to the doctor's own section list so every screen that
  // renders this frame gets the nav — the doctor frame is used by the
  // affected queue AND by all four recurring-series screens, and each
  // of them used to render a nav with no links at all.
  const resolvedNav = navItems ?? DOCTOR_NAV;

  return (
    <div className="doctor-frame__root" data-testid="doctor-frame">
      <nav className="doctor-frame__nav" data-testid="doctor-frame-nav">
        <div className="doctor-frame__brand" data-testid="doctor-frame-brand">
          <BrandMark size={28} className="doctor-frame__brand-logo" />
          MediSlot
          {claim?.role === 'doctor' && (
            <span className="doctor-frame__role-pill" data-testid="doctor-frame-role-pill">Doctor</span>
          )}
        </div>
        {resolvedNav.length > 0 && (
          <StaffNav
            items={resolvedNav}
            active={activeNav ?? resolvedNav[0]!.key}
            base="#/doctor"
            testIdPrefix="doctor"
            aliases={DOCTOR_NAV_ALIASES}
          />
        )}
        <div className="doctor-frame__actor" data-testid="doctor-frame-actor">
          <span className="doctor-frame__actor-name">{displayName}</span>
          <span className="doctor-frame__actor-avatar">{initials}</span>
        </div>
        <button
          type="button"
          className="doctor-frame__cta"
          data-testid="doctor-frame-signout"
          onClick={onClickSignOut}
        >
          Sign out
        </button>
      </nav>
      <div className="doctor-frame__body" data-testid="doctor-frame-body">{children}</div>
    </div>
  );
}