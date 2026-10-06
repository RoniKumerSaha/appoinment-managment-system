/**
 * DoctorAuditDrawer — E7-S2 UI (mock 30).
 *
 * Right-side slide-in drawer showing the audit trail for a single
 * appointment. The doctor (role=doctor) is doubly-bound:
 *  1. claim.role === 'doctor' (role gate)
 *  2. appointment.doctor_id === claim.doctor_id (ownership gate)
 *
 * Per spec-7-2, the doctor's audit view is per-appointment (not a
 * global log). The drawer surfaces the rows the API wrote when the
 * appointment was created, rescheduled, moved, cancelled, or had
 * its status marked. Same envelope is returned for "doesn't exist"
 * and "exists but not yours" (E7-S3 privacy filter).
 *
 * Filter chips: All / Status changes / Cancellations / Block / Resolve.
 * The chip set is client-side filtering (server returns the full
 * 200-row window per MAX_AUDIT_ROWS = 200 in
 * apps/api/src/routes/doctor-appointment-audit.ts).
 *
 * Today the export is a button without onClick — CSV download is a
 * future hardening story (deferral D-E7-S-UI-2).
 *
 * Triggered from DoctorAffected "View audit log" affordance on each
 * kanban card (resolved column).
 */
import { useEffect, useMemo, useState } from 'react';
import {
  ApiError,
  getDoctorAppointmentAudit,
  type DoctorAuditResponse,
  type DoctorAuditRow,
} from '../api/client';
import './DoctorAuditDrawer.module.css';

export type DoctorAuditFilter =
  | 'all'
  | 'status'
  | 'cancel'
  | 'block'
  | 'resolve';

export interface DoctorAuditDrawerProps {
  appointmentId: string;
  /** Display label for the appointment (e.g. "Patient ···3456"). */
  appointmentLabel: string;
  /** Optional tz for time formatting. Defaults to UTC. */
  branchTz?: string;
  onClose: () => void;
}

interface DisplayedRow {
  id: string;
  isoTime: string; // raw ISO for sorting
  displayTime: string; // "10:35" or "Aug 20 · 17:42"
  isToday: boolean;
  actorLabel: string;
  actionLine: string;
  metaLine: string | null;
  pillLabel: string;
  pillTone: 'status' | 'block' | 'resolve' | 'cancel' | 'create';
}

