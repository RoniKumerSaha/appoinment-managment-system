/**
 * App shell — the top nav shared by every admin page.
 *
 * The shell renders the brand, the 5-link admin nav, and the user chip.
 * The active link is passed in by the page (so the shell stays
 * route-agnostic). Other admin sections are not yet implemented; the
 * non-active links are rendered as `<button>`s with a `cursor: not-allowed`
 * visual hint to communicate "not yet".
 */
import type { ReactNode } from 'react';
import '../styles/shell.css';

export type AdminSection = 'clinic' | 'branches' | 'doctors' | 'receptionists' | 'audit';

const SECTIONS: { key: AdminSection; label: string; href: string }[] = [
  { key: 'clinic', label: 'Clinic', href: '/admin/clinic' },
  { key: 'branches', label: 'Branches', href: '/admin/branches' },
  { key: 'doctors', label: 'Doctors', href: '/admin/doctors' },
  { key: 'receptionists', label: 'Receptionists', href: '/admin/receptionists' },
  { key: 'audit', label: 'Audit log', href: '/admin/audit' },
];

interface AppShellProps {
  active: AdminSection;
  children: ReactNode;
}

export function AppShell({ active, children }: AppShellProps) {
  return (
    <div className="shell">
      <nav className="nav">
        <div className="nav__brand">
          <div className="nav__brand-logo" aria-hidden="true" />
          MediSlot · Admin
        </div>
        <div className="nav__links">
          {SECTIONS.map((s) =>
            s.key === active ? (
              <span
                key={s.key}
                className="nav__link nav__link--active"
                aria-current="page"
              >
                {s.label}
              </span>
            ) : (
              <button
                key={s.key}
                type="button"
                className="nav__link"
                disabled
                title="Not yet implemented"
              >
                {s.label}
              </button>
            ),
          )}
        </div>
        <div className="nav__user">
          <div className="nav__avatar" aria-hidden="true">SA</div>
          <div className="nav__user-meta">
            <span className="nav__user-name">Sara Al-Otaibi</span>
            <span className="nav__user-role">Administrator</span>
          </div>
        </div>
      </nav>
      {children}
    </div>
  );
}
