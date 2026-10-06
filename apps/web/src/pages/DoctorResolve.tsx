/**
 * DoctorResolve — E6-S2 UI (mock 24 stacked-vertical).
 *
 * The doctor's "Resolve this appointment" page. Reached from
 * DoctorAffected's "Move →" button. The doctor's flow locks
 * the appointment TYPE (BR-058) — the body schema never accepts
 * a `new_appointment_type_id`. The branch MAY change to any
 * branch the doctor works at (BR-057).
 *
 *  - Step 1 (read-only): patient · phone · branch · original
 *    date · doctor · type. Type is also surfaced as a dedicated
 *    banner (Q1 from the design review: type lock promoted to
 *    full-width banner so the BR-058 rule is impossible to miss).
 *  - Step 2 (active): pick a new branch + 30-day date rail +
 *    slot grid.
 *
 * On confirm, POST /doctor/affected/:id/move. On success, the
 * parent (DoctorAffected) refreshes the kanban and shows
 * DoctorResolutionSaved (mock 37).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  doctorMove,
  getAvailability,
  listPublicAppointmentTypes,
  listPublicBranches,
  type AvailabilitySlot,
  type PublicAppointmentTypeDto,
  type PublicBranchDto,
} from '../api/client';
import { useAuth } from '../auth/store';
import {
  formatDateInTz,
  formatTimeInTz,
} from './doctor-utils';
import './DoctorResolve.module.css';

export interface DoctorResolveAppointment {
  id: string;
  patient_phone: string;
  patientLabel: string;
  maskedPhone: string;
  branch_id: string;
  branchName: string;
  branchTz: string;
  appointment_type_id: string;
  start_datetime: string;
  end_datetime: string;
  reason: string;
}

export interface ResolvedInfo {
  appointment_id: string;
  patient_phone: string;
  appointment_type_id: string;
  branch_id: string;
  branchName: string;
  fromStart: string;
  toStart: string;
  toEnd: string;
}

interface DoctorResolveProps {
  appointment: DoctorResolveAppointment;
  onCancel: () => void;
  onMoved: (info: ResolvedInfo) => Promise<void> | void;
  describeError: (err: unknown) => string;
}

export function DoctorResolve({
  appointment,
  onCancel,
  onMoved,
  describeError,
}: DoctorResolveProps) {
  const { stored } = useAuth();
  const doctorId = stored?.claim.doctor_id ?? null;

  const [branches, setBranches] = useState<PublicBranchDto[]>([]);
  const [types, setTypes] = useState<Map<string, PublicAppointmentTypeDto>>(
    () => new Map(),
  );
  const [branchId, setBranchId] = useState<string>(appointment.branch_id);
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

  // Load branches (filtered to this doctor).
  useEffect(() => {
    if (doctorId === null) return;
    let cancelled = false;
    (async () => {
      try {
        const [b, t] = await Promise.all([
          listPublicBranches(doctorId),
          listPublicAppointmentTypes(),
        ]);
        if (cancelled) return;
        setBranches(b.branches);
        setTypes(
          new Map(
            t.appointment_types.map((x) => [x.id, x]),
          ),
        );
      } catch {
        if (!cancelled) {
          setSubmitErr('Could not load the picker.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [doctorId]);

  // Load availability when (branch, type, date) change. The TYPE is
  // locked to the source row (BR-058), so we pass appointment.appointment_type_id
  // — not a state variable.
  useEffect(() => {
    if (branches.length === 0 || types.size === 0 || doctorId === null) return;
    let cancelled = false;
    setLoadingSlots(true);
    setSelectedSlot(null);
    setSlotReason(null);
    (async () => {
      try {
        const res = await getAvailability({
          doctor_id: doctorId,
          branch_id: branchId,
          date,
          appointment_type_id: appointment.appointment_type_id,
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
    date,
    appointment.appointment_type_id,
    branches.length,
    types.size,
    doctorId,
    describeError,
  ]);

  // 30-day date rail starting tomorrow (FR-019).
  const dateRail = useMemo(() => {
    const today = new Date();
    const start = new Date(
      Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth(),
        today.getUTCDate() + 1,
      ),
    );
    return Array.from({ length: 30 }, (_, i) => {
      const d = new Date(start.getTime());
      d.setUTCDate(start.getUTCDate() + i);
      return {
        iso: d.toISOString().slice(0, 10),
        dow: d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }),
        day: String(d.getUTCDate()),
      };
    });
  }, []);

  const apptType = types.get(appointment.appointment_type_id);
  const typeName = apptType?.name ?? 'Appointment';
  const typeDuration = apptType?.duration_minutes ?? 0;

  const tz = useMemo(() => {
    const b = branches.find((x) => x.id === branchId);
    return b?.tz ?? appointment.branchTz ?? 'UTC';
  }, [branches, branchId, appointment.branchTz]);

  const onConfirm = useCallback(async (): Promise<void> => {
    if (selectedSlot === null) return;
    setSubmitting(true);
    setSubmitErr(null);
    try {
      await doctorMove(appointment.id, {
        new_branch_id: branchId,
        new_start_datetime: selectedSlot.start_datetime,
        new_end_datetime: selectedSlot.end_datetime,
      });
      const info: ResolvedInfo = {
        appointment_id: appointment.id,
        patient_phone: appointment.patient_phone,
        appointment_type_id: appointment.appointment_type_id,
        branch_id: branchId,
        branchName: branches.find((b) => b.id === branchId)?.name ?? '—',
        fromStart: appointment.start_datetime,
        toStart: selectedSlot.start_datetime,
        toEnd: selectedSlot.end_datetime,
      };
      await onMoved(info);
    } catch (e: unknown) {
      setSubmitErr(describeError(e));
      setSubmitting(false);
    }
  }, [
    selectedSlot,
    branchId,
    appointment,
    onMoved,
    branches,
    describeError,
  ]);

  const apptStart = formatTimeInTz(appointment.start_datetime, appointment.branchTz);
  const apptEnd = formatTimeInTz(appointment.end_datetime, appointment.branchTz);
  const apptDate = formatDateInTz(appointment.start_datetime, appointment.branchTz);

  return (
    <div className="doc-resolve__backdrop" role="dialog" aria-modal="true">
      <div className="doc-resolve__frame">
        <div className="doc-resolve__page">
          <div className="doc-resolve__header">
            <button
              type="button"
              className="doc-resolve__crumb"
              onClick={onCancel}
            >
              ‹ Affected queue
            </button>
            <h1 className="doc-resolve__title">Resolve this appointment</h1>
            <p className="doc-resolve__sub">
              Move it to another valid slot at a branch where you work.
            </p>
          </div>

          <section className="doc-resolve__step">
            <div className="doc-resolve__step-head">
              <div className="doc-resolve__step-num doc-resolve__step-num--done">1</div>
              <div className="doc-resolve__step-title">
                Current appointment · {appointment.patientLabel}
              </div>
              <div className="doc-resolve__step-hint">Read-only</div>
            </div>
            <div className="doc-resolve__readonly">
              <Field k="Patient" v={appointment.patientLabel} />
              <Field k="Phone" v={appointment.maskedPhone} />
              <Field k="Original date" v={`${apptDate} · ${apptStart}`} />
              <Field k="Original branch" v={appointment.branchName} />
              <Field k="Doctor" v="You" />
              <Field
                k="Type"
                v={typeDuration > 0 ? `${typeName} · ${typeDuration}m` : typeName}
              />
            </div>
          </section>

          <div className="doc-resolve__type-lock">
            <div className="doc-resolve__type-lock-icon" aria-hidden="true">
              🔒
            </div>
            <div className="doc-resolve__type-lock-body">
              <div className="doc-resolve__type-lock-label">
                Appointment type · locked
              </div>
              <div className="doc-resolve__type-lock-value">
                {typeDuration > 0 ? `${typeName} · ${typeDuration} min` : typeName}
              </div>
              <div className="doc-resolve__type-lock-reason">
                Type cannot change during resolve. Only branch and slot may
                change. <code>BR-058</code>
              </div>
            </div>
            <span className="doc-resolve__type-lock-pill">Locked</span>
          </div>

          <section className="doc-resolve__step">
            <div className="doc-resolve__step-head">
              <div className="doc-resolve__step-num doc-resolve__step-num--current">
                2
              </div>
              <div className="doc-resolve__step-title">Pick a new slot</div>
              <div className="doc-resolve__step-hint">Within 30 days</div>
            </div>

            <div className="doc-resolve__picker-row">
              <div className="doc-resolve__picker">
                <div className="doc-resolve__picker-label">New branch</div>
                <select
                  className="doc-resolve__picker-select"
                  value={branchId}
                  onChange={(e) => setBranchId(e.target.value)}
                >
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
                <div className="doc-resolve__picker-hint">You work here</div>
              </div>
            </div>

            <div className="doc-resolve__rail-label">
              <span>Pick a date</span>
              <span className="doc-resolve__rail-count">
                {dateRail.length} days
              </span>
            </div>
            <div className="doc-resolve__rail">
              {dateRail.map((d) => {
                const isSelected = d.iso === date;
                return (
                  <button
                    key={d.iso}
                    type="button"
                    className={
                      isSelected
                        ? 'doc-resolve__rail-cell doc-resolve__rail-cell--selected'
                        : 'doc-resolve__rail-cell'
                    }
                    onClick={() => setDate(d.iso)}
                  >
                    <div className="doc-resolve__rail-dow">{d.dow}</div>
                    <div className="doc-resolve__rail-num">{d.day}</div>
                  </button>
                );
              })}
            </div>

            <div className="doc-resolve__rail-label">
              <span>
                Available slots · {formatDateInTz(date + 'T00:00:00Z', tz)}
              </span>
              <span className="doc-resolve__rail-count">
                {loadingSlots
                  ? 'loading…'
                  : slots === null
                    ? '0 open'
                    : `${slots.length} open`}
              </span>
            </div>
            <div className="doc-resolve__slot-grid">
              {loadingSlots && (
                <div className="doc-resolve__empty">Loading slots…</div>
              )}
              {!loadingSlots && slots !== null && slots.length === 0 && (
                <div className="doc-resolve__empty">
                  {slotReason === 'past_date'
                    ? 'That date is in the past.'
                    : slotReason === 'outside_30d_window'
                      ? 'That date is more than 30 days out.'
                      : slotReason === 'branch_closed'
                        ? 'The branch is closed that day.'
                        : slotReason === 'doctor_unavailable'
                          ? "You're not available that day."
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
                          ? 'doc-resolve__slot doc-resolve__slot--selected'
                          : 'doc-resolve__slot'
                      }
                      onClick={() => setSelectedSlot(s)}
                    >
                      {formatTimeInTz(s.start_datetime, tz)}
                    </button>
                  );
                })}
            </div>

            {selectedSlot && (
              <div className="doc-resolve__summary">
                <div className="doc-resolve__row">
                  <span className="doc-resolve__k">New date</span>
                  <span className="doc-resolve__v">
                    {formatDateInTz(selectedSlot.start_datetime, tz)} ·{' '}
                    {formatTimeInTz(selectedSlot.start_datetime, tz)}
                  </span>
                </div>
                <div className="doc-resolve__row">
                  <span className="doc-resolve__k">Branch</span>
                  <span className="doc-resolve__v">
                    {branches.find((b) => b.id === branchId)?.name ?? '—'}
                  </span>
                </div>
                <div className="doc-resolve__row">
                  <span className="doc-resolve__k">Type</span>
                  <span className="doc-resolve__v">{typeName}</span>
                </div>
              </div>
            )}

            {submitErr && (
              <div className="doc-resolve__error">{submitErr}</div>
            )}

            <div className="doc-resolve__step-foot">
              <button
                type="button"
                className="doc-resolve__btn-ghost"
                onClick={onCancel}
                disabled={submitting}
              >
                Back to queue
              </button>
              <button
                type="button"
                className="doc-resolve__btn-primary"
                onClick={() => {
                  void onConfirm();
                }}
                disabled={selectedSlot === null || submitting}
              >
                {submitting
                  ? 'Moving…'
                  : selectedSlot
                    ? `Move to ${formatDateInTz(selectedSlot.start_datetime, tz)} · ${formatTimeInTz(selectedSlot.start_datetime, tz)}`
                    : 'Move appointment'}
              </button>
            </div>
          </section>

          <div className="doc-resolve__cancel-hint">
            <strong>No slots work for this patient?</strong> You can cancel
            this appointment from the affected queue card.
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ k, v }: { k: string; v: string }) {
  return (
    <div className="doc-resolve__field">
      <div className="doc-resolve__field-k">{k}</div>
      <div className="doc-resolve__field-v">{v}</div>
    </div>
  );
}