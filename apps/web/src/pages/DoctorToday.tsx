/**
 * DoctorToday — the doctor's own day list (mock 12 / doctor.md Act 3).
 *
 * The doctor's counterpart to the receptionist's "Today" board
 * (`ReceptionistToday`, mock 13). The receptionist sees every
 * appointment at their branch; the doctor sees only the
 * appointments booked against THEM.
 *
 * This screen did not exist. The doctor's only day-to-day surface
 * was the "affected" queue (`DoctorAffected`, mock 06), which lists
 * ONLY the appointments that fell outside their branch's operating
 * hours. That queue is empty in normal operation, so the status
 * actions — mark Completed / No-show, cancel, and the audit drawer
 * — were reachable only from a row that essentially never appears.
 *
 * This screen makes them reachable for ordinary appointments:
 *
 *   - "Mark status"  → `DoctorMarkStatus`  (E5-S1)
 *   - "Cancel"       → `DoctorCancel`       (E5-S2)
 *
 * The two modals are shared verbatim with the affected queue — the
 * same components, the same props shape — so the two surfaces
 * cannot drift apart.
 *
 * The audit trail (E7-S2, mock 30) is deliberately NOT offered here.
 * It stays on the affected queue, where "View audit log" reads as
 * the record of a RESOLUTION. On a routine day list an audit button
 * on every row is noise, and the doctor who wants the trail of an
 * appointment they are actively working through can still reach it
 * from the affected view.
 *
 * Privacy (E7-S3): the response carries `patient_phone` but NOT
 * `patient_name`. The patient cell renders the masked phone only.
 *
 * Times render in each row's OWN branch timezone, because a doctor
 * may work at more than one branch and the two may sit in different
 * timezones. The response carries `branch_tz` per row for exactly
 * this reason.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ApiError,
  getDoctorToday,
  type DoctorAppointmentStatus,
  type DoctorTodayAppointment,
  type DoctorTodayResponse,
} from '../api/client';
import { DoctorCancel } from './DoctorCancel';
import { DoctorFrame } from './DoctorFrame';
import { DoctorMarkStatus } from './DoctorMarkStatus';
import {
  formatTimeInTz,
  maskPhone,
  patientLabelFromPhone,
} from './doctor-utils';
import './DoctorToday.css';

interface DoctorTodayProps {
  /** Rendered inside `DoctorFrame` by the parent — see DoctorApp. */
  activeNav?: string;
}

const STATUS_FILTERS: Array<{
  value: DoctorAppointmentStatus | 'all';
  label: string;
}> = [
  { value: 'all', label: 'All statuses' },
  { value: 'Scheduled', label: 'Scheduled' },
  { value: 'Completed', label: 'Completed' },
  { value: 'Cancelled', label: 'Cancelled' },
  { value: 'No-show', label: 'No-show' },
];

/** The hour-of-day buckets the list is grouped into (branch-local). */
const HOUR_LABELS: Array<{ hour: number; label: string }> = [
  { hour: 8, label: 'Morning' },
  { hour: 9, label: 'Mid-morning' },
  { hour: 10, label: 'Late morning' },
  { hour: 11, label: 'Approaching noon' },
  { hour: 12, label: 'Noon' },
  { hour: 13, label: 'Early afternoon' },
  { hour: 14, label: 'Afternoon' },
  { hour: 15, label: 'Late afternoon' },
  { hour: 16, label: 'Evening' },
  { hour: 17, label: 'Late evening' },
];

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return 'Session expired. Please sign in again.';
    if (err.status === 403) return 'You do not have access to this view.';
    if (err.status === 400 && err.code === 'invalid_status') {
      return 'That status filter is not recognised.';
    }
    if (err.status === 400 && err.code === 'invalid_date') {
      return 'That date is not in the right format (YYYY-MM-DD).';
    }
    return `Could not load your day (${err.code}).`;
  }
  if (err instanceof TypeError) {
    return 'Connection failed. Is the API running on :3001?';
  }
  return 'Could not load your day.';
}

