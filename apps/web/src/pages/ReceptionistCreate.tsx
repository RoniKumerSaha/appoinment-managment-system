/**
 * ReceptionistCreate — E5 receptionist walk-in booking flow (mock 14).
 *
 * 5-step stepped form rendered as numbered section cards + a top
 * stepper. Branch is locked (single-branch per BR-004). On confirm,
 * the booking is POSTed to `POST /bookings`, which records the
 * receptionist as the actor of record (audit.creator_role =
 * "receptionist", E3-S4 / F-13).
 *
 * The branch comes from the receptionist's own schedule envelope
 * (`GET /reception/branch/schedule`), so it is never a choice.
 * Slots come from `GET /availability` — the same engine the patient
 * flow uses, so the conflict checks are identical (FR-027/029).
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import {
  ApiError,
  createBooking,
  getAvailability,
  getReceptionSchedule,
  listAppointmentTypes,
  listDoctors,
  type AppointmentTypeDto,
  type DoctorWithBranchesDto,
} from '../api/client';
import { ReceptionistFrame } from './ReceptionistFrame';
import { PhoneCountryPicker } from './PhoneCountryPicker';
import { usePhoneField } from './usePhoneField';
import { formatMonthDay, formatTimeLocal } from './recep-utils';
import { addDays, todayLocalIn } from './reception-schedule';
import styles from './ReceptionistCreate.module.css';

interface Props {
  /** Prefill from the availability browser (mock 16). */
  prefill?: {
    doctor_id?: string;
    appointment_type_id?: string;
    date?: string;
    start_datetime?: string;
    end_datetime?: string;
  };
  onBooked?: (appointmentId: string) => void;
}

interface SlotOption {
  start: string;
  end: string;
  selected: boolean;
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return 'Session expired. Please sign in again.';
    if (err.status === 403) return 'You do not have access to this branch.';
    if (err.status === 400 && err.code === 'slot_conflict') {
      return 'That slot was just taken. Pick another one.';
    }
    if (err.status === 400 && err.code === 'patient_conflict') {
      return 'This patient already has an appointment with that doctor.';
    }
    if (err.status === 400 && err.code === 'outside_30d_window') {
      return 'That date is outside the 30-day booking window.';
    }
    if (err.status === 400 && err.code === 'branch_closed') {
      return 'The branch is closed on that day.';
    }
    if (err.status === 400 && err.code === 'invalid_patient_phone') {
      return 'That phone number is not a valid E.164 number.';
    }
    return `Booking failed (${err.code}).`;
  }
  if (err instanceof TypeError) {
    return 'Connection failed. Is the API running on :3001?';
  }
  return 'Booking failed.';
}

function StepNum({
  n,
  state,
}: {
  n: number;
  state: 'done' | 'current' | 'todo';
}): ReactNode {
  const cls =
    state === 'done'
      ? `${styles['step-num']} ${styles['step-num-done']}`
      : state === 'current'
        ? `${styles['step-num']} ${styles['step-num-current']}`
        : styles['step-num'];
  return <div className={cls}>{n}</div>;
}

