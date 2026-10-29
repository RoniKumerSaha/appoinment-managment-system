/**
 * ReceptionistAuditDrawer — receptionist-side audit read.
 *
 * The receptionist-scoped audit endpoint (`GET
 * /reception/appointments/:id/audit`) and its client wrapper
 * (`getReceptionistAppointmentAudit`) both existed, but nothing in
 * the UI called them — the receptionist had no way to see the audit
 * trail for an appointment at their branch, even though PRD FR-051
 * grants exactly that scope.
 *
 * The drawer mirrors `DoctorAuditDrawer` (same slide-in shape, same
 * filter-chip vocabulary) so the two role surfaces read as one
 * feature. The difference is scope: the receptionist sees events for
 * appointments at THEIR branch, not for one particular doctor.
 *
 * Booked-slot privacy (F-15) does NOT apply here — this is the
 * internal audit surface (NFR-005), so the receptionist sees the
 * full patient phone and the actor behind each event.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ApiError,
  getReceptionistAppointmentAudit,
  type ReceptionAuditResponse,
  type ReceptionAuditRow,
} from '../api/client';
import './ReceptionistAuditDrawer.css';

export type ReceptionAuditFilter =
  | 'all'
  | 'status'
  | 'cancel'
  | 'block'
  | 'resolve';

interface ReceptionistAuditDrawerProps {
  appointmentId: string;
  /** Display label for the appointment (e.g. "Patient ···8990"). */
  appointmentLabel: string;
  /** Branch tz for time formatting. Defaults to UTC. */
  branchTz?: string;
  onClose: () => void;
}

interface DisplayedRow {
  id: string;
  displayTime: string;
  isToday: boolean;
  actorLabel: string;
  actionLine: string;
  metaLine: string | null;
  pillLabel: string;
  pillTone: 'status' | 'block' | 'resolve' | 'cancel' | 'create';
}

