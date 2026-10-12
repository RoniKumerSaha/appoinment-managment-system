/**
 * PatientFrame — top-level frame for the patient-facing flow.
 *
 * Distinct from the admin AppShell (E1-S0-ui): a thinner top nav
 * ("MediSlot" wordmark + 4 nav links + "Sign out"), 1200px max-width
 * per mockups 02/03/04. The frame is sticky so the long booking flow
 * keeps the progress bar visible while scrolling.
 *
 * Pixel-perfect match to:
 *   - docs/design/mockups/v1/mockups/02-doctor-picker.html (nav)
 *   - docs/design/mockups/v1/mockups/03-availability-calendar.html (nav)
 *   - docs/design/mockups/v1/mockups/04-patient-confirm.html (nav)
 *
 * The footer / privacy line from mockup 21 is omitted — only the
 * patient booking flow uses this frame, and the privacy line lives on
 * the LoginPage (E1-S0-ui).
 */
import type { ReactNode } from 'react';
import { useAuth, logout } from '../auth/store';
import { BrandMark } from '../brand/BrandMark';
import { initialsOf } from './booking-utils';
import './styles/patient-frame.css';

interface PatientFrameProps {
  children: ReactNode;
  step?: 1 | 2 | 3 | 4 | 5;
  activeLink?: 'find-doctor' | 'my-appointments';
  onNavigate?: (link: 'find-doctor' | 'my-appointments') => void;
  onSignOut?: () => void;
  /** Optional patient full name. When set, an avatar chip is rendered
   *  in the right column of the nav (mock 20 lines 79-82). */
  userName?: string;
}

const STEP_LABELS: Array<{ num: number; label: string }> = [
  { num: 1, label: 'Doctor' },
  { num: 2, label: 'Branch & type' },
  { num: 3, label: 'Date & time' },
  { num: 4, label: 'Your details' },
  { num: 5, label: 'Confirm' },
];

export function PatientFrame({
  children,
  step,
  activeLink = 'find-doctor',
  onNavigate,
  onSignOut,
  userName,
}: PatientFrameProps) {
  const { stored } = useAuth();
  const onClickSignOut = (): void => {
    if (onSignOut) onSignOut();
    logout();
  };
  const goFindDoctor = (): void => {
    if (onNavigate) onNavigate('find-doctor');
  };
  const goMyAppointments = (): void => {
    if (onNavigate) onNavigate('my-appointments');
  };
  return (
    <div className="patient-frame__root" data-testid="patient-frame">
      <nav className="patient-frame__nav" data-testid="patient-frame-nav">
        <div className="patient-frame__brand" data-testid="patient-frame-brand">
          <BrandMark size={28} className="patient-frame__brand-logo" />
          MediSlot
        </div>
        <div className="patient-frame__links" data-testid="patient-frame-links">
          {activeLink === 'find-doctor' ? (
            <span
              className="patient-frame__link patient-frame__link--active"
              data-testid="patient-frame-find-doctor"
            >
              Find a doctor
            </span>
          ) : (
            <button
              type="button"
              className="patient-frame__link"
              data-testid="patient-frame-find-doctor"
              onClick={goFindDoctor}
            >
              Find a doctor
            </button>
          )}
          {activeLink === 'my-appointments' ? (
            <span
              className="patient-frame__link patient-frame__link--active"
              data-testid="patient-frame-my-appts"
            >
              My appointments
            </span>
          ) : (
            <button
              type="button"
              className="patient-frame__link"
              data-testid="patient-frame-my-appts"
              onClick={goMyAppointments}
            >
              My appointments
            </button>
          )}
          <span
            className="patient-frame__link patient-frame__link--muted"
            title="Branches — not yet implemented"
          >
            Branches
          </span>
          <span
            className="patient-frame__link patient-frame__link--muted"
            title="Help — not yet implemented"
          >
            Help
          </span>
        </div>
        <button
          type="button"
          className="patient-frame__cta"
          data-testid="patient-frame-signout"
          title={stored ? 'Sign out' : 'Sign in'}
          onClick={onClickSignOut}
        >
          {stored ? 'Sign out' : 'Book appointment'}
        </button>
        {userName && (
          <div
            className="patient-frame__user-chip"
            data-testid="patient-frame-user-chip"
            title={`Signed in as ${userName}`}
          >
            <span className="patient-frame__user-avatar" aria-hidden="true">
              {initialsOf(userName)}
            </span>
            <span className="patient-frame__user-name">{userName}</span>
          </div>
        )}
      </nav>

      {step !== undefined && (
        <div className="patient-frame__progress" data-testid="patient-frame-progress">
          {STEP_LABELS.map((s, i) => {
            const isCurrent = s.num === step;
            const isDone = step > s.num;
            return (
              <span key={s.num} style={{ display: 'contents' }}>
                {i > 0 && (
                  <span className="patient-frame__progress-sep">›</span>
                )}
                <span
                  className={
                    isCurrent
                      ? 'patient-frame__step patient-frame__step--current'
                      : isDone
                        ? 'patient-frame__step patient-frame__step--done'
                        : 'patient-frame__step'
                  }
                  data-testid={`patient-frame-step-${s.num}`}
                >
                  <span className="patient-frame__step-n">
                    {isDone ? '✓' : s.num}
                  </span>
                  {s.label}
                </span>
              </span>
            );
          })}
        </div>
      )}

      <div className="patient-frame__body" data-testid="patient-frame-body">{children}</div>
    </div>
  );
}