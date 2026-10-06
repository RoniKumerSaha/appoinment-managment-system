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
 * Pixel-perfect match to:
 *   - docs/design/mockups/v1/mockups/13-recep-today.html (nav)
 *   - docs/design/mockups/v1/mockups/15-recep-cancel.html (nav)
 *   - docs/design/mockups/v1/mockups/26-recep-checkin.html (nav)
 */
import type { ReactNode } from 'react';
import { useAuth, logout } from '../auth/store';
import './styles/receptionist-frame.css';

interface ReceptionistFrameProps {
  children: ReactNode;
  onSignOut?: () => void;
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
}: ReceptionistFrameProps) {
  const { stored } = useAuth();
  const profile = stored?.profile ?? null;
  const role = stored?.claim.role ?? 'receptionist';
  const displayName = profile?.full_name ?? 'Reem Al-Harbi';
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
  return (
    <div className="recep-frame__root">
      <nav className="recep-frame__nav">
        <div className="recep-frame__brand">
          <div className="recep-frame__brand-logo" aria-hidden="true">
            M
          </div>
          MediSlot
        </div>
        <div className="recep-frame__user">
          <span className="recep-frame__user-name">
            {displayName} · {roleLabel}
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
