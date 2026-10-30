/**
 * App shell — the top nav shared by every authenticated page.
 *
 * W10 update: the user chip and "Sign out" affordance are now driven by
 * the auth store. When no session is present (e.g. parent forgot to gate
 * the shell), the chip falls back to the static demo identity.
 *
 * ── Navigation polish ──────────────────────────────────────────
 *
 * The admin nav now shares one visual language with the doctor /
 * receptionist / patient navs:
 *
 *   - The bar is `--space-7` (16px) tall, like the staff bars. It
 *     used to be `--space-6` (14px), 4px shorter.
 *   - The links use `var(--space-5)` (12px) gaps, like the staff
 *     links. It used to be a hard-coded `22px` — a token-invariant
 *     violation AND visibly wider than every other surface.
 *   - The links are 13px at weight 500 with a teal hover and a 2px
 *     teal underline when active, matching `.staff-nav__link`.
 *   - The role is announced by a PILL next to the wordmark, like the
 *     doctor / receptionist / patient bars. It used to be the literal
 *     text "MediSlot · Admin" welded to the brand.
 *
 * The active link is a `<button>` with `aria-current="page"` — the
 * same element the staff nav uses. It used to be a `<span>`, which
 * meant the active item was not the same kind of control as the
 * others.
 */
import type { ReactNode } from 'react';
import { useAuth, logout } from './auth/store';
import type { AuthRole } from './api/client';
import { BrandMark } from './brand/BrandMark';
import './styles/shell.css';

export type AdminSection =
  | 'branches'
  | 'doctors'
  | 'receptionists'
  | 'types';

export type AdminSubPage =
  | { key: 'branch-hours'; branchId: string }
  | { key: 'doctor-assign'; doctorId: string }
  | { key: 'doctor-schedule'; doctorId: string }
  | { key: 'doctor-blocks'; doctorId: string };

const SECTIONS: { key: AdminSection; label: string }[] = [
  { key: 'branches', label: 'Branches' },
  { key: 'doctors', label: 'Doctors' },
  { key: 'receptionists', label: 'Receptionists' },
  { key: 'types', label: 'Appointment types' },
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

  return (
    <div className="shell">
      <nav className="nav" data-testid="admin-nav">
        <div className="nav__brand" data-testid="admin-nav-brand">
          <BrandMark size={28} className="nav__brand-logo" />
          MediSlot
          <span className="nav__role-pill" data-testid="admin-nav-role-pill">
            {displayRole}
          </span>
        </div>
        <div className="nav__links" role="navigation" aria-label="Sections">
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              type="button"
              className={
                s.key === active
                  ? 'nav__link nav__link--active'
                  : 'nav__link'
              }
              aria-current={s.key === active ? 'page' : undefined}
              data-testid={`admin-nav-${s.key}`}
              onClick={() => {
                if (onNavigate) onNavigate(s.key);
              }}
              title={s.label}
            >
              {s.label}
            </button>
          ))}
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