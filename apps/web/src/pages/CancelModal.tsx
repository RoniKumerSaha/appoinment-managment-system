/**
 * CancelModal — E4-S2 UI (mock 22).
 *
 * The patient-cancel confirmation modal. The mockup uses a centered
 * 480px-wide modal over a faded page (page opacity 0.35). The
 * "Keep appointment" / "Cancel appointment" buttons map to
 * `onClose` and `patientCancel(appointment_id)` respectively.
 *
 * The route does NOT require a reason (FR-033 explicit) — the
 * modal surfaces "No reason needed from you" instead of a reason
 * select, mirroring the receptionist flow's distinction
 * (E5-S3 / FR-034 is the one that requires a reason).
 */
import { useState } from 'react';
import { ApiError, patientCancel } from '../api/client';
import './CancelModal.css';

interface CancelModalProps {
  appointmentId: string;
  doctorName: string;
  branchName: string;
  typeName: string;
  startDatetime: string;
  endDatetime: string;
  tz: string;
  onClose: () => void;
  onDone: (id: string) => Promise<void> | void;
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return 'Session expired. Please sign in again.';
    if (err.status === 403) {
      // `forbidden_role` means the request did not carry a PATIENT
      // claim — a broken session, not a cancellation rule.
      if (err.code === 'forbidden_role') {
        return 'Your session is not recognised. Please sign in again and retry.';
      }
      return `Could not cancel (${err.code}).`;
    }
    if (err.status === 404) {
      if (err.code === 'not_found_appointment_in_terminal_state') {
        return 'This appointment is no longer Scheduled.';
      }
      return 'That appointment no longer exists.';
    }
    return `Could not cancel (${err.code}).`;
  }
  if (err instanceof TypeError) {
    return 'Connection failed. Is the API running on :3001?';
  }
  return 'Could not cancel the appointment.';
}

function formatLongDate(iso: string, tz: string): string {
  const d = new Date(iso);
  const dateStr = d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: tz === 'UTC' ? undefined : tz,
  });
  const timeStr = d.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: tz === 'UTC' ? undefined : tz,
  });
  return `${dateStr} at ${timeStr}`;
}

function formatTime(iso: string, tz: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: tz === 'UTC' ? undefined : tz,
  });
}

function lastName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 0) return fullName;
  if (/^dr\.?$/i.test(parts[0] ?? '') && parts.length > 1) {
    return parts.slice(1).join(' ');
  }
  return parts.length > 1 ? (parts[parts.length - 1] ?? fullName) : fullName;
}

export function CancelModal({
  appointmentId,
  doctorName,
  branchName,
  typeName,
  startDatetime,
  endDatetime,
  tz,
  onClose,
  onDone,
}: CancelModalProps) {
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);

  const onConfirm = async (): Promise<void> => {
    setSubmitting(true);
    setErr(null);
    try {
      await patientCancel(appointmentId);
      await onDone(appointmentId);
    } catch (e: unknown) {
      setErr(describeError(e));
      setSubmitting(false);
    }
  };

  return (
    <div
      className="cancel-modal__backdrop"
      role="dialog"
      aria-modal="true"
      data-testid="cancel-modal"
    >
      <div className="cancel-modal__modal" data-testid="cancel-modal-frame">
        <div className="cancel-modal__head" data-testid="cancel-modal-head">
          <div className="cancel-modal__icon" aria-hidden="true">
            ⚠
          </div>
          <div className="cancel-modal__title" data-testid="cancel-modal-title">
            Cancel your appointment with Dr. {lastName(doctorName)} on{' '}
            {formatLongDate(startDatetime, tz)}?
          </div>
        </div>
        <div className="cancel-modal__body" data-testid="cancel-modal-body">
          <div className="cancel-modal__why">
            Your slot will be released and made available to other patients.
          </div>
          <div className="cancel-modal__appt-meta" data-testid="cancel-modal-appt-meta">
            {branchName} · {typeName} · {formatTime(startDatetime, tz)}–
            {formatTime(endDatetime, tz)}
          </div>
          <div className="cancel-modal__rule">
            Cancellation is final — we&rsquo;ll cancel the appointment immediately.
            You can book another time from the booking page.
          </div>
          <div className="cancel-modal__helper">
            No reason needed from you. The slot will be released.
          </div>
          {err && (
            <div className="cancel-modal__error" data-testid="cancel-modal-error" role="alert">
              {err}
            </div>
          )}
        </div>
        <div className="cancel-modal__actions" data-testid="cancel-modal-actions">
          <button
            type="button"
            className="cancel-modal__btn-secondary"
            data-testid="cancel-modal-keep-btn"
            onClick={onClose}
            disabled={submitting}
          >
            Keep appointment
          </button>
          <button
            type="button"
            className="cancel-modal__btn-primary"
            data-testid="cancel-modal-confirm-btn"
            onClick={onConfirm}
            disabled={submitting}
          >
            {submitting ? 'Cancelling…' : 'Cancel appointment'}
          </button>
        </div>
      </div>
    </div>
  );
}