function describeCancelError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return 'Session expired. Please sign in again.';
    if (err.status === 422 && err.code === 'already_in_terminal_state') {
      return 'This appointment is no longer Scheduled.';
    }
    if (err.status === 403) {
      return 'You do not have access to this appointment.';
    }
    if (err.status === 404) {
      return 'This appointment no longer exists. Refreshing…';
    }
    if (err.status === 400) {
      if (err.code === 'reason_required') return 'A reason is required.';
      if (err.code === 'reason_too_long') {
        return 'Reason is too long (500 char max).';
      }
    }
    return `Could not cancel (${err.code}).`;
  }
  if (err instanceof TypeError) {
    return 'Connection failed. Is the API running on :3001?';
  }
  return 'Could not cancel the appointment.';
}

function describeMarkError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return 'Session expired. Please sign in again.';
    if (err.status === 422) {
      if (err.code === 'already_in_terminal_state') {
        return 'This appointment is no longer Scheduled.';
      }
      if (err.code === 'appointment_in_future') {
        return 'You can only mark past appointments.';
      }
    }
    if (err.status === 403) {
      return 'You do not have access to this appointment.';
    }
    if (err.status === 404) return 'That appointment no longer exists.';
    if (err.status === 400 && err.code === 'invalid_status') {
      return 'Pick Completed or No-show.';
    }
    return `Could not mark status (${err.code}).`;
  }
  if (err instanceof TypeError) {
    return 'Connection failed. Is the API running on :3001?';
  }
  return 'Could not update the status.';
}

function statusPillClass(s: DoctorAppointmentStatus): string {
  switch (s) {
    case 'Scheduled':
      return 'doc-today__pill doc-today__pill--scheduled';
    case 'Completed':
      return 'doc-today__pill doc-today__pill--completed';
    case 'Cancelled':
      return 'doc-today__pill doc-today__pill--cancelled';
    case 'No-show':
      return 'doc-today__pill doc-today__pill--no-show';
  }
}

function statusPillLabel(s: DoctorAppointmentStatus): string {
  switch (s) {
    case 'Scheduled':
      return '● Scheduled';
    case 'Completed':
      return '✓ Done';
    case 'Cancelled':
      return '✕ Cancelled';
    case 'No-show':
      return '⚠ No-show';
  }
}

function rowModifierClass(
  appt: DoctorTodayAppointment,
  now: Date,
): string {
  if (appt.status === 'Cancelled' || appt.status === 'No-show') {
    return 'doc-today__row doc-today__row--dim';
  }
  if (appt.status === 'Completed') {
    return 'doc-today__row doc-today__row--done';
  }
  const start = new Date(appt.start_datetime);
  const end = new Date(appt.end_datetime);
  if (now >= start && now < end) {
    return 'doc-today__row doc-today__row--now';
  }
  return 'doc-today__row';
}

/** The appointment's duration, derived from the slot the API returned. */
function durationLabel(startIso: string, endIso: string): string | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  const minutes = Math.round((end - start) / 60000);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** The hour-of-day in the row's OWN branch timezone. */
function hourOf(appt: DoctorTodayAppointment): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: appt.branch_tz,
    hour: 'numeric',
    hour12: false,
  }).formatToParts(new Date(appt.start_datetime));
  const h = parts.find((p) => p.type === 'hour')?.value ?? '0';
  return Number(h);
}

