/**
 * ReceptionistAvailability — read-only doctor availability browser (mock 16).
 *
 * 4 step cards: filters · date range · day-groups with slot grids ·
 * summary + "Book this slot →" CTA. The CTA deep-links to the
 * receptionist create flow (mock 14) with the slot pre-filled.
 * Booked slots render first-name-initial only (F-15).
 *
 * The calendar is assembled from two reads:
 *   - `GET /availability` — the OPEN slots for a doctor / type / day.
 *   - `GET /reception/branch/schedule` — the BOOKED slots for the
 *     branch's day. `GET /availability` only returns the open half;
 *     the booked half has to come from the schedule route.
 *
 * The two are merged on the UTC instant so an open slot and a booked
 * slot never occupy the same cell. `GET /availability` subtracts the
 * existing appointments, so an open slot is by definition not booked
 * — the merge is a union, not an overlay.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  ApiError,
  getAvailability,
  getReceptionSchedule,
  listAppointmentTypes,
  listDoctors,
  type AppointmentTypeDto,
  type DoctorWithBranchesDto,
  type ReceptionScheduleResponse,
} from '../api/client';
import { ReceptionistFrame } from './ReceptionistFrame';
import styles from './ReceptionistAvailability.module.css';
import { formatMonthDay, formatTimeLocal } from './recep-utils';
import {
  addDays,
  daysInRange,
  mergeDaySlots,
  type CalendarSlot,
} from './reception-schedule';

interface Props {
  /** Prefill for the create flow (mock 14) when the CTA is used. */
  onBookSlot?: (prefill: {
    doctor_id: string;
    appointment_type_id: string;
    date: string;
    start_datetime: string;
    end_datetime: string;
  }) => void;
}

interface DayGroup {
  date: string;
  slots: CalendarSlot[];
  closed: boolean;
  closedNote?: string;
}

/** FR-018: bookings are only accepted inside a 30-day window, so
 *  the browser only offers the same window. */
const WINDOW_DAYS = 30;

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return 'Session expired. Please sign in again.';
    if (err.status === 403) return 'You do not have access to this branch.';
    if (err.status === 400 && err.code === 'invalid_date') {
      return 'That date is not in the right format (YYYY-MM-DD).';
    }
    if (err.status === 400 && err.code === 'invalid_doctor_id') {
      return 'That doctor id is malformed.';
    }
    return `Could not load the schedule (${err.code}).`;
  }
  if (err instanceof TypeError) {
    return 'Connection failed. Is the API running on :3001?';
  }
  return 'Could not load the schedule.';
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