export function ReceptionistAuditDrawer({
  appointmentId,
  appointmentLabel,
  branchTz = 'UTC',
  onClose,
}: ReceptionistAuditDrawerProps): ReactNode {
  const [data, setData] = useState<ReceptionAuditResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<ReceptionAuditFilter>('all');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setData(null);
    (async () => {
      try {
        const res = await getReceptionistAppointmentAudit(appointmentId);
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
      className="recep-audit__backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`Audit log for ${appointmentLabel}`}
      data-testid="recep-audit-modal"
      onClick={(e) => {
        // Click on backdrop (outside the drawer) closes.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside className="recep-audit__drawer" data-testid="recep-audit-drawer">
        <div className="recep-audit__head" data-testid="recep-audit-head">
          <div className="recep-audit__head-text">
            <div className="recep-audit__crumb">Audit log</div>
            <h2 className="recep-audit__title">{appointmentLabel}</h2>
            <div className="recep-audit__sub">
              Per-appointment trail · branch scope
            </div>
          </div>
          <button
            type="button"
            className="recep-audit__close"
            data-testid="recep-audit-close-btn"
            aria-label="Close audit drawer"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className="recep-audit__summary" data-testid="recep-audit-summary">
          <span>
            <strong>{data?.count ?? 0}</strong>{' '}
            {(data?.count ?? 0) === 1 ? 'event' : 'events'}
          </span>
          <span>·</span>
          <span>
            <strong>{todayCount}</strong> today
          </span>
          <span>·</span>
          <span>scope: your branch only</span>
        </div>

        <div
          className="recep-audit__filter"
          role="group"
          aria-label="Filter audit events"
          data-testid="recep-audit-filter"
        >
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

        <div className="recep-audit__body" data-testid="recep-audit-body">
          {loading && (
            <div className="recep-audit__empty" data-testid="recep-audit-loading">
              Loading audit log…
            </div>
          )}
          {err && (
            <div
              className="recep-audit__err"
              data-testid="recep-audit-error"
              role="alert"
            >
              {err}
            </div>
          )}
          {!loading && !err && filteredRows.length === 0 && (
            <div className="recep-audit__empty" data-testid="recep-audit-empty">
              {data?.count === 0
                ? 'No audit events for this appointment yet.'
                : 'No events match the current filter.'}
            </div>
          )}
          {!loading &&
            !err &&
            filteredRows.map((r) => (
              <div
                key={r.id}
                className="recep-audit__row"
                data-testid={`recep-audit-row-${r.id}`}
              >
                <div
                  className={
                    'recep-audit__time' +
                    (r.isToday ? ' recep-audit__time-today' : '')
                  }
                  data-testid={`recep-audit-row-${r.id}-time`}
                >
                  {r.displayTime}
                </div>
                <div>
                  <div
                    className="recep-audit__action"
                    data-testid={`recep-audit-row-${r.id}-action`}
                  >
                    {r.actionLine}
                  </div>
                  <div
                    className="recep-audit__actor"
                    data-testid={`recep-audit-row-${r.id}-actor`}
                  >
                    {r.actorLabel}
                  </div>
                  {r.metaLine && (
                    <div
                      className="recep-audit__meta"
                      data-testid={`recep-audit-row-${r.id}-meta`}
                    >
                      {r.metaLine}
                    </div>
                  )}
                </div>
                <div className="recep-audit__pill-cell">
                  <span
                    className={`recep-audit__pill recep-audit__pill--${r.pillTone}`}
                    data-testid={`recep-audit-row-${r.id}-pill`}
                  >
                    {r.pillLabel}
                  </span>
                </div>
              </div>
            ))}
        </div>

        <div className="recep-audit__foot" data-testid="recep-audit-foot">
          <span>
            Showing {filteredRows.length} of {data?.count ?? 0} · newer events
            at the top
          </span>
        </div>

        <div className="recep-audit__privacy" data-testid="recep-audit-privacy">
          <strong>Privacy:</strong> Receptionists see audit rows for
          appointments at their own branch. Doctors see rows for their
          own appointments. Admins see clinic-structure events.
          Patients never see audit logs.
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
}): ReactNode {
  return (
    <button
      type="button"
      className={
        'recep-audit__chip' + (active ? ' recep-audit__chip--active' : '')
      }
      data-testid={`recep-audit-filter-${label.toLowerCase().replace(/\s+/g, '-')}`}
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
    if (err.status === 403) {
      if (err.code === 'outside_branch_scope') {
        return 'That appointment is not at your branch.';
      }
      return 'You do not have access to this audit log.';
    }
    if (err.status === 404) return 'That appointment no longer exists.';
    return `Could not load the audit log (${err.code}).`;
  }
  if (err instanceof TypeError) {
    return 'Connection failed. Is the API running on :3001?';
  }
  return 'Could not load the audit log.';
}

/**
 * Map a server audit row to a UI display shape. The receptionist
 * surface deliberately mirrors the doctor's `toDisplayedRow` so the
 * two drawers agree on how an event reads; the event vocabulary is
 * the same one the write paths emit.
 *
 * Pill labels carry a glyph prefix so meaning survives a
 * colour-blind viewer or a stripped stylesheet (WCAG 1.4.1).
 */
function toDisplayedRow(
  row: ReceptionAuditRow,
  branchTz: string,
): DisplayedRow {
  const iso = row.created_at;
  const isToday = isSameUtcDay(iso, new Date().toISOString());
  const displayTime = isToday
    ? formatHm(iso, branchTz)
    : `${formatMonthDayUtc(iso)} · ${formatHm(iso, branchTz)}`;

  const actorLabel = actorLabelOf(row.actor_role, row.actor_id);

  let actionLine = humanizeEvent(row.event);
  let pillLabel = '✓ Resolve';
  let pillTone: DisplayedRow['pillTone'] = 'resolve';
  let metaLine = metaFromPayload(row.payload);

  switch (row.event) {
    case 'cancelled': {
      pillLabel = '✕ Cancel';
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
      pillLabel = '✓ Resolve';
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
      pillLabel = '✓ Resolve';
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
        toStart
          ? `to ${formatMonthDayUtc(toStart)} · ${formatHm(toStart, branchTz)}`
          : null,
        'atomic',
      ]
        .filter((s): s is string => typeof s === 'string' && s.length > 0)
        .join(' · ');
      break;
    }
    case 'marked_completed':
    case 'marked_no_show': {
      pillLabel = '● Status';
      pillTone = 'status';
      const status =
        row.event === 'marked_completed' ? 'Completed' : 'No-show';
      actionLine = `marked status · ${status}`;
      metaLine = 'no reason required';
      break;
    }
    case 'recurring_created': {
      pillLabel = '+ Create';
      pillTone = 'create';
      const recurringId =
        typeof row.payload?.['recurring_series_id'] === 'string'
          ? (row.payload['recurring_series_id'] as string).slice(-4)
          : null;
      actionLine = 'created in a recurring series';
      metaLine = recurringId ? `recurring · ··${recurringId}` : 'recurring';
      break;
    }
    case 'blocked': {
      pillLabel = '⊘ Block';
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
      pillLabel = '+ Create';
      pillTone = 'create';
      actionLine = 'created this appointment';
      metaLine = metaFromPayload(row.payload);
      break;
    }
    default:
      // Unknown event: render the raw event name as the action.
      actionLine = row.event;
      pillLabel = '· Event';
      pillTone = 'resolve';
      metaLine = null;
  }

  return {
    id: row.id,
    displayTime,
    isToday,
    actorLabel,
    actionLine,
    metaLine,
    pillLabel,
    pillTone,
  };
}

function filterMatches(
  filter: ReceptionAuditFilter,
  row: DisplayedRow,
): boolean {
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

/**
 * Label the actor. `actor_id` is written by the API as a role
 * prefix — `staff:<uuid>`, `patient:<phone>`, `admin:<email>` —
 * so we can name the actor without leaking a full identifier when
 * the role alone is enough.
 */
function actorLabelOf(role: string, actorId: string): string {
  if (role === 'doctor') return 'doctor';
  if (role === 'patient') return 'patient';
  if (role === 'receptionist') return 'receptionist';
  if (role === 'admin') return 'admin';
  if (actorId.startsWith('patient:')) return 'patient';
  if (actorId.startsWith('staff:')) return 'staff';
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
    .map((k) => `${k}: ${readableValue(payload[k])}`)
    .join(' · ');
}

/**
 * Render a payload value for the meta line.
 *
 * The raw payload carries full UUIDs (`branch_id`,
 * `doctor_id`) which are 36 characters of noise in a 480px drawer —
 * they pushed the useful values (the source, the reason) off the
 * line. A UUID is shown as its last 4 characters (`·1d97`) so the
 * reader can still correlate it with the detail view without the
 * line wrapping into a paragraph.
 */
function readableValue(value: unknown): string {
  if (typeof value !== 'string') return String(value);
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  ) {
    return `·${value.slice(-4)}`;
  }
  return value;
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
