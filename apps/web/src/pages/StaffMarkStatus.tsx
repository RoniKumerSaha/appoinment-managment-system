/**
 * StaffMarkStatus — the shared "mark this appointment" modal.
 *
 * `POST /appointments/:id/mark-status` is open to BOTH staff roles:
 * the route accepts `claim.role === 'doctor'` (doubly-bound to
 * `claim.doctor_id` + branch) and `claim.role === 'receptionist'`
 * (branch-only, BR-004). The doctor surface reached it through
 * `DoctorMarkStatus`; the receptionist had NO entry point at all,
 * which made Act 4 of the receptionist flow — "the system already
 * flagged him, I confirm" — impossible.
 *
 * This component is that shared modal. It was `DoctorMarkStatus`,
 * renamed and generalised: the only role-specific part was the
 * audit note's `actor=you · doctor` wording, which is now a prop.
 * Both surfaces render the SAME component, so the two cannot drift
 * apart — the same argument that applies to the cancel modal.
 *
 * The wire value is 'No-show' (lowercase 's') because the DB column
 * is the `appointment_status` enum, which the API mirrors verbatim.
 * 'No-Show' is rejected with 400 invalid_status.
 *
 * No reason is required (BR-039 / BR-040). The audit row carries
 * `payload = {}`. The server enforces:
 *  - role gate (doctor / receptionist only),
 *  - status gate (Scheduled only — terminal → 422
 *    already_in_terminal_state),
 *  - time gate (BR-040 / FR-037: start_datetime <= now() →
 *    422 appointment_in_future).
 */
import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  markAppointmentStatus,
  type MarkStatus,
} from '../api/client';
import {
  formatDateInTz,
  formatMonthDay,
  formatTimeInTz,
} from './doctor-utils';
import './DoctorMarkStatus.css';

export interface StaffMarkTarget {
  id: string;
  branchTz: string;
  start_datetime: string;
  end_datetime: string;
  patientLabel: string;
  maskedPhone: string;
  branchName: string;
  /** When the appointment was booked (ISO UTC). Optional — the API
   *  exposes it on the affected-queue rows. When absent, the booking
   *  age line is omitted rather than invented. */
  createdAt?: string;
}

interface StaffMarkStatusProps {
  appointment: StaffMarkTarget;
  onCancel: () => void;
  onMarked: (status: MarkStatus) => Promise<void> | void;
  /**
   * Optional: invoked when the API returns 404 indicating the
   * row is no longer in the queue. The parent uses this to
   * close the modal and refresh the list so the user sees the
   * up-to-date state.
   */
  onStale?: () => void;
  describeError: (err: unknown) => string;
  /**
   * The acting role, for the audit note and the modal's breadcrumb.
   * 'doctor' or 'receptionist'.
   */
  role: 'doctor' | 'receptionist';
  /**
   * The breadcrumb shown above the title. The doctor opens this from
   * the affected queue; the receptionist from the day list.
   */
  crumb?: string;
}

const ROLE_LABEL: Record<'doctor' | 'receptionist', string> = {
  doctor: 'Doctor',
  receptionist: 'Reception',
};