/** `YYYY-MM-DD` → "October 29". */
function formatDateHeader(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map((s) => Number(s));
  if (!y || !m || !d) return isoDate;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export function DoctorToday({ activeNav }: DoctorTodayProps) {
  const [data, setData] = useState<DoctorTodayResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [search, setSearch] = useState<string>('');
  const [date, setDate] = useState<string>('');
  const [branchFilter, setBranchFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<
    DoctorAppointmentStatus | 'all'
  >('all');
  const [now, setNow] = useState<Date>(new Date());

  // The open modal's target row.
  const [markId, setMarkId] = useState<string | null>(null);
  const [cancelId, setCancelId] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setErr(null);
    try {
      // The first load omits the filters entirely so the API applies
      // its own defaults (today, branch-local).
      const res = await getDoctorToday({});
      setData(res);
      setDate(res.date);
      setLoading(false);
    } catch (e: unknown) {
      setErr(describeError(e));
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Tick the clock once a minute so the "now" highlight stays current.
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  // Re-fetch when the filters change. The search box filters
  // client-side (the API returns the phone number, which is the
  // only identifier the doctor sees).
  useEffect(() => {
    if (data === null) return;
    const t = window.setTimeout(() => {
      const filters: {
        status?: DoctorAppointmentStatus;
        branch_id?: string;
        date?: string;
      } = {};
      if (statusFilter !== 'all') filters.status = statusFilter;
      if (branchFilter !== 'all') filters.branch_id = branchFilter;
      if (date && date !== data.date) filters.date = date;
      setLoading(true);
      getDoctorToday(filters)
        .then((res) => {
          setData(res);
          setErr(null);
          setLoading(false);
        })
        .catch((e: unknown) => {
          setErr(describeError(e));
          setLoading(false);
        });
    }, 250);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, branchFilter, statusFilter]);

  const filtered = useMemo(() => {
    if (data === null) return [];
    const term = search.trim().toLowerCase();
    if (term.length === 0) return data.appointments;
    return data.appointments.filter((a) =>
      a.patient_phone.toLowerCase().includes(term),
    );
  }, [data, search]);

  // Group by hour-of-day-in-branch-tz.
  const grouped = useMemo(() => {
    const buckets = new Map<number, DoctorTodayAppointment[]>();
    for (const a of filtered) {
      const h = hourOf(a);
      const bucket = buckets.get(h);
      if (bucket) {
        bucket.push(a);
      } else {
        buckets.set(h, [a]);
      }
    }
    return Array.from(buckets.entries())
      .sort(([a], [b]) => a - b)
      .map(([h, items]) => ({
        hour: h,
        label: `${String(h).padStart(2, '0')}:00 — ${
          HOUR_LABELS.find((x) => x.hour === h)?.label ?? ''
        }`,
        items,
      }));
  }, [filtered]);

  const rowById = useCallback(
    (id: string): DoctorTodayAppointment | null => {
      if (data === null) return null;
      return data.appointments.find((a) => a.id === id) ?? null;
    },
    [data],
  );

  const onMarked = useCallback(
    async (status: 'Completed' | 'No-show'): Promise<void> => {
      setMarkId(null);
      setToast(`Marked as ${status}.`);
      await refresh();
    },
    [refresh],
  );

  const onCancelled = useCallback(
    async (reason: string): Promise<void> => {
      setCancelId(null);
      setToast(`Appointment cancelled · ${reason}`);
      await refresh();
    },
    [refresh],
  );

  const onStale = useCallback((): void => {
    setMarkId(null);
    setCancelId(null);
    setToast('This appointment is no longer in your list. Refreshing…');
    void refresh();
  }, [refresh]);

  // Mark-status is only legal for an appointment whose start time has
  // already passed (BR-040 / FR-037). The API enforces it; the UI
  // hides the button so the doctor is not offered an action that
  // would be rejected.
  const isPastRow = useCallback((a: DoctorTodayAppointment): boolean => {
    return new Date(a.start_datetime).getTime() <= Date.now();
  }, []);

  const totalCount = data?.appointments.length ?? 0;
  const filteredCount = filtered.length;

  return (
    <DoctorFrame activeNav={activeNav}>
      <div className="doc-today__page" data-testid="doc-today">
        <div className="doc-today__header">
          <div className="doc-today__header-left">
            <h1 className="doc-today__title">
              {data ? `Today, ${formatDateHeader(data.date)}` : 'Today'}
            </h1>
            <p className="doc-today__sub">
              {data
                ? `Your appointments across ${data.branches.length} branch${
                    data.branches.length === 1 ? '' : 'es'
                  } · ${totalCount} appointment${totalCount === 1 ? '' : 's'}`
                : 'Loading…'}
            </p>
          </div>
        </div>

        <div className="doc-today__toolbar">
          <input
            className="doc-today__search"
            placeholder="Search patient phone…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search patient phone"
          />
          <input
            type="date"
            className="doc-today__date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            aria-label="Date"
          />
          {data !== null && data.branches.length > 1 && (
            <select
              className="doc-today__select"
              value={branchFilter}
              onChange={(e) => setBranchFilter(e.target.value)}
              aria-label="Branch"
            >
              <option value="all">All my branches</option>
              {data.branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          )}
          <select
            className="doc-today__select"
            value={statusFilter}
            onChange={(e) =>
              setStatusFilter(e.target.value as DoctorAppointmentStatus | 'all')
            }
            aria-label="Status"
          >
            {STATUS_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </div>

        {err && (
          <div className="doc-today__error" data-testid="doc-today-error" role="alert">
            {err}
          </div>
        )}
        {toast && (
          <div className="doc-today__toast" data-testid="doc-today-toast" role="status">
            {toast}
          </div>
        )}

        {loading && data === null && (
          <div className="doc-today__loading">Loading your day…</div>
        )}

        {!loading && data !== null && filteredCount === 0 && (
          <div className="doc-today__empty" data-testid="doc-today-empty">
            {search.trim().length > 0
              ? `No appointments match “${search.trim()}” on ${formatDateHeader(data.date)}.`
              : `No appointments on ${formatDateHeader(data.date)}.`}
          </div>
        )}

        {data !== null &&
          grouped.map((g) => (
            <section className="doc-today__hour" key={g.hour}>
              <div className="doc-today__hour-label">
                <span>{g.label}</span>
                <span className="doc-today__hour-count">
                  {g.items.length} appt{g.items.length === 1 ? '' : 's'}
                </span>
                <span className="doc-today__hour-line" />
              </div>
              {g.items.map((a) => (
                <div
                  key={a.id}
                  className={rowModifierClass(a, now)}
                  data-testid={`doc-today-row-${a.id}`}
                >
                  <div className="doc-today__time">
                    {formatTimeInTz(a.start_datetime, a.branch_tz)}
                    <span className="doc-today__time-end">
                      {' '}
                      → {formatTimeInTz(a.end_datetime, a.branch_tz)}
                    </span>
                  </div>
                  <div className="doc-today__patient">
                    <div className="doc-today__patient-name">
                      {patientLabelFromPhone(a.patient_phone)}
                    </div>
                    <div className="doc-today__patient-phone">
                      {maskPhone(a.patient_phone)}
                    </div>
                  </div>
                  <div className="doc-today__branch">{a.branch_name}</div>
                  <div className="doc-today__type">
                    {a.appointment_type_name}
                    {durationLabel(a.start_datetime, a.end_datetime) !== null && (
                      <>
                        {' · '}
                        <span className="doc-today__type-dur">
                          {durationLabel(a.start_datetime, a.end_datetime)}
                        </span>
                      </>
                    )}
                  </div>
                  <div>
                    <span className={statusPillClass(a.status)}>
                      {statusPillLabel(a.status)}
                    </span>
                  </div>
                  <div className="doc-today__qa">
                    {a.status === 'Scheduled' && (
                      <>
                        <button
                          type="button"
                          className="doc-today__qa-btn doc-today__qa-btn--primary"
                          onClick={() => setCancelId(a.id)}
                        >
                          Cancel
                        </button>
                        {isPastRow(a) && (
                          <button
                            type="button"
                            className="doc-today__qa-btn"
                            data-testid={`doc-today-row-${a.id}-mark-btn`}
                            onClick={() => setMarkId(a.id)}
                          >
                            Mark status
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              ))}
            </section>
          ))}
      </div>

      {markId !== null && rowById(markId) !== null && (() => {
        const target = rowById(markId);
        if (target === null) return null;
        return (
          <DoctorMarkStatus
            appointment={{
              id: target.id,
              branchTz: target.branch_tz,
              start_datetime: target.start_datetime,
              end_datetime: target.end_datetime,
              patientLabel: patientLabelFromPhone(target.patient_phone),
              maskedPhone: maskPhone(target.patient_phone),
              branchName: target.branch_name,
            }}
            onCancel={() => setMarkId(null)}
            onMarked={onMarked}
            onStale={onStale}
            describeError={describeMarkError}
          />
        );
      })()}

      {cancelId !== null && rowById(cancelId) !== null && (() => {
        const target = rowById(cancelId);
        if (target === null) return null;
        return (
          <DoctorCancel
            appointment={{
              id: target.id,
              branchTz: target.branch_tz,
              start_datetime: target.start_datetime,
              end_datetime: target.end_datetime,
              patientLabel: patientLabelFromPhone(target.patient_phone),
              maskedPhone: maskPhone(target.patient_phone),
              branchName: target.branch_name,
            }}
            onCancel={() => setCancelId(null)}
            onCancelled={onCancelled}
            onStale={onStale}
            describeError={describeCancelError}
          />
        );
      })()}
    </DoctorFrame>
  );
}

/** Re-exported so the parent can label the nav without importing the
 *  type from the API client. */
export type { DoctorTodayAppointment };
