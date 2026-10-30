/**
 * DoctorSchedule — the doctor's own weekly schedule editor
 * (`#/doctor?page=schedule`).
 *
 * `docs/design/user-flows/doctor.md` Act 1 lists "Schedule editor"
 * as a DOCTOR section, and mockup 09 is the design for it. The only
 * implementation was `AdminDoctorSchedule` — an admin page at
 * `#/admin/doctors/<id>/schedule`, backed by routes under `/admin`
 * that `app.ts` gates behind `adminScope`. A doctor had no way to
 * open their own working hours; they had to ask an admin.
 *
 * This page is the doctor-facing counterpart. It is the SAME editor
 * (mock 09's two-column layout, day tabs, inline period editing,
 * split/delete, impact preview) but bound to the signed-in doctor:
 *
 *   - There is no doctor picker — the schedule is always YOURS. The
 *     server binds the doctor id from `claim.doctor_id`; there is no
 *     `:doctor_id` in the path.
 *   - The branch list comes from the staff catalogue, filtered to the
 *     branches the doctor works at.
 *   - The impact preview and the save both go through the new
 *     doctor-scoped routes (`/doctor/schedule-impact`,
 *     `/doctor/schedule`), which apply exactly the admin route's
 *     validation and transactional semantics.
 *
 * The editor's CSS is shared with the admin page
 * (`AdminDoctorSchedule.module.css`) — it is a faithful port of
 * mockup 09 and token-only, so there is no reason to fork it.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from 'react';
import {
  ApiError,
  getMyDoctorSchedule,
  listStaffBranches,
  previewMyDoctorSchedule,
  saveMyDoctorSchedule,
  type BranchDto,
  type DoctorScheduleRow,
} from '../api/client';
import { useAuth } from '../auth/store';
import { DoctorFrame } from './DoctorFrame';
import styles from './AdminDoctorSchedule.module.css';

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const DAY_LABELS_LONG = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

interface FormError {
  status: number;
  code: string;
  message: string;
}

function describeApiError(err: unknown): FormError {
  if (err instanceof ApiError) {
    let message = err.code;
    if (err.code === 'invalid_schedule_row') {
      message =
        'A period row is invalid (check day_of_week 0–6, start<end, effective_from).';
    } else if (err.code === 'schedule_rows_overlap') {
      message = 'Two periods overlap on the same day — please adjust.';
    } else if (err.code === 'branch_not_in_doctor_branches') {
      message = 'A period uses a branch you are not assigned to.';
    } else if (err.code === 'schedule_invalidates_future_appointments') {
      message =
        'This change would invalidate future appointments. Adjust periods or acknowledge.';
    } else if (err.code === 'invalid_rows') {
      message = 'rows[] is required.';
    } else if (err.code === 'invalid_acknowledge') {
      message = 'acknowledge must be true or false.';
    } else if (err.code === 'unknown_field') {
      message = 'Unsupported field sent to the API.';
    } else if (err.status === 0 || err.code === 'network_error') {
      message = 'Connection failed. Is the API running on :3001?';
    } else if (err.status >= 500) {
      message = 'Server error. Try again in a moment.';
    }
    return { status: err.status, code: err.code, message };
  }
  return { status: 0, code: 'unknown_error', message: 'Unknown error.' };
}

function tomorrowIsoDate(d: Date): string {
  const t = new Date(d);
  t.setUTCDate(t.getUTCDate() + 1);
  const yyyy = t.getUTCFullYear();
  const mm = String(t.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(t.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function isoDateToLongLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

function isoToTimeLabel(t: string): string {
  // API returns HH:MM:SS or HH:MM; show HH:MM.
  return t.slice(0, 5);
}

/** "morning" / "afternoon" / "evening" block label based on start hour. */
function blockLabel(start: string): string {
  const hh = Number(start.slice(0, 2));
  if (hh < 12) return 'Morning block';
  if (hh < 17) return 'Afternoon block';
  return 'Evening block';
}

function durationHours(start: string, end: string): number {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  const sM = (sh ?? 0) * 60 + (sm ?? 0);
  const eM = (eh ?? 0) * 60 + (em ?? 0);
  return Math.max(0, (eM - sM) / 60);
}

