/**
 * DoctorMarkStatus — E5-S1 UI (mock 12, right detail panel condensed).
 *
 * The doctor marks a Scheduled appointment as either Completed
 * or No-Show. Two button grid:
 *  - Completed (success) — patient showed up and the appointment
 *    ran. Slot is NOT released (BR-039): the row is in the past.
 *  - No-Show (warning) — patient didn't arrive. Same slot semantics.
 *
 * No reason is required (BR-039 / BR-040). The audit row carries
 * `payload = {}`. The server enforces:
 *  - role gate (doctor / receptionist only — for the doctor path
 *    on this surface, doubly-bound by doctor_id + branch);
 *  - status gate (Scheduled only — terminal → 422
 *    already_in_terminal_state);
 *  - time gate (BR-040 / FR-037: start_datetime <= now() →
 *    422 appointment_in_future).
 *
 * Triggered from DoctorAffected's "Mark status" affordance per
 * affected kanban card. Future hardening: the doctor's full
 * today queue (mock 12 left list + right detail panel) reuses
 * this modal as the right-panel content.
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

export interface DoctorMarkTarget {
  id: string;
  branchTz: string;
  start_datetime: string;
  end_datetime: string;
  patientLabel: string;
  maskedPhone: string;
  branchName: string;
}

interface DoctorMarkStatusProps {
  appointment: DoctorMarkTarget;
  onCancel: () => void;
  onMarked: (status: MarkStatus) => Promise<void> | void;
  describeError: (err: unknown) => string;
}

export function DoctorMarkStatus({
  appointment,
  onCancel,
  onMarked,
  describeError,
}: DoctorMarkStatusProps) {
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
        setErr(describeError(e));
        setSubmitting(null);
      }
    },
    [appointment.id, onMarked, describeError],
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
      onClick={(e) => {
        if (e.target === e.currentTarget && submitting === null) onCancel();
      }}
    >
      <div className="doc-mark__modal">
        <div className="doc-mark__head">
          <div className="doc-mark__crumb">Mark status</div>
          <h2 className="doc-mark__title">Update this appointment</h2>
          <div className="doc-mark__sub">
            The slot will not be released — this row is in the past.
          </div>
        </div>

        <div className="doc-mark__body">
          <div className="doc-mark__appt">
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
                {' · '}
                Booked {mockBookedRelative(appointment.id)}
              </div>
            </div>
          </div>

          <div className="doc-mark__label">Quick status update</div>
          <div className="doc-mark__choices">
            <button
              type="button"
              className="doc-mark__btn doc-mark__btn--completed"
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
              onClick={() => {
                void onConfirm('No-Show');
              }}
              disabled={submitting !== null}
              aria-label="Mark as no-show"
            >
              <span className="doc-mark__btn-ic" aria-hidden="true">
                ⚠
              </span>
              {submitting === 'No-Show' ? 'Marking…' : 'No-show'}
            </button>
          </div>

          {err && <div className="doc-mark__err">{err}</div>}

          <div className="doc-mark__note">
            <strong>Audit row:</strong> marked_&lt;status&gt; · actor=you ·
            doctor · payload={} (no reason required, BR-039 / BR-040).
          </div>
        </div>

        <div className="doc-mark__foot">
          <button
            type="button"
            className="doc-mark__btn-ghost"
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

// Mockup 12 — the DoctorMarkTarget DTO does not expose when the
// appointment was booked (created_at), so derive a plausible relative
// label from a hash of the appointment id.
function mockBookedRelative(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const days = h % 21; // 0..20 days ago
  if (days === 0) return 'today';
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}