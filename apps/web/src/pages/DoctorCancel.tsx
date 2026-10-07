/**
 * DoctorCancel — E5-S2 UI (mock 25, stacked-vertical condensed
 * as a modal).
 *
 * The doctor cancels a Scheduled appointment on behalf of a
 * patient. Per FR-035 / BR-037 a reason is REQUIRED; the server
 * trims + caps at 500 chars. The slot is RELEASED on success
 * (BR-053 / FR-050): the row's GIST exclusion is scoped on
 * status='Scheduled', so a Cancelled row no longer blocks the
 * time range. The audit row carries
 * `payload = {reason, recurring_origin?}` (E6-S4 enrichment).
 *
 * The reason presets mirror the receptionist's preset list (E5-S3
 * UI) plus an "Other" option that forces the doctor to type into
 * the freeform note.
 *
 * Triggered from DoctorAffected's "Cancel" affordance per
 * affected kanban card.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ApiError,
  doctorCancel,
} from '../api/client';
import {
  formatDateInTz,
  formatMonthDay,
  formatTimeInTz,
} from './doctor-utils';
import './DoctorCancel.css';

export interface DoctorCancelTarget {
  id: string;
  branchTz: string;
  start_datetime: string;
  end_datetime: string;
  patientLabel: string;
  maskedPhone: string;
  branchName: string;
}

interface DoctorCancelProps {
  appointment: DoctorCancelTarget;
  onCancel: () => void;
  onCancelled: (reason: string) => Promise<void> | void;
  describeError: (err: unknown) => string;
}

interface ReasonPreset {
  key: string;
  label: string;
  desc: string;
  /** When truthy, this preset requires a freeform note. */
  needsNote: boolean;
}

const REASON_PRESETS: ReasonPreset[] = [
  {
    key: 'patient_requested',
    label: 'Patient requested',
    desc: 'Patient or family called in',
    needsNote: false,
  },
  {
    key: 'doctor_unavailable',
    label: 'Doctor unavailable',
    desc: 'Emergency, illness, schedule conflict',
    needsNote: false,
  },
  {
    key: 'scheduling_conflict',
    label: 'Scheduling conflict',
    desc: 'Overbooked, branch issue',
    needsNote: false,
  },
  {
    key: 'other',
    label: 'Other',
    desc: 'Please describe below',
    needsNote: true,
  },
];

const REASON_MAX = 500;