export function DoctorAuditDrawer({
  appointmentId,
  appointmentLabel,
  branchTz = 'UTC',
  onClose,
}: DoctorAuditDrawerProps) {
  const [data, setData] = useState<DoctorAuditResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<DoctorAuditFilter>('all');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setData(null);
    (async () => {
      try {
        const res = await getDoctorAppointmentAudit(appointmentId);
        if (cancelled) return;
        setData(res);
        setLoading(false);
      } catch (e: unknown) {
        if (!cancelled) {
          setErr(describeAuditError(e));
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [appointmentId]);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const displayedRows = useMemo<DisplayedRow[]>(() => {
    if (data === null) return [];
    return data.audit.map((r) => toDisplayedRow(r, branchTz));
  }, [data, branchTz]);

  const filteredRows = useMemo<DisplayedRow[]>(() => {
    if (filter === 'all') return displayedRows;
    return displayedRows.filter((r) => filterMatches(filter, r));
  }, [displayedRows, filter]);

  const todayCount = useMemo(
    () => displayedRows.filter((r) => r.isToday).length,
    [displayedRows],
  );

  return (
    <div
      className="doc-audit__backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`Audit log for ${appointmentLabel}`}
      onClick={(e) => {
        // Click on backdrop (outside the drawer) closes.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside className="doc-audit__drawer">
        <div className="doc-audit__head">
          <div className="doc-audit__head-text">
            <div className="doc-audit__crumb">Audit log</div>
            <h2 className="doc-audit__title">{appointmentLabel}</h2>
            <div className="doc-audit__sub">
              Per-appointment trail · doctor scope
            </div>
          </div>
          <button
            type="button"
            className="doc-audit__close"
            aria-label="Close audit drawer"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className="doc-audit__summary">
          <span>
            <strong>{data?.count ?? 0}</strong> events
          </span>
          <span>·</span>
          <span>
            <strong>{todayCount}</strong> today
          </span>
          <span>·</span>
          <span>scope: your appointments only</span>
        </div>

        <div className="doc-audit__filter" role="group" aria-label="Filter audit events">
          <FilterChip
            label="All"
            active={filter === 'all'}
            onClick={() => setFilter('all')}
          />
          <FilterChip
            label="Status changes"
            active={filter === 'status'}
            onClick={() => setFilter('status')}
          />
          <FilterChip
            label="Cancellations"
            active={filter === 'cancel'}
            onClick={() => setFilter('cancel')}
          />
          <FilterChip
            label="Block"
            active={filter === 'block'}
            onClick={() => setFilter('block')}
          />
          <FilterChip
            label="Resolve"
            active={filter === 'resolve'}
            onClick={() => setFilter('resolve')}
          />
        </div>

        <div className="doc-audit__body">
          {loading && (
            <div className="doc-audit__empty">Loading audit log…</div>
          )}
          {err && <div className="doc-audit__err">{err}</div>}
          {!loading && !err && filteredRows.length === 0 && (
            <div className="doc-audit__empty">
              {data?.count === 0
                ? 'No audit events for this appointment yet.'
                : 'No events match the current filter.'}
            </div>
          )}
          {!loading &&
            !err &&
            filteredRows.map((r) => (
              <div key={r.id} className="doc-audit__row">
                <div
                  className={
                    'doc-audit__time' +
                    (r.isToday ? ' doc-audit__time-today' : '')
                  }
                >
                  {r.displayTime}
                </div>
                <div>
                  <div
                    className="doc-audit__action"
                    // The action line is a server-derived string; we
                    // intentionally render it as plain text (not
                    // dangerouslySetInnerHTML) so payloads can't
                    // inject markup.
                    // eslint-disable-next-line react/no-unescaped-entities
                  >
                    {r.actionLine}
                  </div>
                  <div className="doc-audit__actor">{r.actorLabel}</div>
                  {r.metaLine && (
                    <div className="doc-audit__meta">{r.metaLine}</div>
                  )}
                </div>
                <div className="doc-audit__pill-cell">
                  <span
                    className={`doc-audit__pill doc-audit__pill--${r.pillTone}`}
                  >
                    {r.pillLabel}
                  </span>
                </div>
              </div>
            ))}
        </div>

        <div className="doc-audit__foot">
          <span>
            Showing {filteredRows.length} of {data?.count ?? 0} · newer
            events at the top
          </span>
          <button
            type="button"
            className="doc-audit__export"
            disabled
            title="CSV export — future hardening (D-E7-S-UI-2)"
          >
            Export CSV
          </button>
        </div>

        <div className="doc-audit__privacy">
          <strong>Privacy:</strong> Doctors see audit rows for their own
          appointments only. Receptionists see rows for their branch.
          Admins see clinic-structure events. Patients never see audit
          logs.
        </div>
      </aside>
    </div>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={
        'doc-audit__chip' + (active ? ' doc-audit__chip--active' : '')
      }
      onClick={onClick}
      aria-pressed={active}
    >
      {label}
    </button>
  );
}

function describeAuditError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return 'Session expired. Please sign in again.';
    if (err.status === 403) return 'You do not have access to this audit log.';
    if (err.status === 404) return 'That appointment no longer exists.';
    return `Could not load the audit log (${err.code}).`;
  }
  if (err instanceof TypeError) {
    return 'Connection failed. Is the API running on :3001?';
  }
  return 'Could not load the audit log.';
}

/**
 * Map a server audit row to a UI display shape. The server returns
 * `event: 'cancelled' | 'moved_by_doctor' | 'rescheduled' | ...` and
 * a free-form payload. We translate the common events to friendly
 * action lines + pill tone so the doctor can scan the drawer at a
 * glance.
 *
 * Unknown events fall back to a "raw event" line + Resolve tone (the
 * audit log is internally conservative about labelling).
 */
function toDisplayedRow(row: DoctorAuditRow, branchTz: string): DisplayedRow {
  const iso = row.created_at;
  const isToday = isSameUtcDay(iso, new Date().toISOString());
  const displayTime = isToday
    ? formatHm(iso, branchTz)
    : `${formatMonthDayUtc(iso)} · ${formatHm(iso, branchTz)}`;

  const actorLabel = actorLabelOf(row.actor_role);

  // Default fallbacks.
  let actionLine = humanizeEvent(row.event);
  let pillLabel = 'Resolve';
  let pillTone: DisplayedRow['pillTone'] = 'resolve';
  let metaLine = metaFromPayload(row.payload);

  switch (row.event) {
    case 'cancelled': {
      pillLabel = 'Cancel';
      pillTone = 'cancel';
      const reason =
        typeof row.payload?.['reason'] === 'string'
          ? (row.payload['reason'] as string)
          : null;
      const who =
        typeof row.payload?.['cancelled_by_actor'] === 'string'
          ? (row.payload['cancelled_by_actor'] as string)
          : null;
      actionLine = 'cancelled this appointment';
      metaLine =
        (reason ? `reason: ${reason}` : 'no reason given') +
        (who ? ` · by ${who}` : '') +
        ' · slot released';
      break;
    }
    case 'rescheduled': {
      pillLabel = 'Resolve';
      pillTone = 'resolve';
      const from =
        typeof row.payload?.['from_start_datetime'] === 'string'
          ? (row.payload['from_start_datetime'] as string)
          : null;
      const to =
        typeof row.payload?.['to_start_datetime'] === 'string'
          ? (row.payload['to_start_datetime'] as string)
          : null;
      actionLine = 'rescheduled this appointment';
      metaLine =
        from && to
          ? `${formatMonthDayUtc(from)} → ${formatMonthDayUtc(to)} · by patient`
          : 'by patient';
      break;
    }
    case 'moved_by_doctor': {
      pillLabel = 'Resolve';
      pillTone = 'resolve';
      const fromBranch =
        typeof row.payload?.['from_branch_id'] === 'string'
          ? `branch ·${(row.payload['from_branch_id'] as string).slice(-4)}`
          : null;
      const toBranch =
        typeof row.payload?.['to_branch_id'] === 'string'
          ? `branch ·${(row.payload['to_branch_id'] as string).slice(-4)}`
          : null;
      const toStart =
        typeof row.payload?.['to_start_datetime'] === 'string'
          ? (row.payload['to_start_datetime'] as string)
          : null;
      actionLine = 'moved this appointment';
      metaLine = [
        fromBranch && toBranch ? `${fromBranch} → ${toBranch}` : null,
        toStart ? `to ${formatMonthDayUtc(toStart)} · ${formatHm(toStart, branchTz)}` : null,
        'atomic',
      ]
        .filter((s): s is string => typeof s === 'string' && s.length > 0)
        .join(' · ');
      break;
    }
    case 'status_marked': {
      pillLabel = 'Status';
      pillTone = 'status';
      const status =
        typeof row.payload?.['new_status'] === 'string'
          ? (row.payload['new_status'] as string)
          : 'updated';
      actionLine = `marked status · ${status}`;
      break;
    }
    case 'recurring_created': {
      pillLabel = 'Create';
      pillTone = 'create';
      const recurringId =
        typeof row.payload?.['recurring_series_id'] === 'string'
          ? (row.payload['recurring_series_id'] as string).slice(-4)
          : null;
      actionLine = 'created in a recurring series';
      metaLine = recurringId
        ? `recurring · ··${recurringId}`
        : 'recurring';
      break;
    }
    case 'blocked': {
      pillLabel = 'Block';
      pillTone = 'block';
      const reason =
        typeof row.payload?.['reason'] === 'string'
          ? (row.payload['reason'] as string)
          : 'block';
      actionLine = 'blocked this slot';
      metaLine = `reason: ${reason}`;
      break;
    }
    case 'created': {
      pillLabel = 'Create';
      pillTone = 'create';
      actionLine = 'created this appointment';
      metaLine = metaFromPayload(row.payload);
      break;
    }
    default:
      // Unknown event: render the raw event name as the action.
      actionLine = row.event;
      pillLabel = 'Event';
      pillTone = 'resolve';
      metaLine = null;
  }

  return {
    id: row.id,
    isoTime: iso,
    displayTime,
    isToday,
    actorLabel,
    actionLine,
    metaLine,
    pillLabel,
    pillTone,
  };
}

function filterMatches(filter: DoctorAuditFilter, row: DisplayedRow): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'status':
      return row.pillTone === 'status';
    case 'cancel':
      return row.pillTone === 'cancel';
    case 'block':
      return row.pillTone === 'block';
    case 'resolve':
      return row.pillTone === 'resolve' || row.pillTone === 'create';
  }
}

function humanizeEvent(event: string): string {
  return event.replace(/_/g, ' ');
}

function actorLabelOf(role: string): string {
  if (role === 'doctor') return 'you · doctor';
  if (role === 'patient') return 'patient';
  if (role === 'receptionist') return 'receptionist';
  if (role === 'admin') return 'admin';
  return role;
}

function metaFromPayload(
  payload: Record<string, unknown> | null,
): string | null {
  if (payload === null) return null;
  const keys = Object.keys(payload);
  if (keys.length === 0) return null;
  return keys
    .slice(0, 3)
    .map((k) => `${k}: ${String(payload[k])}`)
    .join(' · ');
}

function formatHm(iso: string, tz: string): string {
  const d = new Date(iso);
  const tzOpt = tz === 'UTC' ? undefined : tz;
  return d.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: tzOpt,
  });
}

function formatMonthDayUtc(iso: string): string {
  // Drawer shows audit times in UTC for privacy — the patient's
  // branch tz is for booking display, not audit display.
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function isSameUtcDay(aIso: string, bIso: string): boolean {
  const a = new Date(aIso);
  const b = new Date(bIso);
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}