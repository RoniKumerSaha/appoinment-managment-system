/**
 * ReceptionistToday — E5-S4 UI (mock 13).
 *
 * Today's appointment list for the receptionist's branch, grouped by
 * hour. Toolbar with search, date, doctor, and status filters. The
 * toolbar's status / doctor / date filters wire directly to the
 * backend's optional query params on `GET /reception/branch/today`.
 *
 * Privacy (E7-S3): the response carries `patient_phone` but NOT
 * `patient_name`. The "patient cell" therefore renders only the
 * masked phone; we don't display a name (E7-S3 — receptionist
 * identifies the patient on arrival by phone).
 *
 * The "+ Book walk-in" button (mock 13) opens the receptionist
 * walk-in flow (mock 14, `ReceptionistCreate`), which POSTs to
 * `POST /bookings` with the receptionist as the actor of record.
 * The "Doctor availability" link opens the read-only availability
 * browser (mock 16, `ReceptionistAvailability`).
 *
 * The per-row "Check in" CTA is still a placeholder — the check-in
 * state machine has no back-end surface yet.
 *
 * The "Cancel appointment" link in the header routes to the
 * `ReceptionistCancel` page (mock 15), which uses the same today
 * data as the picker.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ApiError,
  getReceptionistToday,
  type ReceptionistAppointmentStatus,
  type ReceptionistTodayAppointment,
  type ReceptionistTodayResponse,
} from '../api/client';
import './ReceptionistToday.css';
import { ReceptionistFrame } from './ReceptionistFrame';
import { ReceptionistAuditDrawer } from './ReceptionistAuditDrawer';
import { formatTimeLocal, initialsOf, lastNameOf, maskPhone } from './recep-utils';
import { withDoctorTitle } from './doctor-name';

interface ReceptionistTodayProps {
  onOpenCancel: (appointmentId: string) => void;
  /** Walk-in booking (mock 14). */
  onOpenCreate: () => void;
  /** Read-only availability browser (mock 16). */
  onOpenAvailability: () => void;
}

const STATUS_FILTERS: Array<{
  value: ReceptionistAppointmentStatus | 'all';
  label: string;
}> = [
  { value: 'all', label: 'All statuses' },
  { value: 'Scheduled', label: 'Scheduled' },
  { value: 'Cancelled', label: 'Cancelled' },
  { value: 'Completed', label: 'Completed' },
  { value: 'No-show', label: 'No-show' },
];

/**
 * The appointment length, derived from the slot the API returned.
 *
 * This slot used to render the literal text "· view" — a leftover
 * placeholder from the mockup that made the type column read like
 * "General Consultation · view" and wrapped awkwardly onto a second
 * line. The real duration is computable from the start/end datetimes
 * the response already carries.
 */
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

const HOUR_LABELS: Array<{ hour: number; label: string }> = [  { hour: 8, label: 'Morning' },
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
    if (err.status === 403) return 'You do not have access to this branch.';
    if (err.status === 400 && err.code === 'invalid_status') {
      return 'That status filter is not recognised.';
    }
    if (err.status === 400 && err.code === 'invalid_date') {
      return 'That date is not in the right format (YYYY-MM-DD).';
    }
    if (err.status === 400 && err.code === 'invalid_doctor_id') {
      return 'That doctor id is malformed.';
    }
    return `Could not load the dashboard (${err.code}).`;
  }
  if (err instanceof TypeError) {
    return 'Connection failed. Is the API running on :3001?';
  }
  return 'Could not load the dashboard.';
}

function statusPillClass(s: ReceptionistAppointmentStatus): string {
  switch (s) {
    case 'Scheduled':
      return 'recep-today__pill recep-today__pill--scheduled';
    case 'Completed':
      return 'recep-today__pill recep-today__pill--completed';
    case 'Cancelled':
      return 'recep-today__pill recep-today__pill--cancelled';
    case 'No-show':
      return 'recep-today__pill recep-today__pill--no-show';
  }
}

function statusPillLabel(s: ReceptionistAppointmentStatus): string {
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
  appt: ReceptionistTodayAppointment,
  now: Date,
  branchTz: string,
): string {
  if (appt.status === 'Cancelled' || appt.status === 'No-show') {
    return 'recep-today__row recep-today__row--dim';
  }
  if (appt.status === 'Completed') {
    return 'recep-today__row recep-today__row--done';
  }
  // "now" highlight: the row containing the current time-in-branch-tz
  // gets the `now` class.
  const start = new Date(appt.start_datetime);
  const end = new Date(appt.end_datetime);
  if (now >= start && now < end) {
    return 'recep-today__row recep-today__row--now';
  }
  void branchTz;
  return 'recep-today__row';
}

function hourOf(appt: ReceptionistTodayAppointment, branchTz: string): number {
  // Extract the hour-of-day in branch.tz.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: branchTz,
    hour: 'numeric',
    hour12: false,
  }).formatToParts(new Date(appt.start_datetime));
  const h = parts.find((p) => p.type === 'hour')?.value ?? '0';
  return Number(h);
}

