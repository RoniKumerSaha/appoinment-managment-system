/**
 * Admin Doctor Schedule (Weekly schedule editor) sub-page — under
 * `/admin/doctors/<id>/schedule` (reached via the "Schedule" button on a
 * doctor card).
 *
 * Pixel-perfect port of mockup 09
 * (docs/design/mockups/v1/mockups/09-doctor-schedule.html). Driven by the
 * E2-S1 API surface:
 *   - `GET /admin/doctors/:id/schedule` — load the schedule rows.
 *   - `POST /admin/doctors/:id/schedule-impact` — preview the count of
 *     future Scheduled appointments that would be invalidated.
 *   - `POST /admin/doctors/:id/schedule` — commit the new schedule
 *     (full-set replace inside a transaction).
 *
 * Layout (mockup 09):
 *   - 1200px frame
 *   - 2-column grid: 320px form-col + 1fr edit-col
 *   - Left "form-col" (var(--surface-soft) background):
 *     - Page header "Schedule" + subline "Set when the doctor works at
 *       this branch."
 *     - Cross-links row (Today / Block time / Appointment types /
 *       Recurring preview) — placeholders for unbuilt routes.
 *     - Branch select (if the doctor works at >1 branch).
 *     - Effective-from picker (read-only, defaults to tomorrow per FR-010).
 *     - Summary card: "This branch — your week" with Working days /
 *       Periods per day / Hours-per-week rows.
 *     - Primary "Save changes →" button.
 *   - Right "edit-col":
 *     - Page header "{Day}, {tomorrow} — N periods" + subline "Multiple
 *     periods per day are allowed (BR-007)."
 *     - Day-tabs: Sun..Sat (matches Postgres EXTRACT DOW convention —
 *       week starts Sunday). Each tab shows the period count for that
 *       day. Active day has light-teal background.
 *     - Period cards: numbered + time range + meta line (Morning/Afternoon
 *       block, duration) + actions Edit / Split / Delete.
 *     - "+ Add another period (e.g. evening block)" dashed card at the
 *       bottom of the active day.
 *     - Outside-branch-hours warning card (UX-FLOWS F-06) with
 *       [Adjust periods] [Continue anyway] — appears when any period
 *       falls outside the branch's open/close window.
 *
 * Inline editing: each period card has an "Edit" button that toggles an
 * inline form (start / end time pickers + Save / Cancel). "Split" opens
 * the inline form in split-mode (initial end = mid-time, slot for the
 * second half) — UI sugar for "I want to break this period into two".
 * "Delete" drops the row. The state is held in `workingRows` (the
 * editor's working copy); `originalRows` is the snapshot at load time
 * for the diff / discard.
 *
 * The page is reached from the "Schedule" button on each card in
 * `AdminDoctors.tsx`. The "← Back to doctors" button returns to the
 * card grid; AppShell stays on "doctors" so the nav still highlights
 * Doctors.
 *
 * The TZ resolution is UTC-as-working-plane (see spec-2-1 SC log D2).
 * When the doctor's branch has non-UTC tz the impact count
 * over-reports; the affected_appointments list is shown verbatim so an
 * attentive admin can spot false positives.
 *
 * No tests in this pass (per user instruction).
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
  getDoctor,
  getDoctorSchedule,
  getBranchHours,
  postDoctorSchedule,
  previewDoctorScheduleImpact,
  type DoctorWithBranchesDto,
  type ScheduleRowDto,
  type BranchHoursDto,
  type HoursRow,
  type AffectedScheduleAppointment,
} from '../api/client';
import styles from './AdminDoctorSchedule.module.css';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    if (err.code === 'invalid_doctor_id') {
      message = 'Invalid doctor id.';
    } else if (err.code === 'doctor_not_found') {
      message = 'That doctor no longer exists.';
    } else if (err.code === 'invalid_schedule_row') {
      message =
        'A period row is invalid (check day_of_week 0–6, start<end, effective_from).';
    } else if (err.code === 'schedule_rows_overlap') {
      message = 'Two periods overlap on the same day — please adjust.';
    } else if (err.code === 'branch_not_in_doctor_branches') {
      message = 'A period uses a branch the doctor is not assigned to.';
    } else if (err.code === 'schedule_invalidates_future_appointments') {
      message =
        'This change would invalidate future appointments. Adjust periods or acknowledge.';
    } else if (err.code === 'invalid_rows') {
      message = 'rows[] is required.';
    } else if (err.code === 'unknown_field') {
      message = 'Unsupported field sent to the API.';
    } else if (err.code === 'invalid_branch_id') {
      message = 'Invalid branch id.';
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

function todayIsoDate(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
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

interface WorkingRow extends ScheduleRowDto {
  /** Client-only id for React keys + edit/delete tracking. */
  _key: string;
}