export function StaffMarkStatus({
  appointment,
  onCancel,
  onMarked,
  onStale,
  describeError,
  role,
  crumb,
}: StaffMarkStatusProps) {
  const [submitting, setSubmitting] = useState<MarkStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && submitting === null) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, submitting]);

  const onConfirm = useCallback(
    async (status: MarkStatus): Promise<void> => {
      setSubmitting(status);
      setErr(null);
      try {
        await markAppointmentStatus(appointment.id, { status });
        await onMarked(status);
      } catch (e: unknown) {
        // Stale-row race (see DoctorCancel for the long-form
        // explanation). Hand the user back to the refreshed
        // list instead of leaving them on a phantom modal.
        if (
          e instanceof ApiError &&
          e.status === 404 &&
          typeof onStale === 'function'
        ) {
          onStale();
          return;
        }
        setErr(describeError(e));
        setSubmitting(null);
      }
    },
    [appointment.id, onMarked, onStale, describeError],
  );

  const tz = appointment.branchTz;
  const startDate = formatDateInTz(appointment.start_datetime, tz);
  const startTime = formatTimeInTz(appointment.start_datetime, tz);
  const endTime = formatTimeInTz(appointment.end_datetime, tz);
  const monthDay = formatMonthDay(appointment.start_datetime, tz);

  // Day / month for the date-block on the left of the appt card.
  // The MonthDay helper returns "Aug 22"; we split it.
  const [month, day] = monthDay.split(' ');
  const dow = new Date(appointment.start_datetime).toLocaleDateString(
    'en-US',
    { weekday: 'short', timeZone: tz === 'UTC' ? undefined : tz },
  );

  return (
    <div
      className="doc-mark__backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`Mark status for ${appointment.patientLabel}`}
      data-testid="doc-mark-modal"
      onClick={(e) => {
        if (e.target === e.currentTarget && submitting === null) onCancel();
      }}
    >
      <div className="doc-mark__modal" data-testid="doc-mark-frame">
        <div className="doc-mark__head" data-testid="doc-mark-head">
          <div className="doc-mark__crumb">
            {crumb ?? 'Mark status'}
          </div>
          <h2 className="doc-mark__title" data-testid="doc-mark-title">Update this appointment</h2>
          <div className="doc-mark__sub">
            The slot will not be released — this row is in the past.
          </div>
        </div>

        <div className="doc-mark__body" data-testid="doc-mark-body">
          <div className="doc-mark__appt" data-testid="doc-mark-appt">
            <div className="doc-mark__appt-time">
              <div className="doc-mark__appt-month">{month ?? ''}</div>
              <div className="doc-mark__appt-day">{day ?? ''}</div>
              <div className="doc-mark__appt-dow">{dow}</div>
            </div>
            <div className="doc-mark__appt-body">
              <div className="doc-mark__appt-name">
                {appointment.patientLabel}
              </div>
              <div className="doc-mark__appt-meta">
                {startDate} · {startTime} – {endTime} · {appointment.branchName}
                {' · '}
                {appointment.maskedPhone}
                {bookedRelative(appointment.createdAt) !== null && (
                  <>
                    {' · '}
                    Booked {bookedRelative(appointment.createdAt)}
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="doc-mark__label">Quick status update</div>
          <div className="doc-mark__choices" data-testid="doc-mark-choices">
            <button
              type="button"
              className="doc-mark__btn doc-mark__btn--completed"
              data-testid="doc-mark-completed-btn"
              onClick={() => {
                void onConfirm('Completed');
              }}
              disabled={submitting !== null}
              aria-label="Mark as completed"
            >
              <span className="doc-mark__btn-ic" aria-hidden="true">
                ✓
              </span>
              {submitting === 'Completed' ? 'Marking…' : 'Completed'}
            </button>
            <button
              type="button"
              className="doc-mark__btn doc-mark__btn--no-show"
              data-testid="doc-mark-no-show-btn"
              onClick={() => {
                void onConfirm('No-show');
              }}
              disabled={submitting !== null}
              aria-label="Mark as no-show"
            >
              <span className="doc-mark__btn-ic" aria-hidden="true">
                ⚠
              </span>
              {submitting === 'No-show' ? 'Marking…' : 'No-show'}
            </button>
          </div>

          {err && <div className="doc-mark__err" data-testid="doc-mark-error" role="alert">{err}</div>}

          <div className="doc-mark__note">
            <strong>Audit row:</strong> marked_&lt;status&gt; · actor=you ·
            {ROLE_LABEL[role].toLowerCase()} · payload=&#123;&#125; (no reason
            required, BR-039 / BR-040).
          </div>
        </div>

        <div className="doc-mark__foot" data-testid="doc-mark-foot">
          <button
            type="button"
            className="doc-mark__btn-ghost"
            data-testid="doc-mark-close-btn"
            onClick={onCancel}
            disabled={submitting !== null}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// Mockup 12 — the "Booked N days ago" line. This used to HASH the
// appointment id to invent a plausible-looking age, which meant the
// label was fiction: it never corresponded to when the patient actually
// booked. The API now exposes `created_at` on the affected-queue rows,
// so the age is derived from the real booking timestamp.
//
// Returns null when the booking time is unknown (or in the future, which
// would produce a negative age) — the caller then omits the line
// instead of showing a made-up value.
function bookedRelative(createdAtIso: string | undefined): string | null {
  if (createdAtIso === undefined) return null;
  const ms = Date.parse(createdAtIso);
  if (Number.isNaN(ms)) return null;
  const days = Math.floor((Date.now() - ms) / (24 * 60 * 60 * 1000));
  if (days < 0) return null;
  if (days === 0) return 'today';
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}
