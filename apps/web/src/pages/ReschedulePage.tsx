/**
 * ReschedulePage — E4-S3 UI (mock 20).
 *
 * The patient picks a new (branch, type, date, time) for an existing
 * Scheduled appointment. The doctor is LOCKED (FR-040, BR-042 — the
 * body schema never accepts a `new_doctor_id`). Branch, type, date,
 * and time may all change (FR-041). The new slot's duration MUST
 * equal the appointment type's `duration_minutes`; we hard-code
 * `new_slot_duration_minutes = apptType.duration_minutes`.
 *
 * Step 1: locked current appointment card.
 * Step 2: branch + type pickers, 30-day date rail, agenda of slots.
 * Confirm → POST /patient/appointments/:id/reschedule.
 *
 * The reschedule is atomic + GIST-protected on the back-end; any
 * 409 from the recheck (e.g. `slot_raced`, `patient_time_conflict`)
 * surfaces inline.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ApiError,
  getAvailability,
  listPublicBranches,
  listPublicAppointmentTypes,
  patientReschedule,
  type AvailabilitySlot,
  type PublicAppointmentTypeDto,
  type PublicBranchDto,
} from '../api/client';
import {
  isoDateOffset,
} from './booking-utils';
import './ReschedulePage.css';
import { withDoctorTitle } from './doctor-name';

interface RescheduleAppointment {
  id: string;
  doctor_id: string;
  doctorName: string;
  branch_id: string;
  branchName: string;
  appointment_type_id: string;
  typeName: string;
  typeDuration: number;
  start_datetime: string;
  end_datetime: string;
  status: string;
  tz: string;
}

interface ReschedulePageProps {
  appointment: RescheduleAppointment;
  onClose: () => void;
  onDone: (id: string) => Promise<void> | void;
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return 'Session expired. Please sign in again.';
    if (err.status === 403) {
      // `forbidden_role` means the request did not carry a PATIENT
      // claim. That is a broken session, not a booking rule — the
      // patient can move this appointment, they just are not
      // recognised as themselves right now. Say so, and say what to
      // do, instead of leaking an internal code.
      if (err.code === 'forbidden_role') {
        return 'Your session is not recognised. Please sign in again and retry.';
      }
      return `Could not reschedule (${err.code}).`;
    }
    if (err.status === 404) {
      if (err.code === 'not_found_appointment_in_terminal_state') {
        return 'This appointment is no longer Scheduled.';
      }
      return 'That appointment no longer exists.';
    }
    if (err.status === 409) {
      if (err.code === 'slot_raced') {
        return 'That slot was just booked by another patient. Pick another.';
      }
      if (err.code === 'patient_has_future_with_doctor') {
        // The commit-time recheck excludes the row being moved, so
        // this means a SECOND appointment with the same doctor — not
        // the one the patient is rescheduling.
        return 'You already have another future appointment with this doctor.';
      }
      if (err.code === 'patient_time_conflict') {
        return 'You already have another appointment at that time.';
      }
      if (err.code === 'duration_mismatch') {
        return "The slot's duration doesn't match the appointment type.";
      }
      if (err.code === 'outside_30d_window') {
        return 'That date is more than 30 days out.';
      }
      if (err.code === 'slot_in_past') {
        return 'That slot is in the past.';
      }
      if (err.code === 'doctor_unavailable') {
        return "The doctor isn't available then.";
      }
      if (err.code === 'branch_closed') {
        return 'The branch is closed then.';
      }
      return `Could not reschedule (${err.code}).`;
    }
    if (err.status === 400) {
      if (err.code === 'doctor_not_at_branch') {
        return "The doctor doesn't work at that branch.";
      }
      if (err.code === 'doctor_inactive') {
        return 'The doctor is no longer accepting bookings.';
      }
      if (err.code === 'branch_inactive') {
        return 'The branch is no longer accepting bookings.';
      }
      if (err.code === 'invalid_time_range') {
        return 'The slot duration is invalid.';
      }
      if (err.code === 'unknown_field') {
        return 'The form has an unknown field — refresh the page.';
      }
      return `Could not reschedule (${err.code}).`;
    }
    return `Could not reschedule (${err.code}).`;
  }
  if (err instanceof TypeError) {
    return 'Connection failed. Is the API running on :3001?';
  }
  return 'Could not reschedule.';
}

function dateBlock(iso: string, tz: string): {
  month: string;
  day: string;
  dow: string;
} {
  const d = new Date(iso);
  const tzOpt = tz === 'UTC' ? undefined : tz;
  return {
    month: d.toLocaleDateString('en-US', { month: 'short', timeZone: tzOpt }),
    day: String(d.getUTCDate()),
    dow: d.toLocaleDateString('en-US', { weekday: 'short', timeZone: tzOpt }),
  };
}

function formatTime(iso: string, tz: string): string {
  const d = new Date(iso);
  const tzOpt = tz === 'UTC' ? undefined : tz;
  return d.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: tzOpt,
  });
}

function formatDateChip(iso: string, tz: string): string {
  const d = new Date(iso);
  const tzOpt = tz === 'UTC' ? undefined : tz;
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: tzOpt,
  });
}

export function ReschedulePage({
  appointment,
  onClose,
  onDone,
}: ReschedulePageProps) {
  const [branches, setBranches] = useState<PublicBranchDto[]>([]);
  const [types, setTypes] = useState<PublicAppointmentTypeDto[]>([]);
  const [branchId, setBranchId] = useState<string>(appointment.branch_id);
  const [typeId, setTypeId] = useState<string>(appointment.appointment_type_id);
  const [date, setDate] = useState<string>(
    appointment.start_datetime.slice(0, 10),
  );
  const [slots, setSlots] = useState<AvailabilitySlot[] | null>(null);
  const [slotReason, setSlotReason] = useState<string | null>(null);
  const [loadingSlots, setLoadingSlots] = useState<boolean>(false);
  const [selectedSlot, setSelectedSlot] = useState<AvailabilitySlot | null>(
    null,
  );
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);

  // Load branches (filtered to this doctor) + types.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [b, t] = await Promise.all([
          listPublicBranches(appointment.doctor_id),
          listPublicAppointmentTypes(),
        ]);
        if (cancelled) return;
        setBranches(b.branches);
        setTypes(t.appointment_types);
      } catch {
        if (!cancelled) {
          setSubmitErr('Could not load the picker.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [appointment.doctor_id]);

  // Load availability when (branch, type, date) change.
  useEffect(() => {
    if (branches.length === 0 || types.length === 0) return;
    let cancelled = false;
    setLoadingSlots(true);
    setSelectedSlot(null);
    setSlotReason(null);
    (async () => {
      try {
        const res = await getAvailability({
          doctor_id: appointment.doctor_id,
          branch_id: branchId,
          date,
          appointment_type_id: typeId,
          // patient_phone is auto-derived from the JWT by the server
          // when the caller is a patient (see /availability route),
          // so the FR-027/FR-029 filters apply to the preview as
          // well as the commit-time recheck. This prevents the UX bug
          // where the slot grid shows 28 open slots but the move
          // fails with `patient_has_future_with_doctor` after the
          // user picks one.
          //
          // exclude_appointment_id tells the server which row we are
          // moving so it can exclude it from those same checks. The
          // appointment being rescheduled IS a future Scheduled row
          // for this patient+doctor — without the exclusion FR-027
          // fires against the patient's own appointment, the grid
          // comes back empty, and the only way forward is to cancel
          // and rebook. The commit-time recheck already excludes it
          // (`id <> $3` in routes/patient-reschedule.ts); the preview
          // must agree.
          exclude_appointment_id: appointment.id,
        });
        if (cancelled) return;
        setSlots(res.slots);
        setSlotReason(res.reason ?? null);
        setLoadingSlots(false);
      } catch (e: unknown) {
        if (!cancelled) {
          setSubmitErr(describeError(e));
          setLoadingSlots(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    branchId,
    typeId,
    date,
    appointment.doctor_id,
    appointment.id,
    branches.length,
    types.length,
  ]);

  // Build a 30-day date rail starting from today (UTC). The first
  // date is excluded if it would be a same-day booking (FR-019);
  // the rail starts at today + 1.
  const dateRail = useMemo(() => {
    const today = new Date();
    const startDate = new Date(
      Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth(),
        today.getUTCDate() + 1,
      ),
    );
    return Array.from({ length: 30 }, (_, i) => {
      const d = new Date(startDate.getTime());
      d.setUTCDate(startDate.getUTCDate() + i);
      const iso = d.toISOString().slice(0, 10);
      return {
        iso,
        dow: d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }),
        day: String(d.getUTCDate()),
      };
    });
  }, []);

  const onConfirm = useCallback(async (): Promise<void> => {
    if (selectedSlot === null) return;
    setSubmitting(true);
    setSubmitErr(null);
    try {
      await patientReschedule(appointment.id, {
        new_branch_id: branchId,
        new_appointment_type_id: typeId,
        new_start_datetime: selectedSlot.start_datetime,
        new_end_datetime: selectedSlot.end_datetime,
        new_slot_duration_minutes: appointment.typeDuration,
      });
      await onDone(appointment.id);
    } catch (e: unknown) {
      setSubmitErr(describeError(e));
      setSubmitting(false);
    }
  }, [selectedSlot, branchId, typeId, appointment, onDone]);

  const apptDb = dateBlock(appointment.start_datetime, appointment.tz);

  return (
    <div
      className="reschedule__backdrop"
      role="dialog"
      aria-modal="true"
      data-testid="reschedule-dialog"
    >
      <div className="reschedule__frame">
        <div className="reschedule__page">
          <div className="reschedule__header">
            <button
              type="button"
              className="reschedule__crumb"
              onClick={onClose}
            >
              ‹ My appointments
            </button>
            <h1 className="reschedule__title">Move your appointment</h1>
            <p className="reschedule__sub">
              Pick a new branch, type, date, or time. Same doctor.
            </p>
          </div>

          <section className="reschedule__section reschedule__section--locked">
            <div className="reschedule__section-head">
              <div className="reschedule__num reschedule__num--done">✓</div>
              <div className="reschedule__section-title">Current appointment</div>
              <div className="reschedule__section-hint">Doctor is locked</div>
            </div>
            <div className="reschedule__appt-current">
              <div className="reschedule__date-block">
                <div className="reschedule__date-month">{apptDb.month}</div>
                <div className="reschedule__date-day">{apptDb.day}</div>
                <div className="reschedule__date-dow">{apptDb.dow}</div>
              </div>
              <div className="reschedule__appt-body">
                <div className="reschedule__appt-name">
                  {withDoctorTitle(appointment.doctorName)} · {appointment.typeName}
                </div>
                <div className="reschedule__appt-meta">
                  {formatTime(appointment.start_datetime, appointment.tz)} –{' '}
                  {formatTime(appointment.end_datetime, appointment.tz)} ·{' '}
                  {appointment.branchName} · {appointment.typeName}{' '}
                  {appointment.typeDuration}m
                </div>
              </div>
            </div>
          </section>

          <section className="reschedule__section">
            <div className="reschedule__section-head">
              <div className="reschedule__num reschedule__num--current">2</div>
              <div className="reschedule__section-title">Pick a new slot</div>
              <div className="reschedule__section-hint">
                Within 30 days · tomorrow onward
              </div>
            </div>

            <div className="reschedule__picker-row">
              <div className="reschedule__picker">
                <div className="reschedule__picker-label">Branch</div>
                <select
                  className="reschedule__picker-select"
                  value={branchId}
                  onChange={(e) => setBranchId(e.target.value)}
                >
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
                <div className="reschedule__picker-hint">
                  Doctor works here
                </div>
              </div>
              <div className="reschedule__picker">
                <div className="reschedule__picker-label">Appointment type</div>
                <select
                  className="reschedule__picker-select"
                  value={typeId}
                  onChange={(e) => setTypeId(e.target.value)}
                >
                  {types.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} · {t.duration_minutes}m
                    </option>
                  ))}
                </select>
                <div className="reschedule__picker-hint">Active</div>
              </div>
            </div>

            <div className="reschedule__rail-label">
              <span>Pick a date</span>
              <span className="reschedule__rail-count">
                {dateRail.length} days
              </span>
            </div>
            <div className="reschedule__rail">
              {dateRail.map((d) => {
                const isSelected = d.iso === date;
                return (
                  <button
                    key={d.iso}
                    type="button"
                    className={
                      isSelected
                        ? 'reschedule__rail-cell reschedule__rail-cell--selected'
                        : 'reschedule__rail-cell'
                    }
                    onClick={() => setDate(d.iso)}
                    data-testid={`reschedule-date-${d.iso}`}
                  >
                    <div className="reschedule__rail-dow">{d.dow}</div>
                    <div className="reschedule__rail-num">{d.day}</div>
                  </button>
                );
              })}
            </div>

            <div className="reschedule__rail-label">
              <span>Available slots · {formatDateChip(date + 'T00:00:00Z', 'UTC')}</span>
              <span className="reschedule__rail-count">
                {loadingSlots
                  ? 'loading…'
                  : slots === null
                    ? '0 open'
                    : `${slots.length} open`}
              </span>
            </div>
            <div className="reschedule__slot-grid" data-testid="reschedule-slots">
              {loadingSlots && (
                <div className="reschedule__empty">Loading slots…</div>
              )}
              {!loadingSlots && slots !== null && slots.length === 0 && (
                <div className="reschedule__empty" data-testid="reschedule-no-slots">
                  {slotReason === 'past_date'
                    ? 'That date is in the past.'
                    : slotReason === 'outside_30d_window'
                      ? 'That date is more than 30 days out.'
                      : slotReason === 'branch_closed'
                        ? 'The branch is closed that day.'
                        : slotReason === 'doctor_unavailable'
                          ? "The doctor isn't available that day."
                          : slotReason === 'patient_has_future_with_doctor'
                            ? 'You already have another future appointment with this doctor. Reschedule or cancel that one first.'
                            : 'No slots available.'}
                </div>
              )}
              {!loadingSlots &&
                slots?.map((s) => {
                  const isSelected =
                    selectedSlot?.start_datetime === s.start_datetime;
                  return (
                    <button
                      key={s.start_datetime}
                      type="button"
                      className={
                        isSelected
                          ? 'reschedule__slot reschedule__slot--selected'
                          : 'reschedule__slot'
                      }
                      onClick={() => setSelectedSlot(s)}
                      data-testid={`reschedule-slot-${s.start_datetime}`}
                    >
                      {formatTime(s.start_datetime, appointment.tz)}
                    </button>
                  );
                })}
            </div>

            {selectedSlot && (
              <div className="reschedule__summary">
                <div className="reschedule__row">
                  <span className="reschedule__k">New date</span>
                  <span className="reschedule__v">
                    {formatDateChip(selectedSlot.start_datetime, appointment.tz)} ·{' '}
                    {formatTime(selectedSlot.start_datetime, appointment.tz)}
                  </span>
                </div>
                <div className="reschedule__row">
                  <span className="reschedule__k">Branch</span>
                  <span className="reschedule__v">
                    {branches.find((b) => b.id === branchId)?.name ?? '—'}
                  </span>
                </div>
                <div className="reschedule__row">
                  <span className="reschedule__k">Doctor</span>
                  <span className="reschedule__v">
                    {withDoctorTitle(appointment.doctorName)}
                  </span>
                </div>
                <div className="reschedule__row">
                  <span className="reschedule__k">Type</span>
                  <span className="reschedule__v">
                    {types.find((t) => t.id === typeId)?.name ?? '—'}
                  </span>
                </div>
              </div>
            )}

            {submitErr && (
              <div className="reschedule__error" data-testid="reschedule-error">
                {submitErr}
              </div>
            )}

            <div className="reschedule__step-foot">
              <button
                type="button"
                className="reschedule__btn-ghost"
                onClick={onClose}
                disabled={submitting}
                data-testid="reschedule-back-btn"
              >
                Back
              </button>
              <button
                type="button"
                className="reschedule__btn-primary"
                onClick={() => {
                  void onConfirm();
                }}
                disabled={selectedSlot === null || submitting}
                data-testid="reschedule-confirm-btn"
              >
                {submitting ? 'Moving…' : 'Confirm move'}
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

void isoDateOffset;