function formatDateHeader(isoDate: string): string {
  // isoDate is YYYY-MM-DD in branch.tz. Render the long form.
  const [y, m, d] = isoDate.split('-').map((s) => Number(s));
  if (!y || !m || !d) return isoDate;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export function ReceptionistToday({
  onOpenCancel,
  onOpenCreate,
  onOpenAvailability,
}: ReceptionistTodayProps) {
  const [data, setData] = useState<ReceptionistTodayResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);
  const [search, setSearch] = useState<string>('');
  const [date, setDate] = useState<string>('');
  const [doctorFilter, setDoctorFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<
    ReceptionistAppointmentStatus | 'all'
  >('all');
  const [now, setNow] = useState<Date>(new Date());
  /** The appointment whose audit trail is open in the drawer. */
  const [auditId, setAuditId] = useState<string>('');
  /** Transient message shown as a toast. */
  const [toast, setToast] = useState<{ message: string } | null>(null);

  // On mount, anchor the date to "today" in the branch.tz once we have
  // a branch. We initialize date only when the response arrives; the
  // backend defaults to today when no `?date=` is provided, so we can
  // skip the param and the response's `date` field reflects the day.
  useEffect(() => {
    setLoading(true);
    setErr(null);
    getReceptionistToday({})
      .then((res) => {
        setData(res);
        setDate(res.date);
        setLoading(false);
      })
      .catch((e: unknown) => {
        setErr(describeError(e));
        setLoading(false);
      });
  }, []);

  // Tick the clock once a minute so the "now" highlight stays current.
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  // Re-fetch when filters change. Debounce search by 250ms.
  useEffect(() => {
    if (data === null) return;
    const t = window.setTimeout(() => {
      const filters: {
        status?: ReceptionistAppointmentStatus;
        doctor_id?: string;
        date?: string;
      } = {};
      if (statusFilter !== 'all') filters.status = statusFilter;
      if (doctorFilter !== 'all') filters.doctor_id = doctorFilter;
      if (date && date !== data.date) filters.date = date;
      setLoading(true);
      getReceptionistToday(filters)
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
    // Intentionally exclude `data` from deps — we only refetch on
    // filter change. The first run is handled by the mount effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, date, doctorFilter, statusFilter]);

  // Build a doctor list from the current appointments. The today
  // endpoint doesn't return a separate doctor list, so derive it.
  const doctors = useMemo(() => {
    if (data === null) return [];
    const seen = new Map<string, string>();
    for (const a of data.appointments) {
      if (!seen.has(a.doctor_id)) seen.set(a.doctor_id, a.doctor_name);
    }
    return Array.from(seen, ([id, name]) => ({ id, name })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }, [data]);

  // Client-side search filter (patient phone only, since the API
  // doesn't echo patient names per E7-S3).
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
    if (data === null) return [];
    const buckets = new Map<number, ReceptionistTodayAppointment[]>();
    for (const a of filtered) {
      const h = hourOf(a, data.branch.tz);
      const bucket = buckets.get(h);
      if (bucket) {
        bucket.push(a);
      } else {
        buckets.set(h, [a]);
      }
    }
    return Array.from(buckets.entries())
      .sort(([a], [b]) => a - b)
      .map(([h, items]) => {
        const label = HOUR_LABELS.find((x) => x.hour === h)?.label ?? '';
        return {
          hour: h,
          label: `${String(h).padStart(2, '0')}:00 — ${label}`,
          items,
        };
      });
  }, [filtered, data]);

  const totalCount = data?.appointments.length ?? 0;
  const filteredCount = filtered.length;

  const onClickCancelRow = useCallback(
    (id: string) => {
      onOpenCancel(id);
    },
    [onOpenCancel],
  );

  /** The row whose audit drawer is open — for the drawer's title. */
  const auditAppointment = useMemo(() => {
    if (data === null || auditId === '') return undefined;
    return data.appointments.find((a) => a.id === auditId);
  }, [data, auditId]);

  return (
    <ReceptionistFrame>
      <div className="recep-today__page">
        <div className="recep-today__header">
          <div className="recep-today__header-left">
            {data && (
              <div className="recep-today__branch-pill">
                <span aria-hidden="true">📍</span> {data.branch.name}
              </div>
            )}
            <h1 className="recep-today__title">
              {data ? `Today, ${formatDateHeader(data.date)}` : 'Today'}
            </h1>
            <p className="recep-today__sub">
              {data
                ? `${doctors.length} doctor${doctors.length === 1 ? '' : 's'} at this branch · ${totalCount} appointment${totalCount === 1 ? '' : 's'}`
                : 'Loading…'}
            </p>
          </div>
          <button
            type="button"
            className="recep-today__primary-btn"
            onClick={onOpenCreate}
          >
            + Book walk-in
          </button>
        </div>

        <div className="recep-today__quicklinks">
          <button
            type="button"
            className="recep-today__quicklink"
            onClick={() => onOpenCancel('')}
            title="Cancel an appointment"
          >
            Cancel appointment
          </button>
          <button
            type="button"
            className="recep-today__quicklink"
            onClick={onOpenAvailability}
            title="Browse open slots"
          >
            Doctor availability
          </button>
        </div>

        <div className="recep-today__toolbar">
          <input
            className="recep-today__search"
            placeholder="Search patient phone…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <input
            type="date"
            className="recep-today__date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          <select
            className="recep-today__select"
            value={doctorFilter}
            onChange={(e) => setDoctorFilter(e.target.value)}
          >
            <option value="all">All doctors</option>
            {doctors.map((d) => (
              <option key={d.id} value={d.id}>
                {withDoctorTitle(d.name)}
              </option>
            ))}
          </select>
          <select
            className="recep-today__select"
            value={statusFilter}
            onChange={(e) =>
              setStatusFilter(
                e.target.value as ReceptionistAppointmentStatus | 'all',
              )
            }
          >
            {STATUS_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </div>

        {err && <div className="recep-today__error">{err}</div>}

        {loading && data === null && (
          <div className="recep-today__loading">Loading today…</div>
        )}

        {!loading && data !== null && filteredCount === 0 && (
          <div className="recep-today__empty">
            {search.trim().length > 0
              ? `No appointments match “${search.trim()}” on ${formatDateHeader(data.date)}.`
              : `No appointments on ${formatDateHeader(data.date)}.`}
          </div>
        )}

        {data !== null &&
          grouped.map((g) => (
            <section className="recep-today__hour" key={g.hour}>
              <div className="recep-today__hour-label">
                <span>{g.label}</span>
                <span className="recep-today__hour-count">
                  {g.items.length} appt{g.items.length === 1 ? '' : 's'}
                </span>
                <span className="recep-today__hour-line" />
              </div>
              {g.items.map((a) => (
                <div
                  key={a.id}
                  className={rowModifierClass(a, now, data.branch.tz)}
                >
                  <div className="recep-today__time">
                    {formatTimeLocal(a.start_datetime, data.branch.tz)}
                    <span className="recep-today__time-end">
                      {' '}
                      → {formatTimeLocal(a.end_datetime, data.branch.tz)}
                    </span>
                  </div>
                  <div className="recep-today__patient">
                    <div className="recep-today__patient-name">
                      {a.patient_phone}
                    </div>
                    <div className="recep-today__patient-phone">
                      {maskPhone(a.patient_phone)}
                    </div>
                  </div>
                  <div className="recep-today__doctor">
                    <span className="recep-today__doctor-avatar">
                      {initialsOf(a.doctor_name, a.doctor_id)}
                    </span>
                    {lastNameOf(a.doctor_name)}
                  </div>
                  <div className="recep-today__type">
                    {a.appointment_type_name}
                    {durationLabel(a.start_datetime, a.end_datetime) !== null && (
                      <>
                        {' · '}
                        <span className="recep-today__type-dur">
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
                  <div className="recep-today__qa">
                    <button
                      type="button"
                      className="recep-today__qa-btn"
                      onClick={() => onClickCancelRow(a.id)}
                    >
                      View
                    </button>
                    <button
                      type="button"
                      className="recep-today__qa-btn"
                      onClick={() => setAuditId(a.id)}
                      title="View the audit trail for this appointment"
                    >
                      Audit
                    </button>
                    {a.status === 'Scheduled' && (
                      <button
                        type="button"
                        className="recep-today__qa-btn recep-today__qa-btn--primary"
                        onClick={() => {
                          // The check-in state machine has no
                          // back-end surface yet, so this is a
                          // notice rather than a mutation. It used
                          // to be a `window.alert`, which blocked
                          // the page and looked like a browser
                          // error; an inline toast keeps the
                          // receptionist in the list.
                          setToast({
                            message:
                              'Check-in is not available yet — the receptionist can view or cancel the appointment.',
                          });
                          window.setTimeout(() => setToast(null), 5000);
                        }}
                      >
                        Check in
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </section>
          ))}
      </div>
      {auditId !== '' && data !== null && (
        <ReceptionistAuditDrawer
          appointmentId={auditId}
          appointmentLabel={
            auditAppointment === undefined
              ? 'Appointment'
              : `Patient ···${auditAppointment.patient_phone.slice(-4)}`
          }
          branchTz={data.branch.tz}
          onClose={() => setAuditId('')}
        />
      )}
      {toast && (
        <div className="recep-today__toast-stack">
          <div className="recep-today__toast" role="status">
            <span className="recep-today__toast-icon" aria-hidden="true">
              ℹ
            </span>
            <span className="recep-today__toast-text">{toast.message}</span>
            <button
              type="button"
              className="recep-today__toast-x"
              onClick={() => setToast(null)}
              title="Dismiss"
              aria-label="Dismiss message"
            >
              ×
            </button>
          </div>
        </div>
      )}
    </ReceptionistFrame>
  );
}
