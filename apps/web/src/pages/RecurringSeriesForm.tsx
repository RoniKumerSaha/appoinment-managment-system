/**
 * RecurringSeriesForm — the entry point for the recurring booking flow.
 *
 * The recurring flow is a three-step machine: collect the series
 * shape → preview (server validates every occurrence) → confirm
 * (atomic batch insert). This component is step one: it collects
 * exactly the fields `POST /recurring/preview` accepts, so the
 * request body is the form's output verbatim.
 *
 * The lookups (branches, appointment types) come from the staff
 * catalogue, so the form never offers an id the server would reject.
 *
 * The DOCTOR is not a lookup here. This form is mounted only by
 * `DoctorApp`, and `POST /recurring/preview` binds a doctor's series
 * to their OWN id (`claim.doctor_id !== body.doctor_id` → 403
 * `outside_branch_scope`). The old dropdown listed every active
 * doctor, so a doctor could pick a colleague — and then the preview
 * came back 403 with no hint why. The field is now a fixed,
 * read-only display of the signed-in doctor: the id still travels in
 * the request body (the API requires it), but there is nothing to
 * get wrong.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { DoctorFrame } from './DoctorFrame';
import { useAuth } from '../auth/store';
import styles from './RecurringSeriesForm.module.css';
import {
  listStaffAppointmentTypes,
  listStaffBranches,
  type AppointmentTypeDto,
  type BranchDto,
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
  const { stored } = useAuth();
  const claim = stored?.claim;
  const doctorId = claim?.doctor_id ?? '';
  const doctorName = stored?.profile?.full_name ?? 'your clinic';

  const [branches, setBranches] = useState<BranchDto[]>([]);
  const [types, setTypes] = useState<AppointmentTypeDto[]>([]);
  const [lookupError, setLookupError] = useState<string | null>(null);

  const [branchId, setBranchId] = useState('');
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
        const [b, t] = await Promise.all([
          listStaffBranches('active'),
          listStaffAppointmentTypes({ active: true }),
        ]);
        if (cancelled) return;
        // Only the branches this doctor actually works at. The
        // preview route requires `branch_id ∈ claim.branch_ids`, so
        // offering every active branch only produced 403s.
        const mine = b.filter(
          (branch) => claim?.branch_ids?.includes(branch.id) ?? false,
        );
        const usable = mine.length > 0 ? mine : b;
        setBranches(usable);
        setTypes(t);
        setBranchId((prev) => prev || (usable[0]?.id ?? ''));
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
          setLookupError('Could not load branches and appointment types.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [claim?.branch_ids]);

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
      // The doctor id comes from the signed-in claim, so it is always
      // present for a doctor session. If it is somehow missing the
      // server would answer 403 `outside_branch_scope` — better to
      // say so here than to send a request that cannot succeed.
      if (doctorId === '') {
        setLookupError(
          'Your session does not carry a doctor id, so a recurring series cannot be booked. Sign in again.',
        );
        return;
      }
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
    <DoctorFrame activeNav="series">
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
            {/*
              Fixed, not a dropdown. A doctor can only book a
              recurring series for THEMSELVES — `POST /recurring/preview`
              binds `doctor_id` to `claim.doctor_id` and rejects
              anything else with 403 `outside_branch_scope`. Offering
              a list of colleagues meant a doctor could pick one,
              press "Preview series", and get a bare 403 with no
              explanation. The id still travels in the request body
              (the API requires it); there is simply nothing to
              choose wrongly.
            */}
            <input
              id="rec-doctor"
              type="text"
              value={doctorName}
              readOnly
              aria-readonly="true"
              aria-describedby="rec-doctor-hint"
              style={{ cursor: 'default' }}
            />
            <div className={styles.hint} id="rec-doctor-hint">
              Recurring series are booked for you — this cannot be
              changed.
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
    </DoctorFrame>
  );
}
