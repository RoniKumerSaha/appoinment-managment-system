/**
 * RecurringSeriesForm — the entry point for the recurring booking flow.
 *
 * The recurring flow is a three-step machine: collect the series
 * shape → preview (server validates every occurrence) → confirm
 * (atomic batch insert). This component is step one: it collects
 * exactly the fields `POST /recurring/preview` accepts, so the
 * request body is the form's output verbatim.
 *
 * The lookups (doctors, branches, appointment types) come from the
 * admin API, so the form never offers an id the server would reject.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { DoctorFrame } from './DoctorFrame';
import styles from './RecurringSeriesForm.module.css';
import {
  listStaffAppointmentTypes,
  listStaffBranches,
  listStaffDoctors,
  type AppointmentTypeDto,
  type BranchDto,
  type DoctorWithBranchesDto,
  type RecurrenceKind,
  type RecurringSeriesInput,
} from '../api/client';

export interface RecurringSeriesFormProps {
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
 * `same_day_exclusion` (see `recurring-helpers.ts` step 4), so the
 * form's default start date has to be TOMORROW. It used to default to
 * today, which meant the first occurrence was skipped before the
 * user touched anything.
 */
function tomorrowLocal(): string {
  const now = new Date();
  now.setDate(now.getDate() + 1);
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function RecurringSeriesForm({
  error,
  busy,
  onSubmit,
}: RecurringSeriesFormProps): ReactNode {
  const [branches, setBranches] = useState<BranchDto[]>([]);
  const [doctors, setDoctors] = useState<DoctorWithBranchesDto[]>([]);
  const [types, setTypes] = useState<AppointmentTypeDto[]>([]);
  const [lookupError, setLookupError] = useState<string | null>(null);

  const [branchId, setBranchId] = useState('');
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

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [b, d, t] = await Promise.all([
          listStaffBranches('active'),
          listStaffDoctors({ active: true }),
          listStaffAppointmentTypes({ active: true }),
        ]);
        if (cancelled) return;
        setBranches(b);
        setDoctors(d);
        setTypes(t);
        setBranchId((prev) => prev || (b[0]?.id ?? ''));
        setDoctorId((prev) => prev || (d[0]?.id ?? ''));
        setTypeId((prev) => prev || (t[0]?.id ?? ''));
        // The duration field used to keep a hardcoded '30' while the
        // type was picked programmatically — the select's onChange
        // never fired, so the form showed "30" next to the hint
        // "Type default: 15 min". The server requires
        // `duration_minutes` to EQUAL the type's duration
        // (`recurring-helpers.ts` step 2 returns
        // `outside_branch_hours` on a mismatch), so the field had to
        // follow the type. Seed it from the first type here, and let
        // the effect below keep it in sync.
        const firstType = t[0];
        if (firstType) setDuration(String(firstType.duration_minutes));
      } catch {
        if (!cancelled) {
          setLookupError('Could not load doctors, branches, and appointment types.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const branchDoctors = useMemo(
    () => doctors.filter((d) => d.branches.some((b) => b.id === branchId)),
    [doctors, branchId],
  );

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
      const body: RecurringSeriesInput = {
        doctor_id: doctorId,
        branch_id: branchId,
        appointment_type_id: typeId,
        patient_phone: phone.trim(),
        patient_first_name: firstName.trim() === '' ? null : firstName.trim(),
        recurrence_kind: kind,
        recurrence_interval_days:
          kind === 'weekly' ? 7 : kind === 'every_two_weeks' ? 14 : Number(intervalDays),
        start_date: startDate,
        time_of_day: timeOfDay,
        duration_minutes: Number(duration),
        occurrences_or_until_date: Number(occurrences),
      };
      onSubmit(body);
    },
    [
      doctorId,
      branchId,
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
    <DoctorFrame>
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
            <select
              id="rec-branch"
              value={branchId}
              onChange={(e) => setBranchId(e.target.value)}
              required
            >
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>

          <div className={styles['field']}>
            <label htmlFor="rec-doctor">Doctor</label>
            <select
              id="rec-doctor"
              value={doctorId}
              onChange={(e) => setDoctorId(e.target.value)}
              required
            >
              {branchDoctors.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.full_name}
                </option>
              ))}
            </select>
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
    </DoctorFrame>
  );
}