export function ReceptionistCreate({ prefill, onBooked }: Props): ReactNode {
  const [branch, setBranch] = useState<{
    id: string;
    name: string;
    tz: string;
  } | null>(null);
  const [doctors, setDoctors] = useState<DoctorWithBranchesDto[]>([]);
  const [types, setTypes] = useState<AppointmentTypeDto[]>([]);
  const [doctorId, setDoctorId] = useState<string>(prefill?.doctor_id ?? '');
  const [typeId, setTypeId] = useState<string>(
    prefill?.appointment_type_id ?? '',
  );
  const [date, setDate] = useState<string>(prefill?.date ?? '');
  const [slots, setSlots] = useState<SlotOption[]>([]);
  const [selectedStart, setSelectedStart] = useState<string>(
    prefill?.start_datetime ?? '',
  );
  const [patientName, setPatientName] = useState<string>('');
  const [notes, setNotes] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);
  const [busy, setBusy] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const {
    countryCode,
    nationalNumber,
    phone: patientPhone,
    onCountryChange,
    onNumberChange,
    reset: resetPhone,
    countryName,
  } = usePhoneField();

  // The branch is the receptionist's own — read it, never pick it.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getReceptionSchedule({})
      .then((res) => {
        if (cancelled) return;
        setBranch(res.branch);
        if (date === '') setDate(todayLocalIn(res.branch.tz));
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setErr(describeError(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `date` is seeded from the response once; later edits must not
    // be clobbered by a re-read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (branch === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const [d, t] = await Promise.all([
          listDoctors({ active: true, branch_id: branch.id }),
          listAppointmentTypes({ active: true }),
        ]);
        if (cancelled) return;
        const branchDoctors = d.filter((doc) =>
          doc.branches.some((b) => b.id === branch.id),
        );
        setDoctors(branchDoctors);
        setTypes(t);
        setDoctorId((prev) => {
          if (prefill?.doctor_id !== undefined) return prefill.doctor_id;
          return prev === '' ? (branchDoctors[0]?.id ?? '') : prev;
        });
        setTypeId((prev) => {
          if (prefill?.appointment_type_id !== undefined) {
            return prefill.appointment_type_id;
          }
          return prev === '' ? (t[0]?.id ?? '') : prev;
        });
      } catch (e: unknown) {
        if (!cancelled) setErr(describeError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [branch, prefill]);

  // The open slots for the chosen day.
  useEffect(() => {
    if (branch === null) return;
    if (doctorId === '' || typeId === '' || date === '') {
      setSlots([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await getAvailability({
          doctor_id: doctorId,
          branch_id: branch.id,
          date,
          appointment_type_id: typeId,
        });
        if (cancelled) return;
        const duration =
          types.find((t) => t.id === typeId)?.duration_minutes ?? 30;
        setSlots(
          res.slots.map((s) => ({
            start: s.start_datetime,
            end: new Date(
              new Date(s.start_datetime).getTime() + duration * 60_000,
            ).toISOString(),
            selected: s.start_datetime === selectedStart,
          })),
        );
        setErr(null);
      } catch (e: unknown) {
        if (!cancelled) {
          setSlots([]);
          setErr(describeError(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [branch, doctorId, typeId, date, types, selectedStart]);

  const selectedType = useMemo(
    () => types.find((t) => t.id === typeId) ?? null,
    [types, typeId],
  );
  const selectedDoctor = useMemo(
    () => doctors.find((d) => d.id === doctorId) ?? null,
    [doctors, doctorId],
  );
  const selectedSlot = useMemo(
    () => slots.find((s) => s.start === selectedStart) ?? null,
    [slots, selectedStart],
  );

  // The 30-day booking window (FR-018), measured from today in the
  // branch's timezone.
  const [maxDate, setMaxDate] = useState<string>('');
  useEffect(() => {
    if (branch === null) return;
    setMaxDate(addDays(todayLocalIn(branch.tz), 30));
  }, [branch]);

  const onSubmit = useCallback(
    (e: FormEvent<HTMLFormElement>): void => {
      e.preventDefault();
      if (branch === null || selectedSlot === null || selectedType === null) {
        setErr('Pick a doctor, a type and an open slot first.');
        return;
      }
      if (patientPhone === '') {
        setErr('A patient phone number is required.');
        return;
      }
      if (patientName.trim() === '') {
        setErr('A patient name is required.');
        return;
      }
      setBusy(true);
      setErr(null);
      createBooking({
        doctor_id: doctorId,
        branch_id: branch.id,
        appointment_type_id: typeId,
        start_datetime: selectedSlot.start,
        end_datetime: selectedSlot.end,
        slot_duration_minutes: selectedType.duration_minutes,
        patient_phone: patientPhone,
        patient_name: patientName.trim(),
      })
        .then((res) => {
          setBusy(false);
          setDone(res.appointment.id);
          onBooked?.(res.appointment.id);
        })
        .catch((e: unknown) => {
          setBusy(false);
          setErr(describeError(e));
        });
    },
    [
      branch,
      selectedSlot,
      selectedType,
      doctorId,
      typeId,
      patientPhone,
      patientName,
      onBooked,
    ],
  );

  if (done !== null) {
    return (
      <ReceptionistFrame>
        <div className={styles['page']}>
          <header className={styles['page-header']}>
            <div className={styles.crumb}>Today → + New appointment</div>
            <h1>Appointment booked</h1>
            <p className={styles.sub}>
              The appointment is on the schedule with the receptionist as the
              actor of record.
            </p>
          </header>
          <div className={styles['confirm-box']}>
            <div className={styles['confirm-grid']}>
              <div>
                <span className={styles.k}>Reference:</span>{' '}
                <strong>{done}</strong>
              </div>
              <div>
                <span className={styles.k}>Doctor:</span>{' '}
                <strong>{selectedDoctor?.full_name ?? '—'}</strong>
              </div>
              <div>
                <span className={styles.k}>Type:</span>{' '}
                <strong>{selectedType?.name ?? '—'}</strong>
              </div>
              <div>
                <span className={styles.k}>When:</span>{' '}
                <strong>
                  {selectedSlot === null
                    ? '—'
                    : `${formatMonthDay(selectedSlot.start.slice(0, 10))} · ${formatTimeLocal(selectedSlot.start, branch?.tz ?? 'UTC')}`}
                </strong>
              </div>
              <div className={styles['confirm-grid-row-full']}>
                <span className={styles.k}>Patient:</span>{' '}
                <strong>{patientName}</strong> · {patientPhone}
              </div>
            </div>
          </div>
          <div className={styles['step-foot']}>
            <div className={styles.audit}>
              Atomic: <code>Appointment.create</code> · audit:{' '}
              <code>appointment.created</code>
            </div>
            <button
              type="button"
              className={styles['btn-secondary']}
              onClick={() => {
                setDone(null);
                setSelectedStart('');
                resetPhone();
                setPatientName('');
                setNotes('');
              }}
            >
              Book another
            </button>
          </div>
        </div>
      </ReceptionistFrame>
    );
  }

  return (
    <ReceptionistFrame>
      <div className={styles['page']}>
        <header className={styles['page-header']}>
          <div className={styles.crumb}>Today → + New appointment</div>
          <h1>Book on behalf of patient</h1>
          <p className={styles.sub}>
            For walk-ins or phone bookings. Same conflict checks as patient
            flow (FR-027/029).
          </p>
        </header>

        {/* Stepper */}
        <div className={styles.stepper}>
          <div className={`${styles['stepper-seg']} ${styles['stepper-seg-done']}`}>
            <span className={styles.n}>✓</span>Branch
          </div>
          <div className={`${styles['stepper-seg']} ${styles['stepper-seg-done']}`}>
            <span className={styles.n}>✓</span>Doctor + Type
          </div>
          <div className={`${styles['stepper-seg']} ${styles['stepper-seg-done']}`}>
            <span className={styles.n}>✓</span>Date + Slot
          </div>
          <div className={`${styles['stepper-seg']} ${styles['stepper-seg-current']}`}>
            <span className={styles.n}>4</span>Patient
          </div>
          <div className={styles['stepper-seg']}>
            <span className={styles.n}>5</span>Confirm
          </div>
        </div>

        {err && <div className={styles['info-note']}>⚠ {err}</div>}

        {/* Step 1 — Branch (locked) */}
        <div className={styles.step}>
          <div className={styles['step-head']}>
            <StepNum n={1} state="done" />
            <div className={styles['step-title']}>Branch (locked to you)</div>
            <div className={styles['step-hint']}>BR-004</div>
          </div>
          <div className={styles['branch-card']}>
            <div className={styles['branch-icon']}>📍</div>
            <div className={styles['branch-body']}>
              <div className={styles['branch-name']}>
                {branch?.name ?? (loading ? 'Loading…' : '—')}
              </div>
              <div className={styles['branch-meta']}>
                {branch === null
                  ? 'Your assigned branch'
                  : `${doctors.length} doctor${doctors.length === 1 ? '' : 's'} available`}
              </div>
            </div>
            <span className={styles['branch-lock']}>🔒 Single-branch</span>
          </div>
        </div>

        {/* Step 2 — Doctor + Type */}
        <div className={styles.step}>
          <div className={styles['step-head']}>
            <StepNum n={2} state="done" />
            <div className={styles['step-title']}>Doctor + appointment type</div>
            <div className={styles['step-hint']}>
              {types.length} active type{types.length === 1 ? '' : 's'} at this
              branch
            </div>
          </div>
          <div className={styles['form-group']}>
            <label htmlFor="recep-create-doctor">Doctor</label>
            <select
              id="recep-create-doctor"
              value={doctorId}
              onChange={(e) => {
                setDoctorId(e.target.value);
                setSelectedStart('');
              }}
            >
              {doctors.length === 0 && <option value="">No doctors</option>}
              {doctors.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.full_name}
                </option>
              ))}
            </select>
          </div>
          <div className={styles['form-group']} style={{ marginBottom: 0 }}>
            <label>Type</label>
            <div className={styles.types}>
              {types.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={
                    t.id === typeId
                      ? `${styles['type-opt']} ${styles['type-opt-selected']}`
                      : styles['type-opt']
                  }
                  onClick={() => {
                    setTypeId(t.id);
                    setSelectedStart('');
                  }}
                >
                  <div className={styles['type-opt-name']}>{t.name}</div>
                  <div className={styles['type-opt-dur']}>
                    {t.duration_minutes} min
                  </div>
                  <div className={styles['type-opt-desc']}>
                    {t.description ?? ''}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Step 3 — Date + slot */}
        <div className={styles.step}>
          <div className={styles['step-head']}>
            <StepNum n={3} state="done" />
            <div className={styles['step-title']}>Date + slot</div>
            <div className={styles['step-hint']}>
              {date === '' ? '…' : `${formatMonthDay(date)} · ${slots.length} slot${slots.length === 1 ? '' : 's'}`}
            </div>
          </div>
          <div className={styles['form-group']} style={{ marginBottom: 0 }}>
            <label htmlFor="recep-create-date">Date (within 30 days)</label>
            <input
              id="recep-create-date"
              type="date"
              value={date}
              min={date === '' ? undefined : todayLocalIn(branch?.tz ?? 'UTC')}
              max={maxDate === '' ? undefined : maxDate}
              onChange={(e) => {
                setDate(e.target.value);
                setSelectedStart('');
              }}
            />
            <div className={styles.hint}>
              Max 30 days ahead (FR-018). Same-day booking is not allowed.
            </div>
          </div>
          <div
            className={styles['form-group']}
            style={{ marginTop: 'var(--space-7)', marginBottom: 0 }}
          >
            <label>Available slots</label>
            <div className={styles.slots}>
              {slots.length === 0 && (
                <div className={styles.hint}>
                  No open slots for this doctor and type on that day.
                </div>
              )}
              {slots.map((s) => (
                <button
                  key={s.start}
                  type="button"
                  className={
                    s.selected
                      ? `${styles.slot} ${styles['slot-selected']}`
                      : styles.slot
                  }
                  onClick={() => setSelectedStart(s.start)}
                >
                  {formatTimeLocal(s.start, branch?.tz ?? 'UTC')}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Step 4 — Patient details */}
        <div className={styles.step}>
          <div className={styles['step-head']}>
            <StepNum n={4} state="current" />
            <div className={styles['step-title']}>Patient details</div>
            <div className={styles['step-hint']}>Existing or new patient</div>
          </div>
          <div className={styles['form-group']}>
            <label htmlFor="recep-create-phone">
              Patient phone <span className={styles.req}>*</span>
            </label>
            <div className={styles['phone-row']}>
              <PhoneCountryPicker
                countryCode={countryCode}
                onCountryChange={onCountryChange}
              />
              <input
                id="recep-create-phone"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                value={nationalNumber}
                placeholder="+966 5XX XXX 5555"
                onChange={(e) => onNumberChange(e.target.value)}
              />
            </div>
            <div className={styles.hint}>
              {patientPhone === ''
                ? `Country code ${countryName}. Existing patients match on phone (BR-016).`
                : `Will book as ${patientPhone}. Existing patients match on phone (BR-016).`}
            </div>
          </div>
          <div className={styles['form-group']} style={{ marginTop: 'var(--space-7)' }}>
            <label htmlFor="recep-create-name">
              Patient name <span className={styles.req}>*</span>
            </label>
            <input
              id="recep-create-name"
              type="text"
              value={patientName}
              onChange={(e) => setPatientName(e.target.value)}
            />
          </div>
          <div className={styles['form-group']} style={{ marginBottom: 0 }}>
            <label htmlFor="recep-create-notes">
              Notes for the doctor (optional)
            </label>
            <textarea
              id="recep-create-notes"
              rows={3}
              value={notes}
              placeholder="e.g. patient prefers afternoon calls, has mobility issues…"
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </div>

        {/* Step 5 — Confirm */}
        <form className={styles.step} onSubmit={onSubmit}>
          <div className={styles['step-head']}>
            <StepNum n={5} state="todo" />
            <div className={styles['step-title']}>Confirm booking</div>
            <div className={styles['step-hint']}>Review + create</div>
          </div>

          <div className={styles['confirm-box']}>
            <div className={styles['confirm-grid']}>
              <div>
                <span className={styles.k}>Branch:</span>{' '}
                <strong>{branch?.name ?? '—'}</strong>
              </div>
              <div>
                <span className={styles.k}>Doctor:</span>{' '}
                <strong>{selectedDoctor?.full_name ?? '—'}</strong>
              </div>
              <div>
                <span className={styles.k}>Type:</span>{' '}
                <strong>{selectedType?.name ?? '—'}</strong>
                {selectedType !== null && (
                  <> · {selectedType.duration_minutes} min</>
                )}
              </div>
              <div>
                <span className={styles.k}>When:</span>{' '}
                <strong>
                  {selectedSlot === null
                    ? '—'
                    : `${formatMonthDay(selectedSlot.start.slice(0, 10))} · ${formatTimeLocal(selectedSlot.start, branch?.tz ?? 'UTC')}`}
                </strong>
              </div>
              <div className={styles['confirm-grid-row-full']}>
                <span className={styles.k}>Patient:</span>{' '}
                <strong>{patientName.trim() === '' ? '—' : patientName}</strong>
                {patientPhone !== '' && <> · {patientPhone}</>}
              </div>
            </div>
          </div>

          <div className={styles['info-note']}>
            ℹ️ This booking will be marked as{' '}
            <strong>created on behalf of patient</strong>. audit.creator_role =
            &quot;receptionist&quot;.
          </div>

          <div className={styles['step-foot']}>
            <div className={styles.audit}>
              Atomic: <code>Appointment.create</code> · audit:{' '}
              <code>appointment.created</code>
            </div>
            <div className={styles['btn-row']}>
              <button
                type="button"
                className={styles['btn-ghost']}
                onClick={() => setSelectedStart('')}
              >
                Back
              </button>
              <button
                type="submit"
                className={styles['btn-primary']}
                disabled={
                  busy ||
                  selectedSlot === null ||
                  selectedType === null ||
                  patientPhone === '' ||
                  patientName.trim() === ''
                }
              >
                {busy ? 'Booking…' : 'Confirm booking'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </ReceptionistFrame>
  );
}