export function ReceptionistAvailability({ onBookSlot }: Props): ReactNode {
  const [schedule, setSchedule] = useState<ReceptionScheduleResponse | null>(
    null,
  );
  const [doctors, setDoctors] = useState<DoctorWithBranchesDto[]>([]);
  const [types, setTypes] = useState<AppointmentTypeDto[]>([]);
  const [doctorId, setDoctorId] = useState<string>('');
  const [typeId, setTypeId] = useState<string>('');
  const [fromDate, setFromDate] = useState<string>('');
  const [toDate, setToDate] = useState<string>('');
  const [openSlots, setOpenSlots] = useState<Map<string, string[]>>(new Map());
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<CalendarSlot | null>(null);

  // The branch envelope comes from the schedule route — it is the
  // receptionist's own branch, so there is nothing to pick.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    getReceptionSchedule({})
      .then((res) => {
        if (cancelled) return;
        setSchedule(res);
        const from = res.date;
        setFromDate(from);
        setToDate(addDays(from, WINDOW_DAYS - 1));
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
  }, []);

  // The doctor and type pickers are fed from the admin catalogue,
  // narrowed to the receptionist's branch.
  useEffect(() => {
    if (schedule === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const [d, t] = await Promise.all([
          listDoctors({ active: true, branch_id: schedule.branch.id }),
          listAppointmentTypes({ active: true }),
        ]);
        if (cancelled) return;
        const branchDoctors = d.filter((doc) =>
          doc.branches.some((b) => b.id === schedule.branch.id),
        );
        setDoctors(branchDoctors);
        setTypes(t);
        if (branchDoctors.length > 0) {
          setDoctorId((prev) =>
            prev === '' ? (branchDoctors[0]?.id ?? '') : prev,
          );
        }
        if (t.length > 0) {
          setTypeId((prev) => (prev === '' ? (t[0]?.id ?? '') : prev));
        }
      } catch (e: unknown) {
        if (!cancelled) setErr(describeError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [schedule]);

  // Open slots for every day in the range. The availability route
  // takes one day at a time, so the range fans out.
  useEffect(() => {
    if (schedule === null) return;
    if (doctorId === '' || typeId === '' || fromDate === '') return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const days = daysInRange(fromDate, toDate, WINDOW_DAYS);
      const results = await Promise.all(
        days.map(async (day) => {
          try {
            const res = await getAvailability({
              doctor_id: doctorId,
              branch_id: schedule.branch.id,
              date: day,
              appointment_type_id: typeId,
            });
            return [day, res.slots.map((s) => s.start_datetime)] as const;
          } catch {
            // A day outside the branch's hours answers with a reason
            // rather than slots; that day simply has none.
            return [day, [] as string[]] as const;
          }
        }),
      );
      if (cancelled) return;
      setOpenSlots(new Map(results));
      setErr(null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [schedule, doctorId, typeId, fromDate, toDate]);

  // The booked half of the calendar, per day.
  const [bookedByDay, setBookedByDay] = useState<
    Map<string, ReceptionScheduleResponse['booked']>
  >(new Map());

  useEffect(() => {
    if (schedule === null) return;
    let cancelled = false;
    void (async () => {
      const days = daysInRange(fromDate, toDate, WINDOW_DAYS);
      const results = await Promise.all(
        days.map(async (day) => {
          try {
            const res = await getReceptionSchedule({ date: day });
            return [day, res.booked] as const;
          } catch {
            return [day, [] as ReceptionScheduleResponse['booked']] as const;
          }
        }),
      );
      if (cancelled) return;
      setBookedByDay(new Map(results));
    })();
    return () => {
      cancelled = true;
    };
  }, [schedule, fromDate, toDate]);

  const days = useMemo(() => {
    if (schedule === null) return [] as string[];
    return daysInRange(fromDate, toDate, WINDOW_DAYS);
  }, [schedule, fromDate, toDate]);

  const groups = useMemo<DayGroup[]>(() => {
    if (schedule === null) return [];
    const duration =
      types.find((t) => t.id === typeId)?.duration_minutes ?? 30;
    return days.map((day) => {
      const slots = mergeDaySlots(
        openSlots.get(day) ?? [],
        bookedByDay.get(day) ?? [],
        duration,
      );
      return {
        date: day,
        slots,
        closed: slots.length === 0,
        closedNote:
          slots.length === 0 ? 'No slots for this doctor on this day.' : undefined,
      };
    });
  }, [schedule, days, openSlots, bookedByDay, typeId, types]);

  const selectedType = types.find((t) => t.id === typeId) ?? null;
  const selectedDoctor = doctors.find((d) => d.id === doctorId) ?? null;

  const onBook = useCallback(() => {
    if (selected === null || selected.state !== 'open') return;
    if (schedule === null) return;
    onBookSlot?.({
      doctor_id: doctorId,
      appointment_type_id: typeId,
      date: selected.start.slice(0, 10),
      start_datetime: selected.start,
      end_datetime: selected.end,
    });
  }, [selected, schedule, doctorId, typeId, onBookSlot]);

  const openCount = useMemo(
    () =>
      groups.reduce(
        (n, g) => n + g.slots.filter((s) => s.state === 'open').length,
        0,
      ),
    [groups],
  );
  const bookedCount = useMemo(
    () =>
      groups.reduce(
        (n, g) => n + g.slots.filter((s) => s.state === 'booked').length,
        0,
      ),
    [groups],
  );

  return (
    <ReceptionistFrame>
      <div className={styles['page']}>
        <header className={styles['page-header']}>
          <div className={styles.crumb}>Today → Doctor availability</div>
          <h1>Doctor availability · read-only</h1>
          <p className={styles.sub}>
            Browse open slots, then jump into F-13 to book one.
          </p>
        </header>

        {/* Step 1 — filters */}
        <div className={styles.step}>
          <div className={styles['step-head']}>
            <StepNum n={1} state="done" />
            <div className={styles['step-title']}>Filters</div>
            <div className={styles['step-hint']}>
              Branch locked · 30-day window
            </div>
          </div>
          <div className={styles['row-2']}>
            <div className={styles['form-group']} style={{ marginBottom: 0 }}>
              <label htmlFor="recep-avail-doctor">Doctor (your branch only)</label>
              <select
                id="recep-avail-doctor"
                value={doctorId}
                onChange={(e) => {
                  setDoctorId(e.target.value);
                  setSelected(null);
                }}
              >
                {doctors.length === 0 && <option value="">No doctors</option>}
                {doctors.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.full_name}
                  </option>
                ))}
              </select>
              <div className={styles.hint}>
                {schedule === null
                  ? 'Loading branch…'
                  : `Only doctors assigned to ${schedule.branch.name}.`}
              </div>
            </div>
            <div className={styles['form-group']} style={{ marginBottom: 0 }}>
              <label htmlFor="recep-avail-type">Appointment type</label>
              <select
                id="recep-avail-type"
                value={typeId}
                onChange={(e) => {
                  setTypeId(e.target.value);
                  setSelected(null);
                }}
              >
                {types.length === 0 && <option value="">No types</option>}
                {types.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} · {t.duration_minutes} min
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Step 2 — pick a date */}
        <div className={styles.step}>
          <div className={styles['step-head']}>
            <StepNum n={2} state="done" />
            <div className={styles['step-title']}>Pick a date</div>
            <div className={styles['step-hint']}>
              {fromDate === '' ? '…' : `${formatMonthDay(fromDate)} — ${formatMonthDay(toDate)}`}
            </div>
          </div>
          <div className={styles['form-group']} style={{ marginBottom: 0 }}>
            <label htmlFor="recep-avail-from">Date range (within 30 days)</label>
            <div className={styles['date-range']}>
              <input
                id="recep-avail-from"
                type="date"
                value={fromDate}
                onChange={(e) => {
                  setFromDate(e.target.value);
                  setSelected(null);
                }}
              />
              <input
                id="recep-avail-to"
                type="date"
                value={toDate}
                onChange={(e) => {
                  setToDate(e.target.value);
                  setSelected(null);
                }}
              />
            </div>
            <div className={styles.hint}>
              Max range: 30 days (BR-013). Same-day not allowed.
            </div>
          </div>
        </div>

        {/* Step 3 — slots grouped by day */}
        <div className={styles.step}>
          <div className={styles['step-head']}>
            <StepNum n={3} state="current" />
            <div className={styles['step-title']}>
              Open slots{selectedDoctor === null ? '' : ` · ${selectedDoctor.full_name}`}
            </div>
            <div className={styles['step-hint']}>
              {openCount} open · {bookedCount} booked
            </div>
          </div>

          {err && <div className={styles['day-group-closed-note']}>{err}</div>}

          {loading && groups.length === 0 && (
            <div className={styles['day-group-closed-note']}>Loading slots…</div>
          )}

          {groups.map((day) => (
            <div
              key={day.date}
              className={
                day.closed
                  ? `${styles['day-group']} ${styles['day-group-closed']}`
                  : styles['day-group']
              }
            >
              <div className={styles['day-group-head']}>
                <div className={styles['day-group-d']}>
                  {formatMonthDay(day.date)}
                  {schedule !== null && day.date === schedule.date && (
                    <span className={styles['today-tag']}>TODAY</span>
                  )}
                </div>
                {day.closed ? (
                  <div className={styles['day-group-c']}>No slots</div>
                ) : (
                  <div className={styles['day-group-c']}>
                    <strong>
                      {day.slots.filter((s) => s.state === 'open').length}
                    </strong>{' '}
                    open · {day.slots.filter((s) => s.state === 'booked').length}{' '}
                    booked
                  </div>
                )}
              </div>
              {day.closed ? (
                <div className={styles['day-group-closed-note']}>
                  {day.closedNote}
                </div>
              ) : (
                <div className={styles.slots}>
                  {day.slots.map((s) => {
                    const tz = schedule?.branch.tz ?? 'UTC';
                    const isSelected =
                      selected !== null && selected.start === s.start;
                    const cls =
                      s.state === 'booked'
                        ? `${styles.slot} ${styles['slot-booked']}`
                        : isSelected
                          ? `${styles.slot} ${styles['slot-selected']}`
                          : styles.slot;
                    return (
                      <button
                        key={s.start}
                        type="button"
                        className={cls}
                        disabled={s.state === 'booked'}
                        onClick={() => setSelected(s)}
                      >
                        <div className={styles['slot-t']}>
                          {formatTimeLocal(s.start, tz)}
                        </div>
                        <div className={styles['slot-a']}>
                          {s.state === 'booked' ? (s.initial ?? '•') : 'Open'}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ))}

          <div className={styles['privacy-note']}>
            🔒 Booked slots show first-name initial only (F-15). Receptionist
            cannot modify the schedule (BR-004).
          </div>
        </div>

        {/* Step 4 — pick slot + book */}
        <div className={styles.step}>
          <div className={styles['step-head']}>
            <StepNum n={4} state="todo" />
            <div className={styles['step-title']}>Selected slot → Book</div>
            <div className={styles['step-hint']}>One click to F-13</div>
          </div>

          <div className={styles['summary-box']}>
            <div className={styles['summary-row']}>
              <span className={styles['summary-k']}>Doctor</span>
              <span className={styles['summary-v']}>
                {selectedDoctor?.full_name ?? '—'}
              </span>
            </div>
            <div className={styles['summary-row']}>
              <span className={styles['summary-k']}>Type</span>
              <span className={styles['summary-v']}>
                {selectedType === null
                  ? '—'
                  : `${selectedType.name} · ${selectedType.duration_minutes} min`}
              </span>
            </div>
            <div className={styles['summary-row']}>
              <span className={styles['summary-k']}>When</span>
              <span className={styles['summary-v']}>
                {selected === null
                  ? '—'
                  : `${formatMonthDay(selected.start.slice(0, 10))} · ${formatTimeLocal(selected.start, schedule?.branch.tz ?? 'UTC')} — ${formatTimeLocal(selected.end, schedule?.branch.tz ?? 'UTC')}`}
              </span>
            </div>
            <div className={styles['summary-row']}>
              <span className={styles['summary-k']}>Branch</span>
              <span className={styles['summary-v']}>
                {schedule?.branch.name ?? '—'}
              </span>
            </div>
          </div>

          <div className={styles['step-foot']}>
            <div className={styles.audit}>
              Read-only: <code>Availability.read</code> · prefill for{' '}
              <code>F-13.create</code>
            </div>
            <button
              type="button"
              className={styles['btn-primary']}
              disabled={selected === null || selected.state !== 'open'}
              onClick={onBook}
            >
              + Book this slot →
            </button>
          </div>
        </div>
      </div>
    </ReceptionistFrame>
  );
}