function formatHourLabel(h: number): string {
  if (h === Math.floor(h)) return `${h}h`;
  return `${h.toFixed(1)}h`;
}

interface WorkingRow extends DoctorScheduleRow {
  /** Client-only id for React keys + edit/delete tracking. */
  _key: string;
}

function makeKey(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function DoctorSchedule({ activeNav }: { activeNav?: string }) {
  const { stored } = useAuth();
  const displayName = stored?.profile?.full_name ?? 'your';

  const [schedule, setSchedule] = useState<WorkingRow[]>([]);
  const [branches, setBranches] = useState<BranchDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<FormError | null>(null);

  const [selectedBranchId, setSelectedBranchId] = useState<string | null>(null);
  const [activeDay, setActiveDay] = useState<number>(1); // Mon by default

  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState<FormError | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Inline edit state for the active day's periods.
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editStart, setEditStart] = useState<string>('09:00');
  const [editEnd, setEditEnd] = useState<string>('13:00');

  const [affectedPreview, setAffectedPreview] = useState<
    Array<{
      id: string;
      patient_phone_masked: string;
      branch_id: string;
      start_datetime: string;
      status: string;
    }>
  | null>(null);
  const [acknowledgedImpact, setAcknowledgedImpact] = useState(false);

  // Initial load.
  const reload = useCallback(async (): Promise<void> => {
    const [sched, branchList] = await Promise.all([
      getMyDoctorSchedule(),
      listStaffBranches('active'),
    ]);
    setSchedule(
      sched.schedule.map((r) => ({ ...r, _key: makeKey() })),
    );
    setBranches(branchList);
    // Initial branch selection: the first branch the schedule already
    // uses, else the first branch in the catalogue.
    const firstUsed = sched.schedule[0]?.branch_id;
    setSelectedBranchId((prev) => prev ?? firstUsed ?? branchList[0]?.id ?? null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadErr(null);
    reload()
      .catch((err: unknown) => {
        if (!cancelled) setLoadErr(describeApiError(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reload]);

  // Rows for the currently selected branch.
  const branchRows = useMemo(
    () => schedule.filter((r) => r.branch_id === selectedBranchId),
    [schedule, selectedBranchId],
  );

  // Counts per day-of-week for the day-tabs.
  const dayCounts = useMemo(() => {
    const counts = new Array<number>(7).fill(0);
    for (const r of branchRows) {
      const dow = r.day_of_week;
      if (dow >= 0 && dow < 7) counts[dow] = (counts[dow] ?? 0) + 1;
    }
    return counts;
  }, [branchRows]);

  // Rows on the active day.
  const dayRows = useMemo(
    () =>
      branchRows
        .filter((r) => r.day_of_week === activeDay)
        .sort((a, b) => a.start_time.localeCompare(b.start_time)),
    [branchRows, activeDay],
  );

  // Summary: working days, periods/day, hours/week.
  const summary = useMemo(() => {
    const workingDays = dayCounts.filter((c) => c > 0).length;
    let totalPeriods = 0;
    let totalMinutes = 0;
    for (const r of branchRows) {
      totalPeriods += 1;
      totalMinutes += durationHours(r.start_time, r.end_time) * 60;
    }
    const maxPeriods = Math.max(0, ...dayCounts);
    return {
      workingDays,
      periodsPerDay: maxPeriods,
      hoursPerWeek: totalMinutes / 60,
      totalPeriods,
    };
  }, [branchRows, dayCounts]);

  // Tomorrow's ISO date for the "Effective from" display.
  const tomorrowIso = useMemo(() => tomorrowIsoDate(new Date()), []);
  const tomorrowLong = useMemo(
    () => isoDateToLongLabel(tomorrowIso),
    [tomorrowIso],
  );

  // ── Row CRUD ─────────────────────────────────────────────────
  const onAddPeriod = useCallback(() => {
    if (!selectedBranchId) return;
    const newRow: WorkingRow = {
      branch_id: selectedBranchId,
      day_of_week: activeDay,
      start_time: '09:00:00',
      end_time: '13:00:00',
      effective_from: tomorrowIso,
      effective_to: null,
      _key: makeKey(),
    };
    setSchedule((prev) => [...prev, newRow]);
    setEditingKey(newRow._key);
    setEditStart('09:00');
    setEditEnd('13:00');
    setFormErr(null);
  }, [selectedBranchId, activeDay, tomorrowIso]);

  const onEditRow = useCallback((row: WorkingRow) => {
    setEditingKey(row._key);
    setEditStart(isoToTimeLabel(row.start_time));
    setEditEnd(isoToTimeLabel(row.end_time));
  }, []);

  const onSaveEdit = useCallback(() => {
    if (!editingKey) return;
    setSchedule((prev) =>
      prev.map((r) => {
        if (r._key !== editingKey) return r;
        return {
          ...r,
          start_time: `${editStart}:00`,
          end_time: `${editEnd}:00`,
        };
      }),
    );
    setEditingKey(null);
    setFormErr(null);
  }, [editingKey, editStart, editEnd]);

  const onCancelEdit = useCallback(() => {
    setEditingKey(null);
  }, []);

  const onSplitRow = useCallback((row: WorkingRow) => {
    // Insert a new row at the mid-time of the existing one. The
    // existing row is shortened to [start, mid) and the new row
    // becomes [mid, end).
    const startM =
      Number(row.start_time.slice(0, 2)) * 60 +
      Number(row.start_time.slice(3, 5));
    const endM =
      Number(row.end_time.slice(0, 2)) * 60 +
      Number(row.end_time.slice(3, 5));
    const midM = Math.floor((startM + endM) / 2);
    const midH = Math.floor(midM / 60);
    const midMi = midM % 60;
    const midPadded = `${String(midH).padStart(2, '0')}:${String(midMi).padStart(2, '0')}:00`;
    if (midPadded === row.start_time || midPadded === row.end_time) {
      // Period too short to split — fall through to edit mode instead.
      setEditingKey(row._key);
      setEditStart(isoToTimeLabel(row.start_time));
      setEditEnd(isoToTimeLabel(row.end_time));
      return;
    }
    const splitRow: WorkingRow = {
      branch_id: row.branch_id,
      day_of_week: row.day_of_week,
      start_time: midPadded,
      end_time: row.end_time,
      effective_from: row.effective_from,
      effective_to: row.effective_to,
      _key: makeKey(),
    };
    setSchedule((prev) => [
      ...prev.map((r) => {
        if (r._key !== row._key) return r;
        return { ...r, end_time: midPadded };
      }),
      splitRow,
    ]);
  }, []);

  const onDeleteRow = useCallback((row: WorkingRow) => {
    setSchedule((prev) => prev.filter((r) => r._key !== row._key));
    if (editingKey === row._key) setEditingKey(null);
  }, [editingKey]);

  // ── Save / Discard / Toast ──────────────────────────────────
  const buildRowsForApi = useCallback(
    (): DoctorScheduleRow[] =>
      schedule.map((r) => ({
        branch_id: r.branch_id,
        day_of_week: r.day_of_week,
        start_time: r.start_time,
        end_time: r.end_time,
        effective_from: r.effective_from,
        effective_to: r.effective_to,
      })),
    [schedule],
  );

  const showToast = useCallback((text: string): void => {
    setToast(text);
    window.setTimeout(() => setToast(null), 3000);
  }, []);

  const onDiscard = useCallback(() => {
    if (busy) return;
    setBusy(true);
    setFormErr(null);
    reload()
      .then(() => {
        setAffectedPreview(null);
        setAcknowledgedImpact(false);
        setSavedAt(null);
        setEditingKey(null);
      })
      .catch((err: unknown) => {
        setFormErr(describeApiError(err));
      })
      .finally(() => setBusy(false));
  }, [busy, reload]);

  const onSave = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setFormErr(null);
      setAffectedPreview(null);

      const apiRows = buildRowsForApi();
      if (apiRows.length === 0) {
        setFormErr({
          status: 400,
          code: 'empty_schedule',
          message: 'Add at least one period before saving.',
        });
        return;
      }
      for (const r of apiRows) {
        if (r.day_of_week < 0 || r.day_of_week > 6) {
          setFormErr({
            status: 400,
            code: 'invalid_schedule_row',
            message: 'day_of_week must be 0..6.',
          });
          return;
        }
        if (r.start_time >= r.end_time) {
          setFormErr({
            status: 400,
            code: 'invalid_schedule_row',
            message: 'end_time must be after start_time.',
          });
          return;
        }
        if (r.effective_from < tomorrowIso) {
          setFormErr({
            status: 400,
            code: 'invalid_schedule_row',
            message: 'effective_from cannot be in the past.',
          });
          return;
        }
      }
      setBusy(true);
      try {
        // Impact preview first — if non-zero, surface it and require
        // acknowledgement before commit.
        const impact = await previewMyDoctorSchedule(apiRows);
        if (impact.future_appointment_count > 0 && !acknowledgedImpact) {
          setAffectedPreview(impact.affected_appointments);
          setFormErr({
            status: 409,
            code: 'schedule_invalidates_future_appointments',
            message: `${impact.future_appointment_count} future Scheduled appointment${impact.future_appointment_count === 1 ? '' : 's'} would fall outside the new schedule. Tick "Continue anyway" to save anyway.`,
          });
          setBusy(false);
          return;
        }
        await saveMyDoctorSchedule(apiRows, acknowledgedImpact);
        await reload();
        setSavedAt(new Date().toISOString());
        setAcknowledgedImpact(false);
        setAffectedPreview(null);
        showToast('Schedule saved.');
      } catch (caught) {
        setFormErr(describeApiError(caught));
      } finally {
        setBusy(false);
      }
    },
    [
      buildRowsForApi,
      tomorrowIso,
      acknowledgedImpact,
      reload,
      showToast,
    ],
  );

  if (loading) {
    return (
      <DoctorFrame activeNav={activeNav}>
        <div className={styles['page']}>
          <p className={styles['sub']}>Loading schedule…</p>
        </div>
      </DoctorFrame>
    );
  }

  if (loadErr) {
    return (
      <DoctorFrame activeNav={activeNav}>
        <div className={styles['page']}>
          <div className={styles['error-banner']} role="alert">
            <strong>{loadErr.code}:</strong> {loadErr.message}
          </div>
        </div>
      </DoctorFrame>
    );
  }

  const hasMultipleBranches = branches.length > 1;
  const dayHeader = `${DAY_LABELS_LONG[activeDay] ?? 'Day'}, ${tomorrowLong}`;
  const dayPeriodCount = dayCounts[activeDay] ?? 0;
  const branchName =
    branches.find((b) => b.id === selectedBranchId)?.name ?? 'this branch';

  return (
    <DoctorFrame activeNav={activeNav}>
      <div className={styles['page']}>
        {toast && (
          <div className={styles['toast-stack']} role="status">
            <div className={styles['toast']}>
              <span className={styles['toast-icon']} aria-hidden="true">
                ✓
              </span>
              <span className={styles['toast-text']}>{toast}</span>
              <button
                type="button"
                className={styles['toast-x']}
                onClick={() => setToast(null)}
                aria-label="Dismiss"
              >
                ×
              </button>
            </div>
          </div>
        )}

        <header className={styles['page-header']}>
          <div className={styles['crumb']}>Doctor &rarr; Weekly schedule</div>
          <div className={styles['page-header__row']}>
            <div>
              <h1>Weekly schedule</h1>
              <p className={styles['sub']}>
                Set when {displayName} works at {branchName}.
              </p>
            </div>
          </div>
        </header>

        <div className={styles['layout']}>
          {/* ─── Left form-col ─────────────────────────────── */}
          <aside className={styles['form-col']}>
            <div className={styles['form-head']}>
              <h2 className={styles['form-h2']}>Schedule</h2>
              <p className={styles['sub']}>Set when you work at this branch.</p>
            </div>

            <div className={styles['form-group']}>
              <label className={styles['form-label']}>Branch</label>
              {hasMultipleBranches ? (
                <select
                  className={styles['form-control']}
                  value={selectedBranchId ?? ''}
                  onChange={(e) => setSelectedBranchId(e.target.value)}
                  disabled={busy}
                >
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              ) : (
                <div className={styles['form-control-static']}>
                  {branches[0]?.name ?? '—'}
                </div>
              )}
            </div>

            <div className={styles['form-group']}>
              <label className={styles['form-label']}>Effective from</label>
              <div className={styles['form-control-static']}>
                {tomorrowLong} (tomorrow)
              </div>
            </div>

            <div className={styles['summary-card']}>
              <h4 className={styles['summary-h']}>This branch — your week</h4>
              <div className={styles['summary-row']}>
                <span className={styles['k']}>Working days</span>
                <span className={styles['v']}>
                  {summary.workingDays === 0
                    ? '—'
                    : summary.workingDays === 7
                      ? 'Every day'
                      : Array.from({ length: 7 })
                          .map((_, i) => i)
                          .filter((d) => (dayCounts[d] ?? 0) > 0)
                          .map((d) => DAY_LABELS[d])
                          .join(' · ')}
                </span>
              </div>
              <div className={styles['summary-row']}>
                <span className={styles['k']}>Periods per day</span>
                <span className={styles['v']}>
                  {summary.periodsPerDay === 0 ? '—' : summary.periodsPerDay}
                </span>
              </div>
              <div className={styles['summary-row']}>
                <span className={styles['k']}>Hours / week</span>
                <span className={styles['v']}>
                  {summary.hoursPerWeek === 0
                    ? '—'
                    : formatHourLabel(summary.hoursPerWeek)}
                </span>
              </div>
              {savedAt && (
                <div className={styles['summary-row']}>
                  <span className={styles['k']}>Last saved</span>
                  <span className={styles['v']}>Just now</span>
                </div>
              )}
            </div>

            <form onSubmit={onSave} noValidate>
              <button
                type="submit"
                className={styles['btn-primary']}
                disabled={busy || summary.totalPeriods === 0}
              >
                {busy ? 'Saving…' : 'Save changes →'}
              </button>
            </form>
          </aside>

          {/* ─── Right edit-col ─────────────────────────────── */}
          <section className={styles['edit-col']}>
            <div className={styles['edit-head']}>
              <h2 className={styles['edit-h2']}>
                {dayHeader} — {dayPeriodCount}{' '}
                period{dayPeriodCount === 1 ? '' : 's'}
              </h2>
              <p className={styles['sub']}>
                Multiple periods per day are allowed (BR-007).
              </p>
            </div>

            <div
              className={styles['day-tabs']}
              role="tablist"
              aria-label="Day of week"
            >
              {DAY_LABELS.map((label, dow) => {
                const count = dayCounts[dow] ?? 0;
                const isActive = dow === activeDay;
                return (
                  <button
                    key={dow}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    className={
                      isActive
                        ? `${styles['day-tab']} ${styles['day-tab--active']}`
                        : styles['day-tab']
                    }
                    onClick={() => {
                      setActiveDay(dow);
                      setEditingKey(null);
                      setAffectedPreview(null);
                    }}
                    disabled={busy}
                  >
                    <span className={styles['day-tab__label']}>{label}</span>
                    <span className={styles['day-tab__n']}>
                      {count === 0
                        ? '0 · off'
                        : `${count} period${count === 1 ? '' : 's'}`}
                    </span>
                  </button>
                );
              })}
            </div>

            {dayRows.length === 0 && (
              <div className={styles['day-empty']}>
                No periods on {DAY_LABELS_LONG[activeDay]}. Add one below.
              </div>
            )}

            {dayRows.map((row, idx) => {
              const isEditing = editingKey === row._key;
              const dur = durationHours(row.start_time, row.end_time);
              return (
                <div
                  key={row._key}
                  className={
                    isEditing
                      ? `${styles['period-card']} ${styles['period-card--editing']}`
                      : styles['period-card']
                  }
                >
                  <div className={styles['num']}>{idx + 1}</div>
                  <div className={styles['info']}>
                    {isEditing ? (
                      <div className={styles['period-edit']}>
                        <label className={styles['period-edit__field']}>
                          <span className={styles['period-edit__label']}>
                            Start
                          </span>
                          <input
                            type="time"
                            className={styles['period-edit__input']}
                            value={editStart}
                            onChange={(e) => setEditStart(e.target.value)}
                            disabled={busy}
                            step={300}
                          />
                        </label>
                        <span className={styles['period-edit__dash']}>–</span>
                        <label className={styles['period-edit__field']}>
                          <span className={styles['period-edit__label']}>
                            End
                          </span>
                          <input
                            type="time"
                            className={styles['period-edit__input']}
                            value={editEnd}
                            onChange={(e) => setEditEnd(e.target.value)}
                            disabled={busy}
                            step={300}
                          />
                        </label>
                        <div className={styles['period-edit__btns']}>
                          <button
                            type="button"
                            className={styles['btn-ghost-sm']}
                            onClick={onCancelEdit}
                            disabled={busy}
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            className={styles['btn-primary-sm']}
                            onClick={onSaveEdit}
                            disabled={busy}
                          >
                            Save period
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className={styles['time']}>
                          {isoToTimeLabel(row.start_time)} –{' '}
                          {isoToTimeLabel(row.end_time)}
                        </div>
                        <div className={styles['meta']}>
                          {blockLabel(row.start_time)} ·{' '}
                          {formatHourLabel(dur)}
                        </div>
                      </>
                    )}
                  </div>
                  {!isEditing && (
                    <div className={styles['actions']}>
                      <button
                        type="button"
                        className={styles['btn-period']}
                        onClick={() => onEditRow(row)}
                        disabled={busy}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className={styles['btn-period']}
                        onClick={() => onSplitRow(row)}
                        disabled={busy}
                      >
                        Split
                      </button>
                      <button
                        type="button"
                        className={`${styles['btn-period']} ${styles['btn-period--del']}`}
                        onClick={() => onDeleteRow(row)}
                        disabled={busy}
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              );
            })}

            <button
              type="button"
              className={styles['add-period']}
              onClick={onAddPeriod}
              disabled={busy || !selectedBranchId}
            >
              + Add another period (e.g. evening block)
            </button>

            {affectedPreview && affectedPreview.length > 0 && (
              <div className={styles['impact']}>
                <div className={styles['impact-head']}>
                  <strong>Heads-up:</strong> {affectedPreview.length} future
                  Scheduled appointment
                  {affectedPreview.length === 1 ? '' : 's'} would fall outside
                  the new schedule.
                </div>
                <ul className={styles['impact-list']}>
                  {affectedPreview.slice(0, 8).map((a) => (
                    <li key={a.id} className={styles['impact-list__item']}>
                      <code>{a.patient_phone_masked}</code> · branch{' '}
                      {a.branch_id.slice(0, 8)} ·{' '}
                      {new Date(a.start_datetime)
                        .toISOString()
                        .slice(0, 16)
                        .replace('T', ' ')}{' '}
                      UTC · {a.status}
                    </li>
                  ))}
                  {affectedPreview.length > 8 && (
                    <li className={styles['impact-list__item']}>
                      + {affectedPreview.length - 8} more…
                    </li>
                  )}
                </ul>
                <label className={styles['impact-ack']}>
                  <input
                    type="checkbox"
                    checked={acknowledgedImpact}
                    onChange={(e) => setAcknowledgedImpact(e.target.checked)}
                  />
                  Continue anyway — save despite invalidated appointments.
                </label>
              </div>
            )}

            {formErr && (
              <div className={styles['error-banner']} role="alert">
                <strong>{formErr.code}:</strong> {formErr.message}
              </div>
            )}

            <div className={styles['row-foot']}>
              <button
                type="button"
                className={styles['btn-ghost']}
                onClick={onDiscard}
                disabled={busy}
              >
                Discard changes
              </button>
              <span className={styles['foot-hint']}>
                Saving replaces your schedule in full. Each save closes all
                existing periods and re-inserts the new set.
              </span>
            </div>
          </section>
        </div>
      </div>
    </DoctorFrame>
  );
}
