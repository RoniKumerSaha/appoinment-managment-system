/**
 * App shell — the top nav shared by every authenticated page.
 *
 * W10 update: the user chip and "Sign out" affordance are now driven by
 * the auth store. When no session is present (e.g. parent forgot to gate
 * the shell), the chip falls back to the static demo identity. The other
 * admin nav links remain non-active placeholders for now — they become
 * real routes when the router lands (deferral W59 / E1-S0-ui).
 */
import type { ReactNode } from 'react';
import { useAuth, logout } from './auth/store';
import type { AuthRole } from './api/client';
import './styles/shell.css';

export type AdminSection = 'clinic' | 'branches' | 'doctors' | 'receptionists' | 'audit';

const SECTIONS: { key: AdminSection; label: string; href: string }[] = [
  { key: 'clinic', label: 'Clinic', href: '/admin/clinic' },
  { key: 'branches', label: 'Branches', href: '/admin/branches' },
  { key: 'doctors', label: 'Doctors', href: '/admin/doctors' },
  { key: 'receptionists', label: 'Receptionists', href: '/admin/receptionists' },
  { key: 'audit', label: 'Audit log', href: '/admin/audit' },
];

const ROLE_LABELS: Record<AuthRole, string> = {
  admin: 'Administrator',
  doctor: 'Doctor',
  receptionist: 'Receptionist',
  patient: 'Patient',
};

function initialsOf(name: string | null, email: string): string {
  if (name && name.length > 0) {
    const parts = name.trim().split(/\s+/);
    const first = parts[0]?.[0] ?? '';
    const last = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? '' : '';
    return (first + last).toUpperCase() || email.slice(0, 2).toUpperCase();
  }
  return email.slice(0, 2).toUpperCase();
}

interface AppShellProps {
  active: AdminSection;
  onNavigate?: (section: AdminSection) => void;
  children: ReactNode;
}

export function AppShell({ active, onNavigate, children }: AppShellProps) {
  const { stored } = useAuth();
  const profile = stored?.profile ?? null;
  const role = stored?.claim.role ?? 'admin';
  const displayName = profile?.full_name ?? 'Sara Al-Otaibi';
  const displayRole = ROLE_LABELS[role] ?? 'Administrator';
  const initials = initialsOf(profile?.full_name ?? null, profile?.email ?? 'admin');

  const onSignOut = (): void => {
    logout();
  };

  const isImplemented = (key: AdminSection): boolean =>
    key === 'clinic' || key === 'branches';

  return (
    <div className="shell">
      <nav className="nav">
        <div className="nav__brand">
          <div className="nav__brand-logo" aria-hidden="true" />
          MediSlot · Admin
        </div>
        <div className="nav__links">
          {SECTIONS.map((s) => {
            if (s.key === active) {
              return (
                <span
                  key={s.key}
                  className="nav__link nav__link--active"
                  aria-current="page"
                >
                  {s.label}
                </span>
              );
            }
            const ready = isImplemented(s.key);
            return (
              <button
                key={s.key}
                type="button"
                className="nav__link"
                disabled={!ready}
                onClick={() => {
                  if (ready && onNavigate) onNavigate(s.key);
                }}
                title={ready ? s.label : 'Not yet implemented'}
              >
                {s.label}
              </button>
            );
          })}
        </div>
        <div className="nav__user">
          <div className="nav__user-meta">
            <span className="nav__user-name">{displayName}</span>
            <span className="nav__user-role">{displayRole}</span>
          </div>
          <div className="nav__avatar" aria-hidden="true">{initials}</div>
          <button
            type="button"
            className="nav__signout"
            onClick={onSignOut}
            title="Sign out"
          >
            Sign out
          </button>
        </div>
      </nav>
      {children}
    </div>
  );
}