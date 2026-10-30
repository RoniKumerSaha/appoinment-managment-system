/**
 * ReceptionistRecurringForm — the receptionist's recurring-series
 * entry step.
 *
 * The API has always accepted a receptionist on
 * `POST /recurring/preview` and `POST /recurring/confirm`
 * (`recurring-preview.ts:89`, `recurring-confirm.ts:99`) — the scope
 * is branch-only (BR-004), and the preview checks that the chosen
 * doctor actually works at that branch (`doctor_not_at_branch`).
 * But the recurring flow was mounted ONLY in `DoctorApp`, so the
 * server was more capable than the receptionist's own surface. This
 * is the missing entry point.
 *
 * The difference from the doctor's form (`RecurringSeriesForm`) is
 * the DOCTOR field:
 *
 *   - The doctor books a series for THEMSELVES. `POST /recurring/
 *     preview` binds `doctor_id` to `claim.doctor_id` and rejects
 *     anything else with 403 `outside_branch_scope`, so the doctor's
 *     field is a fixed read-only display.
 *   - The receptionist books on BEHALF OF a patient, for any doctor
 *     at their branch — the same freedom the single-booking walk-in
 *     form already has (`ReceptionistCreate` has a doctor picker
 *     filtered to the branch). Here the picker is filtered to the
 *     branch's ACTIVE doctors, and the API re-checks the pairing
 *     server-side.
 *
 * Everything else — the lookups, the duration/type coupling, the
 * same-day exclusion (FR-019), the shape of the request body — is
 * identical to the doctor's form. The two must not drift, so the
 * field order and the validation rules are mirrored exactly.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ReceptionistFrame } from './ReceptionistFrame';
import {
  getReceptionSchedule,
  listStaffAppointmentTypes,
  listStaffDoctors,
  type AppointmentTypeDto,
  type DoctorWithBranchesDto,
  type RecurrenceKind,
  type RecurringSeriesInput,
} from '../api/client';
import styles from './RecurringSeriesForm.module.css';

export interface ReceptionistRecurringFormProps {
  error: string | null;
  busy: boolean;
  onSubmit: (input: RecurringSeriesInput) => void;
}

const KINDS: Array<{ value: RecurrenceKind; label: string }> = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'every_two_weeks', label: 'Every 2 weeks' },
  { value: 'custom_days', label: 'Custom interval' },
];

/**
 * FR-019: same-day booking is not allowed. The recurring validator
 * rejects an occurrence whose branch-local date equals today's with
 * `same_day_exclusion`, so the form's default start date has to be
 * TOMORROW.
 */
