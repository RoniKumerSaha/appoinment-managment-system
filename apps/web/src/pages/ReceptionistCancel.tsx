/**
 * ReceptionistCancel — E5-S3 UI (mock 15).
 *
 * Two stacked steps:
 *   1. Pick the appointment to cancel (radio list of today's Scheduled
 *      rows at the receptionist's branch).
 *   2. Pick a reason + optional notes, then confirm.
 *
 * The reason select mirrors the BR-036 enumeration from the backend
 * (`reason: string`, free-form per spec — but the UI presents a
 * curated list to nudge the receptionist toward consistent audit
 * text). Free-form notes map to the same `reason` field as a
 * concatenated string when "Other (write in notes)" is selected.
 *
 * Atomic + audited: the POST is idempotent; a 422
 * `already_in_terminal_state` returns the user to step 1 with the
 * appointment's row disabled.
 *
 * On success, the page renders the confirmation toast (UX-FLOWS F-14:
 * "Cancelled. Slot released.") and resets back to step 1 so the
 * receptionist can cancel another appointment.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ApiError,
  getReceptionistToday,
  receptionistCancel,
  type ReceptionistAppointmentStatus,
  type ReceptionistTodayAppointment,
  type ReceptionistTodayResponse,
} from '../api/client';
import { ReceptionistFrame } from './ReceptionistFrame';
import {
  formatDateHeader,
  formatTimeLocal,
  maskPhone,
} from './recep-utils';
import './ReceptionistCancel.css';

interface ReceptionistCancelProps {
  preselectedAppointmentId?: string;
  onBackToToday: () => void;
}

const REASON_OPTIONS: Array<{ value: string; label: string; custom?: boolean }> = [
  { value: 'Patient called to cancel', label: 'Patient called to cancel' },
  {
    value: 'Patient no-show / didn\'t arrive',
    label: "Patient no-show / didn't arrive",
  },
  { value: 'Doctor unavailable', label: 'Doctor unavailable' },
  { value: 'Scheduling conflict', label: 'Scheduling conflict' },
  {
    value: 'Walked in but wants different branch',
    label: 'Walked in but wants different branch',
  },
  { value: '__other__', label: 'Other (write in notes)', custom: true },
];

const REASON_MAX = 500;

function describeCancelError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return 'Session expired. Please sign in again.';
    if (err.status === 403) {
      if (err.code === 'outside_branch_scope') {
        return 'That appointment is not at your branch.';
      }
      return 'You do not have access to cancel at this branch.';
    }
    if (err.status === 400) {
      if (err.code === 'reason_required') {
        return 'A reason is required.';
      }
      if (err.code === 'reason_too_long') {
        return `Reason is too long (max ${REASON_MAX} characters).`;
      }
    }
    if (err.status === 404) {
      return 'That appointment no longer exists.';
    }
    if (err.status === 422 && err.code === 'already_in_terminal_state') {
      return 'This appointment is no longer Scheduled — refresh the list.';
    }
    return `Could not cancel (${err.code}).`;
  }
  if (err instanceof TypeError) {
    return 'Connection failed. Is the API running on :3001?';
  }
  return 'Could not cancel the appointment.';
}

function statusPillClass(s: ReceptionistAppointmentStatus): string {
  switch (s) {
    case 'Scheduled':
      return 'recep-cancel__pill recep-cancel__pill--scheduled';
    case 'Completed':
      return 'recep-cancel__pill recep-cancel__pill--completed';
    case 'Cancelled':
      return 'recep-cancel__pill recep-cancel__pill--cancelled';
    case 'No-Show':
      return 'recep-cancel__pill recep-cancel__pill--no-show';
  }
}

function statusPillLabel(s: ReceptionistAppointmentStatus): string {
  // E7-S5 — pill meaning must not rely on colour alone; every status
  // carries a Unicode glyph prefix so the meaning survives a colour-
  // blind viewer or a stripped stylesheet.
  switch (s) {
    case 'Scheduled':
      return '● Scheduled';
    case 'Completed':
      return '✓ Done';
    case 'Cancelled':
      return '✕ Cancelled';
    case 'No-Show':
      return '⊘ No-show';
  }
}

export function ReceptionistCancel({
  preselectedAppointmentId,
  onBackToToday,
}: ReceptionistCancelProps) {
  const [data, setData] = useState<ReceptionistTodayResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string>(
    preselectedAppointmentId ?? '',
  );
  const [reasonKey, setReasonKey] = useState<string>(REASON_OPTIONS[2]!.value);
  const [notes, setNotes] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string } | null>(null);

  // Load today's appointments. The receptionist cancels any
  // appointment at their branch, but for the picker we filter to
  // Scheduled (terminal-state rows aren't cancellable per BR-053).
  useEffect(() => {
    setLoading(true);
    setLoadErr(null);
    getReceptionistToday({ status: 'Scheduled' })
      .then((res) => {
        setData(res);
        setLoading(false);
        // If a preselected id was passed in, keep it; otherwise pick
        // the first row.
        if (!preselectedAppointmentId && res.appointments.length > 0) {
          setSelectedId(res.appointments[0]!.id);
        }
      })
      .catch((e: unknown) => {
        setLoadErr(describeCancelError(e));
        setLoading(false);
      });
  }, [preselectedAppointmentId]);

  const selected: ReceptionistTodayAppointment | undefined = useMemo(() => {
    if (data === null || selectedId === '') return undefined;
    return data.appointments.find((a) => a.id === selectedId);
  }, [data, selectedId]);

  const onConfirm = useCallback((): void => {
    if (selected === undefined) return;
    const trimmedNotes = notes.trim();
    let reasonText: string;
    if (reasonKey === '__other__') {
      if (trimmedNotes.length === 0) {
        setSubmitErr('Write a reason in the notes when Other is selected.');
        return;
      }
      reasonText = trimmedNotes;
    } else {
      reasonText = trimmedNotes.length > 0 ? `${reasonKey} — ${trimmedNotes}` : reasonKey;
    }
    if (reasonText.length > REASON_MAX) {
      setSubmitErr(`Reason is too long (max ${REASON_MAX} characters).`);
      return;
    }
    setSubmitting(true);
    setSubmitErr(null);
    receptionistCancel({
      appointment_id: selected.id,
      reason: reasonText,
    })
      .then(() => {
        setSubmitting(false);
        setToast({ message: 'Cancelled. Slot released.' });
        // Auto-dismiss the toast after 4s.
        window.setTimeout(() => setToast(null), 4000);
        // Reset for another cancellation. Clear notes + reason; keep
        // the preselected id so the receptionist can cancel multiple
        // appointments in a row without re-picking.
        setNotes('');
        setReasonKey(REASON_OPTIONS[2]!.value);
        // Refetch the today list so the just-cancelled row disappears
        // from the picker (server filters out terminal states on
        // refetch).
        getReceptionistToday({ status: 'Scheduled' })
          .then((res) => {
            setData(res);
            if (res.appointments.length > 0) {
              setSelectedId(res.appointments[0]!.id);
            } else {
              setSelectedId('');
            }
          })
          .catch(() => {
            // Soft-fail — the cancel succeeded; just leave the list
            // as-is so the receptionist sees the now-stale row. They
            // can hit "Back" to refresh.
          });
      })
      .catch((e: unknown) => {
        setSubmitErr(describeCancelError(e));
        setSubmitting(false);
      });
  }, [selected, reasonKey, notes]);

  return (
    <ReceptionistFrame>
      <div className="recep-cancel__page">
        <div className="recep-cancel__header">
          <button
            type="button"
            className="recep-cancel__crumb"
            onClick={onBackToToday}
          >
            ‹ Today
          </button>
          <h1 className="recep-cancel__title">Cancel an appointment</h1>
          <p className="recep-cancel__sub">
            Choose an appointment, give a reason, confirm.
          </p>
        </div>

        {/* Step 1 */}
        <div className="recep-cancel__step">
          <div className="recep-cancel__step-head">
            <div className="recep-cancel__step-num recep-cancel__step-num--done">
              1
            </div>
            <div className="recep-cancel__step-title">Pick the appointment</div>
            <div className="recep-cancel__step-hint">
              {data !== null
                ? `${data.appointments.length} scheduled today`
                : '—'}
            </div>
          </div>
          {loadErr && (
            <div className="recep-cancel__error">{loadErr}</div>
          )}
          {!loadErr && loading && data === null && (
            <div className="recep-cancel__loading">Loading appointments…</div>
          )}
          {!loadErr && data !== null && data.appointments.length === 0 && (
            <div className="recep-cancel__empty">
              No scheduled appointments today at {data.branch.name}.
            </div>
          )}
          {!loadErr && data !== null && data.appointments.length > 0 && (
            <div className="recep-cancel__list">
              {data.appointments.map((a) => {
                const isSelected = a.id === selectedId;
                return (
                  <button
                    key={a.id}
                    type="button"
                    className={
                      isSelected
                        ? 'recep-cancel__item recep-cancel__item--selected'
                        : 'recep-cancel__item'
                    }
                    onClick={() => setSelectedId(a.id)}
                  >
                    <div
                      className={
                        isSelected
                          ? 'recep-cancel__radio recep-cancel__radio--selected'
                          : 'recep-cancel__radio'
                      }
                    />
                    <div className="recep-cancel__time">
                      {formatTimeLocal(a.start_datetime, data.branch.tz)}
                    </div>
                    <div className="recep-cancel__body">
                      <div className="recep-cancel__patient">
                        {maskPhone(a.patient_phone)}
                      </div>
                      <div className="recep-cancel__meta">
                        Dr. {a.doctor_name} · {a.appointment_type_name}
                      </div>
                    </div>
                    <span className={statusPillClass(a.status)}>
                      {statusPillLabel(a.status)}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Step 2 */}
        {selected && data !== null && (
          <div className="recep-cancel__step recep-cancel__step--danger">
            <div className="recep-cancel__step-head">
              <div className="recep-cancel__step-num recep-cancel__step-num--danger">
                2
              </div>
              <div className="recep-cancel__step-title">
                Reason + confirm · {maskPhone(selected.patient_phone)}
              </div>
              <div className="recep-cancel__step-hint">
                Slot will be released
              </div>
            </div>

            <div className="recep-cancel__appt-card">
              <div className="recep-cancel__row">
                <span className="recep-cancel__k">Patient</span>
                <span className="recep-cancel__v">
                  {maskPhone(selected.patient_phone)}
                </span>
              </div>
              <div className="recep-cancel__row">
                <span className="recep-cancel__k">Phone</span>
                <span className="recep-cancel__v">
                  {selected.patient_phone}
                </span>
              </div>
              <div className="recep-cancel__row">
                <span className="recep-cancel__k">When</span>
                <span className="recep-cancel__v">
                  Today, {formatDateHeader(data.date).replace(/^[\w]+,\s*/, '')} ·{' '}
                  {formatTimeLocal(selected.start_datetime, data.branch.tz)} —{' '}
                  {formatTimeLocal(selected.end_datetime, data.branch.tz)}
                </span>
              </div>
              <div className="recep-cancel__row">
                <span className="recep-cancel__k">Doctor</span>
                <span className="recep-cancel__v">Dr. {selected.doctor_name}</span>
              </div>
              <div className="recep-cancel__row">
                <span className="recep-cancel__k">Branch</span>
                <span className="recep-cancel__v">{data.branch.name}</span>
              </div>
            </div>

            <div className="recep-cancel__form-group">
              <label className="recep-cancel__label">
                Cancellation reason <span className="recep-cancel__req">*</span>
              </label>
              <select
                className="recep-cancel__select"
                value={reasonKey}
                onChange={(e) => setReasonKey(e.target.value)}
              >
                {REASON_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <div className="recep-cancel__hint">
                Required by BR-036. Saved to audit log (FR-034).
              </div>
            </div>

            <div className="recep-cancel__form-group">
              <label className="recep-cancel__label">
                Notes{reasonKey === '__other__' ? ' *' : ' (optional)'}
              </label>
              <textarea
                className="recep-cancel__textarea"
                placeholder="e.g. patient said rescheduling for next week, will call back"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
              />
            </div>

            {submitErr && (
              <div className="recep-cancel__error recep-cancel__error--inline">
                {submitErr}
              </div>
            )}

            <div className="recep-cancel__impact">
              <div className="recep-cancel__impact-head">
                ⚠ This will:
              </div>
              <ul>
                <li>
                  Mark appointment as <strong>Cancelled</strong> (atomic,
                  audited)
                </li>
                <li>Release the slot back to availability</li>
              </ul>
            </div>

            <div className="recep-cancel__step-foot">
              <div className="recep-cancel__audit">
                Atomic: <code>Appointment.cancel</code> · audit:{' '}
                <code>status.changed</code>
              </div>
              <div className="recep-cancel__foot-actions">
                <button
                  type="button"
                  className="recep-cancel__btn-ghost"
                  onClick={onBackToToday}
                >
                  Back
                </button>
                <button
                  type="button"
                  className="recep-cancel__btn-secondary"
                  onClick={onBackToToday}
                >
                  Keep appointment
                </button>
                <button
                  type="button"
                  className="recep-cancel__btn-danger"
                  onClick={onConfirm}
                  disabled={submitting}
                >
                  {submitting ? 'Cancelling…' : 'Confirm cancellation'}
                </button>
              </div>
            </div>
          </div>
        )}

        {toast && (
          <div className="recep-cancel__toast-stack">
            <div className="recep-cancel__toast">
              <span className="recep-cancel__toast-icon" aria-hidden="true">
                ✓
              </span>
              <span className="recep-cancel__toast-text">{toast.message}</span>
              <button
                type="button"
                className="recep-cancel__toast-x"
                onClick={() => setToast(null)}
                title="Dismiss"
              >
                ×
              </button>
            </div>
          </div>
        )}
      </div>
    </ReceptionistFrame>
  );
}