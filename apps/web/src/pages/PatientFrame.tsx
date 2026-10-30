/**
 * PatientFrame — top-level frame for the patient-facing flow.
 *
 * Distinct from the admin AppShell (E1-S0-ui): 1200px max-width per
 * mockups 02/03/04. The frame is sticky so the long booking flow
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
 *
 * ── Navigation polish ──────────────────────────────────────────
 *
 * The patient nav was the odd one out among the four role surfaces:
 *
 *   - Its links were 14px with a 24px gap, while the doctor /
 *     receptionist / admin links are 13px with a 12px gap.
 *   - Its active link had NO indicator beyond a colour shift — the
 *     other three all carry a 2px teal underline.
 *   - It had NO hover state.
 *   - It had NO role indicator, so the patient bar was the only one
 *     that did not say who you were signed in as.
 *   - Two of its four links ("Branches", "Help") were inert `<span>`
 *     elements that did nothing when clicked. A nav link that goes
 *     nowhere is worse than no nav link, so they are GONE rather than
 *     rendered greyed-out.
 *
 * The links now share the `.staff-nav__link` visual language
 * (13px, 12px gap, teal + 2px underline when active) and the frame
 * carries a "Patient" role pill matching the doctor's.
 */
import type { ReactNode } from 'react';
import { useAuth, logout } from '../auth/store';
import { BrandMark } from '../brand/BrandMark';
import { initialsOf } from './booking-utils';
import './styles/patient-frame.css';

interface PatientFrameProps {
  children: ReactNode;
  step?: 1 | 2 | 3 | 4 | 5;
  /**
   * The section currently on screen.
   *
   * `cancel-occurrence` is a STEP of "My appointments" rather than a
   * section of its own, so it highlights that link — the same alias
   * treatment the staff nav uses for the recurring flow's
   * preview / confirm screens.
   */
  activeLink?: 'find-doctor' | 'my-appointments' | 'cancel-occurrence';
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

  // The cancel-occurrence screen is a step of "My appointments", so
  // it highlights that link rather than "Find a doctor".
  const currentSection =
    activeLink === 'cancel-occurrence' ? 'my-appointments' : activeLink;

  return (
    <div className="patient-frame__root" data-testid="patient-frame">
      <nav className="patient-frame__nav" data-testid="patient-frame-nav">
        <div className="patient-frame__brand" data-testid="patient-frame-brand">
          <BrandMark size={28} className="patient-frame__brand-logo" />
          MediSlot
          <span className="patient-frame__role-pill" data-testid="patient-frame-role-pill">
            Patient
          </span>
        </div>
        <div className="patient-frame__links" data-testid="patient-frame-links">
          <button
            type="button"
            className={
              currentSection === 'find-doctor'
                ? 'patient-frame__link patient-frame__link--active'
                : 'patient-frame__link'
            }
            data-testid="patient-frame-find-doctor"
            aria-current={currentSection === 'find-doctor' ? 'page' : undefined}
            onClick={goFindDoctor}
          >
            Find a doctor
          </button>
          <button
            type="button"
            className={
              currentSection === 'my-appointments'
                ? 'patient-frame__link patient-frame__link--active'
                : 'patient-frame__link'
            }
            data-testid="patient-frame-my-appts"
            aria-current={
              currentSection === 'my-appointments' ? 'page' : undefined
            }
            onClick={goMyAppointments}
          >
            My appointments
          </button>
        </div>
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
        <button
          type="button"
          className="patient-frame__cta"
          data-testid="patient-frame-signout"
          title={stored ? 'Sign out' : 'Sign in'}
          onClick={onClickSignOut}
        >
          {stored ? 'Sign out' : 'Book appointment'}
        </button>
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