export function DoctorCancel({
  appointment,
  onCancel,
  onCancelled,
  describeError,
}: DoctorCancelProps) {
  const [selectedKey, setSelectedKey] = useState<string>(
    REASON_PRESETS[0]!.key,
  );
  const [note, setNote] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);

  const selected = useMemo(
    () => REASON_PRESETS.find((p) => p.key === selectedKey) ?? null,
    [selectedKey],
  );

  // Close on Escape (only when not submitting).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !submitting) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, submitting]);

  const onConfirm = useCallback(async (): Promise<void> => {
    if (selected === null) return;
    const trimmed = note.trim();
    if (selected.needsNote && trimmed.length === 0) {
      setErr('Please describe the reason.');
      return;
    }
    // Compose the audit reason: preset label + optional freeform.
    const reason =
      selected.needsNote || trimmed.length > 0
        ? `${selected.label}: ${trimmed.length > 0 ? trimmed : '(no detail)'}`.trim()
        : selected.label;

    setSubmitting(true);
    setErr(null);
    try {
      await doctorCancel(appointment.id, { reason });
      await onCancelled(reason);
    } catch (e: unknown) {
      setErr(describeError(e));
      setSubmitting(false);
    }
  }, [selected, note, appointment.id, onCancelled, describeError]);

  const tz = appointment.branchTz;
  const startDate = formatDateInTz(appointment.start_datetime, tz);
  const startTime = formatTimeInTz(appointment.start_datetime, tz);
  const endTime = formatTimeInTz(appointment.end_datetime, tz);
  const monthDay = formatMonthDay(appointment.start_datetime, tz);
  const [month, day] = monthDay.split(' ');
  const dow = new Date(appointment.start_datetime).toLocaleDateString(
    'en-US',
    { weekday: 'short', timeZone: tz === 'UTC' ? undefined : tz },
  );

  const trimmedNoteLen = note.trim().length;
  const canSubmit =
    !submitting &&
    selected !== null &&
    (!selected.needsNote || trimmedNoteLen > 0);

  return (
    <div
      className="doc-cancel__backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`Cancel appointment for ${appointment.patientLabel}`}
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) onCancel();
      }}
    >
      <div className="doc-cancel__modal">
        <div className="doc-cancel__head">
          <div className="doc-cancel__head-icon" aria-hidden="true">
            !
          </div>
          <div className="doc-cancel__head-text">
            <div className="doc-cancel__crumb">
              Affected queue → {appointment.patientLabel} → Cancel
            </div>
            <h2 className="doc-cancel__title">Cancel this appointment</h2>
            <div className="doc-cancel__sub">
              A reason is required. The slot will be released.
            </div>
          </div>
        </div>

        <div className="doc-cancel__body">
          <div className="doc-cancel__appt">
            <div className="doc-cancel__appt-time">
              <div className="doc-cancel__appt-month">{month ?? ''}</div>
              <div className="doc-cancel__appt-day">{day ?? ''}</div>
              <div className="doc-cancel__appt-dow">{dow}</div>
            </div>
            <div className="doc-cancel__appt-body">
              <div className="doc-cancel__appt-name">
                {appointment.patientLabel}
              </div>
              <div className="doc-cancel__appt-meta">
                {startDate} · {startTime} – {endTime} ·{' '}
                {appointment.branchName} · {appointment.maskedPhone}
              </div>
            </div>
          </div>

          <div className="doc-cancel__label">
            Reason
          </div>
          <div className="doc-cancel__reasons" role="radiogroup" aria-label="Cancel reason">
            {REASON_PRESETS.map((p) => {
              const isSelected = p.key === selectedKey;
              return (
                <button
                  type="button"
                  key={p.key}
                  className={
                    'doc-cancel__reason' +
                    (isSelected ? ' doc-cancel__reason--selected' : '')
                  }
                  role="radio"
                  aria-checked={isSelected}
                  onClick={() => {
                    setSelectedKey(p.key);
                    setErr(null);
                  }}
                  disabled={submitting}
                >
                  <span className="doc-cancel__radio" aria-hidden="true" />
                  <span className="doc-cancel__reason-body">
                    <div className="doc-cancel__reason-label">{p.label}</div>
                    <div className="doc-cancel__reason-desc">{p.desc}</div>
                  </span>
                </button>
              );
            })}
          </div>

          <div className="doc-cancel__label">
            Internal note
            <span className="req">*</span>
            {selected?.needsNote === false && (
              <span className="doc-cancel__label-optional">
                (optional)
              </span>
            )}
          </div>
          <textarea
            className="doc-cancel__textarea"
            placeholder="e.g. Patient called at 10:25, asked to reschedule next week"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={submitting}
            maxLength={REASON_MAX}
            aria-label="Internal note"
          />
          <div className="doc-cancel__count">
            {note.length} / {REASON_MAX}
          </div>

          <div className="doc-cancel__impact">
            <span className="doc-cancel__impact-icon" aria-hidden="true">
              ⚠
            </span>
            <span>
              <strong>Slot will be released</strong> and become bookable
              again immediately. The patient will see "Cancelled by clinic"
              and can rebook from the booking page.
            </span>
          </div>

          {err && <div className="doc-cancel__err">{err}</div>}

          <div className="doc-cancel__audit">
            Audit row:{' '}
            <code>
              action=cancelled, actor=doctor, payload=&#123;reason, recurring_origin?&#125;
            </code>
          </div>
        </div>

        <div className="doc-cancel__foot">
          <button
            type="button"
            className="doc-cancel__btn-ghost"
            onClick={onCancel}
            disabled={submitting}
          >
            Keep appointment
          </button>
          <div className="doc-cancel__foot-right">
            <button
              type="button"
              className="doc-cancel__btn-secondary"
              onClick={onCancel}
              disabled={submitting}
            >
              Back to queue
            </button>
            <button
              type="button"
              className="doc-cancel__btn-danger"
              onClick={() => {
                void onConfirm();
              }}
              disabled={!canSubmit}
            >
              {submitting ? 'Cancelling…' : 'Confirm cancel + release slot'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}