function tomorrowLocal(): string {
  const now = new Date();
  now.setDate(now.getDate() + 1);
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function ReceptionistRecurringForm({
  error,
  busy,
  onSubmit,
}: ReceptionistRecurringFormProps): ReactNode {
  const [branch, setBranch] = useState<{
    id: string;
    name: string;
    tz: string;
  } | null>(null);
  const [doctors, setDoctors] = useState<DoctorWithBranchesDto[]>([]);
  const [types, setTypes] = useState<AppointmentTypeDto[]>([]);
  const [lookupError, setLookupError] = useState<string | null>(null);

  const [doctorId, setDoctorId] = useState('');
  const [typeId, setTypeId] = useState('');
  const [phone, setPhone] = useState('');
  const [firstName, setFirstName] = useState('');
  const [kind, setKind] = useState<RecurrenceKind>('weekly');
  const [intervalDays, setIntervalDays] = useState('7');
  const [startDate, setStartDate] = useState(tomorrowLocal);
  const [timeOfDay, setTimeOfDay] = useState('09:00');
  const [duration, setDuration] = useState('30');
  const [occurrences, setOccurrences] = useState('6');
  /** True once the user has manually edited the duration. After that
   *  the type's default no longer overwrites their choice. */
  const [durationTouched, setDurationTouched] = useState(false);

  // The branch is the receptionist's own — read it, never pick it.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const sched = await getReceptionSchedule({});
        if (cancelled) return;
        setBranch(sched.branch);

        const [d, t] = await Promise.all([
          listStaffDoctors({ active: true, branch_id: sched.branch.id }),
          listStaffAppointmentTypes({ active: true }),
        ]);
        if (cancelled) return;
        // Only the doctors who actually work at this branch. The
        // preview route checks the pairing too (`doctor_not_at_branch`),
        // but offering a doctor who is not at the branch would only
        // produce a 400.
        const atBranch = d.filter((doc) =>
          doc.branches.some((b) => b.id === sched.branch.id),
        );
        setDoctors(atBranch);
        setTypes(t);
        setDoctorId((prev) => prev || (atBranch[0]?.id ?? ''));
        setTypeId((prev) => prev || (t[0]?.id ?? ''));
        const firstType = t[0];
        if (firstType) setDuration(String(firstType.duration_minutes));
      } catch {
        if (!cancelled) {
          setLookupError('Could not load branches, doctors and appointment types.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedType = useMemo(
    () => types.find((t) => t.id === typeId),
    [types, typeId],
  );

  // Keep the duration field aligned with the selected type. The
  // server rejects a mismatch (`submittedDuration !==
  // type.duration_minutes` → `outside_branch_hours`), so a stale
  // value is a guaranteed preview failure. A manual edit wins until
  // the user picks a different type.
  useEffect(() => {
    if (durationTouched) return;
    if (selectedType === undefined) return;
    setDuration(String(selectedType.duration_minutes));
  }, [selectedType, durationTouched]);

  const onSubmitForm = useCallback(
    (e: React.FormEvent<HTMLFormElement>): void => {
      e.preventDefault();
      if (branch === null) {
        setLookupError('Your branch is still loading. Try again in a moment.');
        return;
      }
      if (doctorId === '') {
        setLookupError('Pick a doctor for the series.');
        return;
      }
      const body: RecurringSeriesInput = {
        doctor_id: doctorId,
        branch_id: branch.id,
        appointment_type_id: typeId,
        patient_phone: phone.trim(),
        patient_first_name:
          firstName.trim() === '' ? null : firstName.trim(),
        recurrence_kind: kind,
        recurrence_interval_days:
          kind === 'weekly'
            ? 7
            : kind === 'every_two_weeks'
              ? 14
              : Number(intervalDays),
        start_date: startDate,
        time_of_day: timeOfDay,
        duration_minutes: Number(duration),
        occurrences_or_until_date: Number(occurrences),
      };
      onSubmit(body);
    },
    [
      branch,
      doctorId,
      typeId,
      phone,
      firstName,
      kind,
      intervalDays,
      startDate,
      timeOfDay,
      duration,
      occurrences,
      onSubmit,
    ],
  );

  const message = error ?? lookupError;

  return (
    <ReceptionistFrame activeNav="series">
      <div className={styles['page']}>
        <header className={styles['page-header']}>
          <h1>New recurring series</h1>
          <p className={styles['sub']}>
            Each occurrence is validated on its own. Nothing is booked until you confirm the
            preview.
          </p>
        </header>

        {message !== null && (
          <div className={styles['error']} role="alert">
            {message}
          </div>
        )}

        <form className={styles.form} onSubmit={onSubmitForm}>
          <div className={styles['field']}>
            <label htmlFor="rec-branch">Branch</label>
            {/*
              Locked to the receptionist's own branch. A
              receptionist is pinned to exactly one branch
              (BR-004), and the preview route rejects a branch
              outside `claim.branch_ids` with 403
              `outside_branch_scope` — so there is nothing to
              choose.
            */}
            <input
              id="rec-branch"
              type="text"
              value={branch?.name ?? 'Loading…'}
              readOnly
              aria-readonly="true"
              aria-describedby="rec-branch-hint"
              style={{ cursor: 'default' }}
            />
            <div className={styles.hint} id="rec-branch-hint">
              Your assigned branch — this cannot be changed.
            </div>
          </div>

          <div className={styles['field']}>
            <label htmlFor="rec-doctor">Doctor</label>
            {/*
              A picker, NOT a fixed display: the receptionist books
              on behalf of a patient for any doctor at their branch
              (the same freedom `ReceptionistCreate` has for a
              single booking). The list is narrowed to the branch's
              active doctors, and the API re-checks the pairing.
            */}
            <select
              id="rec-doctor"
              value={doctorId}
              onChange={(e) => setDoctorId(e.target.value)}
              required
            >
              {doctors.length === 0 && <option value="">No doctors</option>}
              {doctors.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.full_name}
                </option>
              ))}
            </select>
            <div className={styles.hint}>
              Only doctors who work at this branch.
            </div>
          </div>

          <div className={styles['field']}>
            <label htmlFor="rec-type">Appointment type</label>
            <select
              id="rec-type"
              value={typeId}
              onChange={(e) => {
                setTypeId(e.target.value);
                // Picking a type re-seeds the duration — the type
                // owns the slot length. This also clears the
                // "manually edited" flag so the duration follows the
                // type again.
                const next = types.find((t) => t.id === e.target.value);
                if (next) {
                  setDurationTouched(false);
                  setDuration(String(next.duration_minutes));
                }
              }}
              required
            >
              {types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.duration_minutes} min)
                </option>
              ))}
            </select>
          </div>

          <div className={styles['field']}>
            <label htmlFor="rec-phone">Patient phone (E.164)</label>
            <input
              id="rec-phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+9665XXXXXXXX"
              required
            />
          </div>

          <div className={styles['field']}>
            <label htmlFor="rec-first-name">Patient first name</label>
            <input
              id="rec-first-name"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
            />
          </div>

          <div className={styles['field']}>
            <label htmlFor="rec-kind">Pattern</label>
            <select
              id="rec-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as RecurrenceKind)}
            >
              {KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
          </div>

          {kind === 'custom_days' && (
            <div className={styles['field']}>
              <label htmlFor="rec-interval">Interval (days)</label>
              <input
                id="rec-interval"
                type="number"
                min={1}
                max={60}
                value={intervalDays}
                onChange={(e) => setIntervalDays(e.target.value)}
                required
              />
            </div>
          )}

          <div className={styles['field']}>
            <label htmlFor="rec-start">Start date</label>
            <input
              id="rec-start"
              type="date"
              value={startDate}
              min={tomorrowLocal()}
              onChange={(e) => setStartDate(e.target.value)}
              required
            />
            <div className={styles.hint}>
              Same-day series are not allowed (FR-019) — the earliest
              start is tomorrow.
            </div>
          </div>

          <div className={styles['field']}>
            <label htmlFor="rec-time">Time of day</label>
            <input
              id="rec-time"
              type="time"
              value={timeOfDay}
              onChange={(e) => setTimeOfDay(e.target.value)}
              required
            />
          </div>

          <div className={styles['field']}>
            <label htmlFor="rec-duration">Duration (min)</label>
            <input
              id="rec-duration"
              type="number"
              min={5}
              max={480}
              value={duration}
              onChange={(e) => {
                setDurationTouched(true);
                setDuration(e.target.value);
              }}
              required
            />
            {selectedType !== undefined && (
              <div className={styles.hint}>
                {durationTouched
                  ? `Type default: ${selectedType.duration_minutes} min · must match to book`
                  : `Type default: ${selectedType.duration_minutes} min`}
              </div>
            )}
          </div>

          <div className={styles['field']}>
            <label htmlFor="rec-occurrences">Occurrences</label>
            <input
              id="rec-occurrences"
              type="number"
              min={1}
              max={60}
              value={occurrences}
              onChange={(e) => setOccurrences(e.target.value)}
              required
            />
          </div>

          <div className={styles.actions}>
            <button type="submit" className={styles['btn-primary']} disabled={busy}>
              {busy ? 'Validating…' : 'Preview series →'}
            </button>
          </div>
        </form>
      </div>
    </ReceptionistFrame>
  );
}
