/**
 * DoctorFrame — top-level frame for the doctor-facing flow.
 *
 * Distinct from the admin AppShell (E1-S0-ui), PatientFrame
 * (E3-ui, 1200px), and ReceptionistFrame (E5-S4, 1100px):
 * the doctor sees a sticky nav with logo + actor chip + Sign out,
 * 1100px body. The nav has no left-side section links — the
 * doctor's surface is the affected queue (E6-S3) and the
 * resolve flows (E6-S2). Future work can add weekly schedule
 * and audit drawer links (mock 09 / mock 30).
 *
 * Pixel-perfect port of mockup 06 (Kanban), mockup 24 (Resolve),
 * mockup 37 (Resolution Saved).
 */
import type { ReactNode } from 'react';
import { useAuth, logout } from '../auth/store';
import './styles/doctor-frame.css';

interface DoctorFrameProps {
  children: ReactNode;
}

export function DoctorFrame({ children }: DoctorFrameProps) {
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

  return (
    <div className="doctor-frame__root">
      <nav className="doctor-frame__nav">
        <div className="doctor-frame__brand">
          <div className="doctor-frame__brand-logo" aria-hidden="true">
            M
          </div>
          MediSlot
          {claim?.role === 'doctor' && (
            <span className="doctor-frame__role-pill">Doctor</span>
          )}
        </div>
        <div className="doctor-frame__actor">
          <span className="doctor-frame__actor-name">{displayName}</span>
          <span className="doctor-frame__actor-avatar">{initials}</span>
        </div>
        <button
          type="button"
          className="doctor-frame__cta"
          onClick={onClickSignOut}
        >
          Sign out
        </button>
      </nav>
      <div className="doctor-frame__body">{children}</div>
    </div>
  );
}