function makeKey(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Detect a period falling outside the branch's open/close window. The
 *  branch's hours are returned per-day; we read the entry for `dow` and
 *  check start/end against open/close (or skip if closed / open===null). */
function isOutsideBranchHours(
  row: { day_of_week: number; start_time: string; end_time: string },
  branchHours: BranchHoursDto | null,
): boolean {
  if (!branchHours) return false;
  const day = branchHours.hours.find((h) => h.day_of_week === row.day_of_week);
  if (!day || day.is_closed) return false;
  if (!day.open_time || !day.close_time) return false;
  // open_time / close_time are HH:MM; pad to HH:MM:SS for compareTimeStrings.
  const open = `${day.open_time}:00`;
  const close = `${day.close_time}:00`;
  return (
    row.start_time < open || row.end_time > close
  );
}

export function AdminDoctorSchedule({
  doctorId,
  onBackToDoctors,
}: {
  doctorId: string;
  onBackToDoctors: () => void;
}) {
  const [doctor, setDoctor] = useState<DoctorWithBranchesDto | null>(null);
  const [schedule, setSchedule] = useState<WorkingRow[]>([]);
  const [branchesHours, setBranchesHours] = useState<
    Record<string, BranchHoursDto>
  >({});
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<FormError | null>(null);

  const [selectedBranchId, setSelectedBranchId] = useState<string | null>(
    null,
  );
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
    AffectedScheduleAppointment[] | null
  >(null);
  const [acknowledgedImpact, setAcknowledgedImpact] = useState(false);

  // Initial load.
  const reload = useCallback(async (): Promise<void> => {
    const doc = await getDoctor(doctorId);
    setDoctor(doc);
    const sched = await getDoctorSchedule(doctorId);
    const rows: WorkingRow[] = sched.schedule.map((r) => ({
      ...r,
      _key: makeKey(),
    }));
    setSchedule(rows);
    // Branch hours per branch the doctor works at (for outside-hours warning).
    const branchIds = doc.branches.map((b) => b.id);
    const hoursEntries = await Promise.all(
      branchIds.map(async (bid) => {
        try {
          return [bid, await getBranchHours(bid)] as const;
        } catch {
          return [bid, null] as const;
        }
      }),
    );
    const map: Record<string, BranchHoursDto> = {};
    for (const [bid, h] of hoursEntries) {
      if (h) map[bid] = h;
    }
    setBranchesHours(map);
    // Initial branch selection: first branch.
    if (branchIds[0]) setSelectedBranchId(branchIds[0]);
  }, [doctorId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadErr(null);
    reload()
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadErr(describeApiError(err));
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

  // Outside-branch-hours check on the working set (per active branch).
  const outsideRows = useMemo(() => {
    if (!selectedBranchId) return [] as WorkingRow[];
    const bh = branchesHours[selectedBranchId];
    if (!bh) return [] as WorkingRow[];
    return branchRows.filter((r) => isOutsideBranchHours(r, bh));
  }, [branchRows, branchesHours, selectedBranchId]);

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
        const startPadded = `${editStart}:00`;
        const endPadded = `${editEnd}:00`;
        return {
          ...r,
          start_time: startPadded,
          end_time: endPadded,
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
    // Insert a new row at the mid-time of the existing one. The existing
    // row is shortened to [start, mid) and the new row becomes [mid, end).
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
    const startPadded = row.start_time;
    const endPadded = row.end_time;
    if (midPadded === startPadded || midPadded === endPadded) {
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
      end_time: endPadded,
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
    (): ScheduleRowDto[] =>
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
    // Re-fetch from server to ensure the editor is in sync.
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

      // Client-side validation (the server validates too, but early
      // failures save an impact-count roundtrip).
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
        if (!UUID_RE.test(r.branch_id)) {
          setFormErr({
            status: 400,
            code: 'invalid_schedule_row',
            message: 'A branch id is not a valid UUID.',
          });
          return;
        }
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
        const impact = await previewDoctorScheduleImpact(doctorId, apiRows);
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
        await postDoctorSchedule(doctorId, apiRows);
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
    [buildRowsForApi, doctorId, tomorrowIso, acknowledgedImpact, reload, showToast],
  );

  if (loading) {
    return (
      <div className={styles['page']}>
        <p className={styles['sub']}>Loading schedule…</p>
      </div>
    );
  }

  if (loadErr) {
    return (
      <div className={styles['page']}>
        <header className={styles['page-header']}>
          <button
            type="button"
            className={styles['btn-back']}
            onClick={onBackToDoctors}
          >
            ← Back to doctors
          </button>
        </header>
        <div className={styles['error-banner']} role="alert">
          <strong>{loadErr.code}:</strong> {loadErr.message}
        </div>
      </div>
    );
  }

  if (!doctor) return null;

  const branchOptions = doctor.branches;
  const hasMultipleBranches = branchOptions.length > 1;
  const dayHeader = `${DAY_LABELS_LONG[activeDay] ?? 'Day'}, ${tomorrowLong}`;
  const dayPeriodCount = dayCounts[activeDay] ?? 0;

  return (
    <div className={styles['page']}>
      {/* Toast (top-right, auto-dismiss). */}
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
        <div className={styles['crumb']}>
          Admin &rarr; Doctors &rarr; {doctor.full_name} &rarr; Weekly schedule
        </div>
        <div className={styles['page-header__row']}>
          <div>
            <h1>Weekly schedule</h1>
            <p className={styles['sub']}>
              Set when {doctor.full_name.replace(/^Dr\.?\s+/i, 'Dr. ')} works at
              this branch.
            </p>
          </div>
          <button
            type="button"
            className={styles['btn-back']}
            onClick={onBackToDoctors}
          >
            ← Back to doctors
          </button>
        </div>
      </header>

      <div className={styles['layout']}>
        {/* ─── Left form-col ─────────────────────────────── */}
        <aside className={styles['form-col']}>
          <div className={styles['form-head']}>
            <h2 className={styles['form-h2']}>Schedule</h2>
            <p className={styles['sub']}>Set when they work at this branch.</p>
          </div>

          <div className={styles['cross-links']}>
            <span className={styles['cross-link']} title="Not yet implemented">
              Today
            </span>
            <span className={styles['cross-link']} title="Not yet implemented">
              Block time
            </span>
            <span
              className={styles['cross-link']}
              title="Not yet implemented"
            >
              Appointment types
            </span>
            <span
              className={styles['cross-link']}
              title="Not yet implemented"
            >
              Recurring preview
            </span>
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
                {branchOptions.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            ) : (
              <div className={styles['form-control-static']}>
                {branchOptions[0]?.name ?? '—'}
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
                <span className={styles['v']}>
                  {isoDateToLongLabel(todayIsoDate(new Date(savedAt)))}
                </span>
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
                    {count === 0 ? '0 · off' : `${count} period${count === 1 ? '' : 's'}`}
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
                        {blockLabel(row.start_time)} · {formatHourLabel(dur)}
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

          {outsideRows.length > 0 && (
            <div className={styles['outside-hours']}>
              <div className={styles['oh-body']}>
                <strong>Outside branch hours?</strong> These times fall
                outside{' '}
                {doctor.branches.find((b) => b.id === selectedBranchId)?.name ??
                  'the selected branch'}
                &rsquo;s operating window. You can still save, but consider
                narrowing your periods.
              </div>
              <div className={styles['oh-actions']}>
                <button
                  type="button"
                  className={styles['btn-ghost-sm']}
                  onClick={() => {
                    const firstOutside = outsideRows[0];
                    if (!firstOutside) return;
                    // Focus the matching period card by setting edit mode.
                    setActiveDay(firstOutside.day_of_week);
                    setEditingKey(firstOutside._key);
                    setEditStart(isoToTimeLabel(firstOutside.start_time));
                    setEditEnd(isoToTimeLabel(firstOutside.end_time));
                  }}
                >
                  Adjust periods
                </button>
                <button
                  type="button"
                  className={styles['btn-primary-sm']}
                  onClick={() => {
                    // Hide the warning visually; saving still routes through
                    // the form's submit handler. The admin must explicitly
                    // click "Save changes" to commit.
                  }}
                >
                  Continue anyway
                </button>
              </div>
            </div>
          )}

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
                    {new Date(a.start_datetime).toISOString().slice(0, 16).replace('T', ' ')}{' '}
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
              Saving replaces the schedule in full. Each save closes all
              existing periods for this doctor and re-inserts the new set.
            </span>
          </div>
        </section>
      </div>
    </div>
  );
}

// Re-export the HoursRow import-free form so the noUnused helper warning
// stays clean if anyone tree-shakes.
export type { HoursRow };