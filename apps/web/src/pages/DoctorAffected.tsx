/**
 * DoctorAffected — E6-S2 / E6-S3 UI (mock 06).
 *
 * Kanban-style "Resolve affected appointments" board for the
 * doctor. The doctor sees their future Scheduled appointments
 * that fall OUTSIDE the current branch hours (E1-S2 may have
 * just narrowed hours; the affected rows are saved-and-flagged,
 * not auto-cancelled). The doctor's job is to move each one to a
 * valid new slot.
 *
 * 4 columns:
 *  - To do (red dot)         — never-touched affected rows.
 *  - In progress (amber dot)  — the row the doctor is currently
 *                               resolving.
 *  - Awaiting slot choice     — patient-time-conflict / past /
 *                               other doctor-types-affected rows
 *                               waiting for a manual slot choice.
 *  - Resolved (green dot)     — moved-by-doctor rows (success).
 *
 * Source: GET /doctor/affected (E6-S3). Each row carries
 * `reason: 'closed_day' | 'before_open_or_after_close'` — the
 * same vocabulary as E1-S2's admin impact-preview, so the two
 * surfaces cannot diverge on what counts as "affected".
 *
 * Move action: opens DoctorResolvePage (mock 24 stacked flow).
 * The full-page sub-route takes the appointment id; the parent
 * kanban stays mounted underneath the modal backdrop.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ApiError,
  getDoctorAffected,
  getDoctorAppointmentAudit,
  listPublicBranches,
  type DoctorAffectedAppointment,
  type DoctorAffectedResponse,
  type PublicBranchDto,
} from '../api/client';
import { useAuth } from '../auth/store';
import { DoctorCancel } from './DoctorCancel';
import { DoctorFrame } from './DoctorFrame';
import { DoctorMarkStatus } from './DoctorMarkStatus';
import { DoctorResolve } from './DoctorResolve';
import { DoctorResolutionSaved, type SavedAuditEvent } from './DoctorResolutionSaved';
import {
  formatDateInTz,
  formatMonthDay,
  formatTimeInTz,
  maskPhone,
  patientLabelFromPhone,
} from './doctor-utils';
import './DoctorAffected.css';

interface DoctorAffectedProps {
  onGoSchedule?: () => void;
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return 'Session expired. Please sign in again.';
    if (err.status === 403) return 'You do not have access to this view.';
    return `Could not load the affected queue (${err.code}).`;
  }
  if (err instanceof TypeError) {
    return 'Connection failed. Is the API running on :3001?';
  }
  return 'Could not load the affected queue.';
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
      // The affected queue has a TTL — the row may have been
      // cancelled by another action (patient self-cancel on
      // another device, parallel test) between the time the
      // queue was fetched and the time the doctor clicked
      // Confirm. The modal will close and refresh the queue
      // when this happens.
      return 'This appointment is no longer in the queue. Refreshing…';
    }
    if (err.status === 400) {
      if (err.code === 'reason_required') {
        return 'A reason is required.';
      }
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
    if (err.status === 404) {
      return 'That appointment no longer exists.';
    }
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

function describeMoveError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return 'Session expired. Please sign in again.';
    if (err.status === 422) {
      if (err.code === 'already_in_terminal_state') {
        return 'This appointment is no longer Scheduled.';
      }
      if (err.code === 'appointment_in_past') {
        return 'That appointment is already in the past.';
      }
      if (err.code === 'no_op_move') {
        return 'You did not change anything — pick a different slot.';
      }
      return `Could not move (${err.code}).`;
    }
    if (err.status === 409) {
      if (err.code === 'slot_raced') {
        return 'That slot was just booked by another patient.';
      }
      if (err.code === 'patient_time_conflict') {
        return 'The patient already has another appointment at that time.';
      }
      if (err.code === 'doctor_unavailable') {
        return "You're not available at that slot.";
      }
      if (err.code === 'branch_closed') {
        return 'The branch is closed at that slot.';
      }
      if (err.code === 'outside_30d_window') {
        return 'That date is more than 30 days out.';
      }
      if (err.code === 'slot_in_past') {
        return 'That slot is in the past.';
      }
      return `Could not move (${err.code}).`;
    }
    if (err.status === 400) {
      if (err.code === 'duration_mismatch') {
        return "The slot's duration doesn't match this appointment.";
      }
      if (err.code === 'doctor_not_at_branch') {
        return "You don't work at that branch.";
      }
      if (err.code === 'branch_inactive') {
        return 'That branch is no longer accepting bookings.';
      }
      if (err.code === 'invalid_time_range') {
        return 'Invalid time range.';
      }
      if (err.code === 'unknown_field') {
        return 'The form has an unknown field.';
      }
      return `Could not move (${err.code}).`;
    }
    if (err.status === 403) {
      return 'You do not have access to this appointment.';
    }
    if (err.status === 404) {
      return 'That appointment no longer exists.';
    }
    return `Could not move (${err.code}).`;
  }
  if (err instanceof TypeError) {
    return 'Connection failed. Is the API running on :3001?';
  }
  return 'Could not move the appointment.';
}

interface ResolvedRow {
  appointment_id: string;
  patient_phone: string;
  appointment_type_id: string;
  branch_id: string;
  branchName: string;
  fromStart: string;
  toStart: string;
  toEnd: string;
  /** The destination branch's timezone (IANA). */
  tz: string;
}

// Mockup 37 — the audit-block on the resolution-saved modal echoes the
// most recent events for the affected appointment.
//
// These used to be 4 FABRICATED events ("Branch impact recorded",
// "Affected appointment created", "Slot offered to patient",
// "Appointment moved") with timestamps back-dated from the slot time.
// Nothing in the system ever wrote those events, so the block showed a
// history that did not exist. Now that E7-S2 has landed, the real
// `GET /doctor/appointments/:id/audit` endpoint backs this.
function auditToneFor(event: string): SavedAuditEvent['tone'] {
  switch (event) {
    case 'created':
    case 'recurring_created':
      return 'create';
    case 'cancelled':
      return 'cancel';
    case 'moved_by_doctor':
    case 'marked_completed':
    case 'marked_no_show':
    case 'rescheduled':
      return 'resolve';
    default:
      return 'config';
  }
}

function auditLabelFor(event: string): string {
  switch (event) {
    case 'created':
      return 'Appointment created';
    case 'recurring_created':
      return 'Created in a recurring series';
    case 'cancelled':
      return 'Appointment cancelled';
    case 'rescheduled':
      return 'Appointment rescheduled';
    case 'moved_by_doctor':
      return 'Appointment moved';
    case 'marked_completed':
      return 'Marked as completed';
    case 'marked_no_show':
      return 'Marked as no-show';
    default:
      return event.replace(/_/g, ' ');
  }
}

/** Fetch the real audit trail for an appointment, newest first. */
async function fetchSavedAuditEvents(
  appointmentId: string,
): Promise<SavedAuditEvent[]> {
  const res = await getDoctorAppointmentAudit(appointmentId);
  return res.audit.map((row) => ({
    at: row.created_at,
    label: auditLabelFor(row.event),
    tone: auditToneFor(row.event),
  }));
}

export function DoctorAffected({ onGoSchedule }: DoctorAffectedProps) {
  const { stored } = useAuth();
  const doctorId = stored?.claim.doctor_id ?? null;
  const [rows, setRows] = useState<DoctorAffectedAppointment[] | null>(null);
  const [branches, setBranches] = useState<Map<string, PublicBranchDto>>(
    () => new Map(),
  );
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Move flow state.
  const [moveId, setMoveId] = useState<string | null>(null);
  const [inProgressId, setInProgressId] = useState<string | null>(null);
  const [resolved, setResolved] = useState<ResolvedRow[]>([]);
  const [completionModal, setCompletionModal] = useState<ResolvedRow | null>(
    null,
  );
  // The real audit trail for the appointment in the resolution-saved
  // modal. Loaded when the modal opens (E7-S2 endpoint); empty until
  // the fetch resolves.
  const [completionAudit, setCompletionAudit] = useState<SavedAuditEvent[]>(
    [],
  );

  // Cancel + mark-status flow state (E5-S1, E5-S2).
  const [cancelId, setCancelId] = useState<string | null>(null);
  const [markId, setMarkId] = useState<string | null>(null);

  // Bulk-bar selection state (mockup 06). Cleared whenever the open list
  // mutates so stale ids never leak across refreshes.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(),
  );
  useEffect(() => {
    setSelectedIds(new Set());
  }, [rows]);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setErr(null);
    try {
      const list = await getDoctorAffected();
      setRows(list.appointments);
      setLoading(false);
    } catch (e: unknown) {
      setErr(describeError(e));
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Once we have rows, fetch the branches those rows reference.
  useEffect(() => {
    if (rows === null || rows.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        // Doctor-scoped branch list (one round-trip).
        const r = await listPublicBranches(doctorId ?? undefined);
        if (cancelled) return;
        const m = new Map<string, PublicBranchDto>();
        for (const b of r.branches) m.set(b.id, b);
        setBranches(m);
      } catch {
        // Non-fatal; we can still render masked branch IDs.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rows, doctorId]);

  const onMove = useCallback((id: string): void => {
    setInProgressId(id);
    setMoveId(id);
  }, []);

  const onCancelResolve = useCallback((): void => {
    setMoveId(null);
    setInProgressId(null);
  }, []);

  const onResolved = useCallback(
    (info: ResolvedRow): void => {
      setMoveId(null);
      setInProgressId(null);
      setResolved((prev) => [info, ...prev]);
      setToast('Appointment moved.');
      setCompletionModal(info);
    },
    [],
  );

  // Load the REAL audit trail for the appointment in the
  // resolution-saved modal. The audit block used to render 4
  // fabricated events; the E7-S2 endpoint
  // (`GET /doctor/appointments/:id/audit`) is the source of truth now.
  useEffect(() => {
    if (completionModal === null) {
      setCompletionAudit([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const events = await fetchSavedAuditEvents(
          completionModal.appointment_id,
        );
        if (!cancelled) setCompletionAudit(events);
      } catch {
        // The audit block is supplementary — if the fetch fails, show
        // an empty block rather than blocking the resolution modal.
        if (!cancelled) setCompletionAudit([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [completionModal]);

  const refreshAfter = useCallback(async (): Promise<void> => {
    await refresh();
  }, [refresh]);

  // Look up a row by id (the cancel / mark-status modals need the
  // full appointment payload). Declared above onOpenCancel so the
  // re-validation callback can read it.
  const rowById = useCallback(
    (id: string): DoctorAffectedAppointment | null => {
      if (rows === null) return null;
      return rows.find((r) => r.appointment_id === id) ?? null;
    },
    [rows],
  );

  // Cancel-modal open path: re-validate the row's state before
  // showing the modal. The affected queue is fetched on mount
  // only (no polling), so the row the user is looking at may
  // have been changed by a parallel action (patient self-cancel
  // on another device, admin action, concurrent test). If we
  // don't re-validate, the user fills out a reason and the
  // API returns 404 not_found because the row is no longer
  // Scheduled (or no longer exists), and the modal shows
  // "That appointment no longer exists." without context.
  // Re-validating here lets us surface a friendly toast and
  // refresh the queue instead of letting the user chase a
  // phantom 404.
  const onOpenCancel = useCallback(
    async (id: string): Promise<void> => {
      const cached = rowById(id);
      if (cached === null) {
        // No such row in the cached list. Refresh once so the
        // user sees a fresh queue, then bail.
        setToast('This appointment is no longer in the queue. Refreshing…');
        await refresh();
        return;
      }
      if (cached.status !== 'Scheduled') {
        // Row is in the cache but in a non-cancellable state.
        // Refresh and inform.
        setToast(
          `This appointment is ${cached.status.toLowerCase()}, not Scheduled. Refreshing…`,
        );
        await refresh();
        return;
      }
      // Re-fetch the affected queue and double-check. This
      // catches the race where the row was cancelled between
      // the cache read and now.
      let latest: DoctorAffectedResponse | null = null;
      try {
        latest = await getDoctorAffected();
      } catch {
        // Network failure — fall through to opening the modal
        // (the API call itself will surface a more specific
        // error if the row is gone).
      }
      if (latest !== null) {
        const fresh: DoctorAffectedAppointment | undefined =
          latest.appointments.find(
            (a: DoctorAffectedAppointment) => a.appointment_id === id,
          );
        if (fresh === undefined) {
          setToast('This appointment is no longer in the queue. Refreshing…');
          await refresh();
          return;
        }
        if (fresh.status !== 'Scheduled') {
          setToast(
            `This appointment is ${fresh.status.toLowerCase()}, not Scheduled. Refreshing…`,
          );
          await refresh();
          return;
        }
      }
      setCancelId(id);
    },
    [rowById, refresh],
  );

  const onCloseCancel = useCallback((): void => {
    setCancelId(null);
  }, []);

  const onCancelled = useCallback(
    async (reason: string): Promise<void> => {
      setCancelId(null);
      setToast(`Appointment cancelled · ${reason}`);
      await refresh();
    },
    [refresh],
  );

  // Stale-row handler (E7-UX): invoked by DoctorCancel when the
  // API returns 404 because the row is no longer in the queue.
  // Close the modal and refresh so the doctor sees the
  // up-to-date list instead of a phantom modal anchored to a
  // row that doesn't exist anymore.
  const onCancelStale = useCallback((): void => {
    setCancelId(null);
    setToast('This appointment is no longer in the queue. Refreshing…');
    void refresh();
  }, [refresh]);

  // Same stale-row handler for the mark-status modal (E5-S1).
  const onMarkStale = useCallback((): void => {
    setMarkId(null);
    setToast('This appointment is no longer in the queue. Refreshing…');
    void refresh();
  }, [refresh]);

  const onOpenMark = useCallback((id: string): void => {
    setMarkId(id);
  }, []);

  const onCloseMark = useCallback((): void => {
    setMarkId(null);
  }, []);

  const onMarked = useCallback(
    async (status: 'Completed' | 'No-show'): Promise<void> => {
      setMarkId(null);
      setToast(`Marked as ${status}.`);
      await refresh();
    },
    [refresh],
  );

  // Masked branch id fallback.
  const maskedBranch = (id: string): string => {
    const b = branches.get(id);
    if (b) return b.name;
    return `Branch ··${id.slice(-4)}`;
  };

  const tzForRow = useCallback(
    (row: DoctorAffectedAppointment): string => {
      const b = branches.get(row.branch_id);
      return b?.tz ?? 'UTC';
    },
    [branches],
  );

  // Was the row's start_datetime in the past (mark-status precond)?
  // Past rows are markable; future rows surface
  // appointment_in_future. E5-S1's time gate.
  const isPastRow = useCallback((r: DoctorAffectedAppointment): boolean => {
    return new Date(r.start_datetime).getTime() <= Date.now();
  }, []);

  // Display rows that should appear in "To do" / "In progress" /
  // "Awaiting slot choice" / "Resolved". Resolved rows are
  // session-local; we only show the most recent one in the
  // success modal, but the column still renders the full list.
  const open = useMemo(() => {
    if (rows === null) return [] as DoctorAffectedAppointment[];
    return rows;
  }, [rows]);

  // ── Bulk actions (mockup 06) ─────────────────────────────────
  const onToggleAll = useCallback((): void => {
    setSelectedIds((prev) => {
      if (prev.size === open.length) return new Set();
      return new Set(open.map((r) => r.appointment_id));
    });
  }, [open]);

  const onBulkMove = useCallback((): void => {
    if (selectedIds.size === 0) return;
    setToast(
      `Bulk-move for ${selectedIds.size} appointment${
        selectedIds.size === 1 ? '' : 's'
      } is coming with E6-S4. The selection is held until then.`,
    );
    window.setTimeout(() => setToast(null), 4000);
  }, [selectedIds]);

  const onBulkCancel = useCallback((): void => {
    if (selectedIds.size === 0) return;
    setToast(
      `Bulk-cancel for ${selectedIds.size} appointment${
        selectedIds.size === 1 ? '' : 's'
      } is coming with E6-S4. Use the row-level cancel button for now.`,
    );
    window.setTimeout(() => setToast(null), 4000);
  }, [selectedIds]);

  const onExportCsv = useCallback((): void => {
    if (rows === null || rows.length === 0) return;
    const header = [
      'appointment_id',
      'patient_phone',
      'branch_id',
      'type_id',
      'start_datetime',
      'end_datetime',
      'tz',
    ];
    const escape = (v: string): string =>
      /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push(
        [
          r.appointment_id,
          r.patient_phone,
          r.branch_id,
          r.appointment_type_id,
          r.start_datetime,
          r.end_datetime,
          tzForRow(r),
        ]
          .map((v) => escape(String(v)))
          .join(','),
      );
    }
    const blob = new Blob([lines.join('\n')], {
      type: 'text/csv;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `affected-queue-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [rows, tzForRow]);

  return (
    <DoctorFrame activeNav="affected">
      <div className="doc-aff__page" data-testid="doc-aff">
        <div className="doc-aff__alert" data-testid="doc-aff-alert">
          <div className="doc-aff__alert-text">
            <strong>
              {rows === null
                ? '… appointments affected.'
                : `${rows.length} appointment${rows.length === 1 ? '' : 's'} affected.`}
            </strong>{' '}
            {rows !== null && rows.length > 0
              ? 'Your branch hours may have changed. Resolve each appointment by moving it to a new slot, or cancel.'
              : 'No appointments need your attention right now.'}
          </div>
          {rows !== null && rows.length > 0 && (
            <div className="doc-aff__alert-stats" data-testid="doc-aff-alert-stats">
              <span className="doc-aff__pill doc-aff__pill--todo" data-testid="doc-aff-pill-todo">
                <span aria-hidden="true">🔴</span> {open.length} to do
              </span>
              {inProgressId !== null && (
                <span className="doc-aff__pill doc-aff__pill--doing" data-testid="doc-aff-pill-doing">
                  <span aria-hidden="true">🟡</span> 1 in progress
                </span>
              )}
              {resolved.length > 0 && (
                <span className="doc-aff__pill doc-aff__pill--done" data-testid="doc-aff-pill-done">
                  <span aria-hidden="true">🟢</span> {resolved.length} resolved
                </span>
              )}
            </div>
          )}
        </div>

        <div className="doc-aff__header" data-testid="doc-aff-header">
          <h1 className="doc-aff__title">Resolve affected appointments</h1>
          <p className="doc-aff__sub">
            Move each patient to a new slot, or cancel. Each row lists an
            appointment outside the current branch operating hours.
          </p>
        </div>

        {err && <div className="doc-aff__error" data-testid="doc-aff-error" role="alert">{err}</div>}
        {toast && <div className="doc-aff__toast" data-testid="doc-aff-toast" role="status">{toast}</div>}

        {open.length > 1 && (
          <div className="doc-aff__bulk-bar" data-testid="doc-aff-bulk-bar">
            <label className="doc-aff__bulk-toggle">
              <input
                type="checkbox"
                checked={selectedIds.size === open.length && open.length > 0}
                ref={(el) => {
                  if (el) {
                    el.indeterminate =
                      selectedIds.size > 0 &&
                      selectedIds.size < open.length;
                  }
                }}
                onChange={onToggleAll}
                aria-label="Select all to-do appointments"
                data-testid="doc-aff-bulk-toggle"
              />
              <span>
                {selectedIds.size === 0
                  ? `Select all ${open.length} to do`
                  : `${selectedIds.size} of ${open.length} selected`}
              </span>
            </label>
            <div className="doc-aff__bulk-actions" data-testid="doc-aff-bulk-actions">
              <button
                type="button"
                className="doc-aff__bulk-btn"
                data-testid="doc-aff-bulk-move-btn"
                onClick={onBulkMove}
                disabled={selectedIds.size === 0}
                title="Move selected to the same new date — coming with E6-S4"
              >
                Bulk: pick same new date
              </button>
              <button
                type="button"
                className="doc-aff__bulk-btn doc-aff__bulk-btn--danger"
                data-testid="doc-aff-bulk-cancel-btn"
                onClick={onBulkCancel}
                disabled={selectedIds.size === 0}
                title="Cancel selected — coming with E6-S4"
              >
                Cancel selected ({selectedIds.size})
              </button>
              <button
                type="button"
                className="doc-aff__bulk-btn doc-aff__bulk-btn--ghost"
                data-testid="doc-aff-export-csv-btn"
                onClick={onExportCsv}
                title="Export current queue as CSV"
              >
                Export as CSV
              </button>
            </div>
          </div>
        )}

        <div className="doc-aff__board" data-testid="doc-aff-board">
          <Column
            tone="todo"
            title="To do"
            count={open.length}
            loading={loading && rows === null}
            rows={open.map((r) => ({
              id: r.appointment_id,
              tz: tzForRow(r),
              branch: maskedBranch(r.branch_id),
              typeId: r.appointment_type_id,
              start: r.start_datetime,
              end: r.end_datetime,
              reason: r.reason,
              patientLabel: patientLabelFromPhone(r.patient_phone),
              maskedPhone: maskPhone(r.patient_phone),
            }))}
            renderAction={(row) => (
              <>
                <button
                  type="button"
                  className="doc-aff__card-btn doc-aff__card-btn--primary"
                  data-testid={`doc-aff-card-${row.id}-move-btn`}
                  onClick={() => onMove(row.id)}
                >
                  Move →
                </button>
                <button
                  type="button"
                  className="doc-aff__card-btn doc-aff__card-btn--danger"
                  data-testid={`doc-aff-card-${row.id}-cancel-btn`}
                  onClick={() => onOpenCancel(row.id)}
                >
                  Cancel
                </button>
                {(() => {
                  const r = rowById(row.id);
                  return r !== null && isPastRow(r) ? (
                    <button
                      type="button"
                      className="doc-aff__card-btn"
                      data-testid={`doc-aff-card-${row.id}-mark-btn`}
                      onClick={() => onOpenMark(row.id)}
                    >
                      Mark status
                    </button>
                  ) : null;
                })()}
              </>
            )}
          />
          <Column
            tone="doing"
            title="In progress"
            count={inProgressId !== null ? 1 : 0}
            loading={false}
            rows={(() => {
              if (inProgressId === null) return [];
              const target = open.find((r) => r.appointment_id === inProgressId);
              if (!target) return [];
              return [
                {
                  id: target.appointment_id,
                  tz: tzForRow(target),
                  branch: maskedBranch(target.branch_id),
                  typeId: target.appointment_type_id,
                  start: target.start_datetime,
                  end: target.end_datetime,
                  reason: target.reason,
                  patientLabel: patientLabelFromPhone(target.patient_phone),
                  maskedPhone: maskPhone(target.patient_phone),
                },
              ];
            })()}
            renderAction={(row) => (
              <>
                <button
                  type="button"
                  className="doc-aff__card-btn doc-aff__card-btn--primary"
                  data-testid={`doc-aff-card-${row.id}-continue-btn`}
                  onClick={() => onMove(row.id)}
                >
                  Continue →
                </button>
                <button
                  type="button"
                  className="doc-aff__card-btn doc-aff__card-btn--danger"
                  data-testid={`doc-aff-card-${row.id}-cancel-btn`}
                  onClick={() => onOpenCancel(row.id)}
                >
                  Cancel
                </button>
                {(() => {
                  const r = rowById(row.id);
                  return r !== null && isPastRow(r) ? (
                    <button
                      type="button"
                      className="doc-aff__card-btn"
                      data-testid={`doc-aff-card-${row.id}-mark-btn`}
                      onClick={() => onOpenMark(row.id)}
                    >
                      Mark status
                    </button>
                  ) : null;
                })()}
              </>
            )}
            active
          />
          <Column
            tone="scheduling"
            title="Awaiting slot choice"
            count={0}
            loading={false}
            rows={[]}
            emptyMessage="No appointments waiting for a new slot."
          />
          <Column
            tone="done"
            title="Resolved"
            count={resolved.length}
            loading={false}
            rows={resolved.map((r) => ({
              id: r.appointment_id,
              tz: r.tz,
              branch: r.branchName,
              typeId: r.appointment_type_id,
              start: r.toStart,
              end: r.toEnd,
              fromStart: r.fromStart,
              patientLabel: patientLabelFromPhone(r.patient_phone),
              maskedPhone: maskPhone(r.patient_phone),
              resolved: true,
            }))}
          />
        </div>

        {onGoSchedule && (
          <div className="doc-aff__footer" data-testid="doc-aff-footer">
            <button
              type="button"
              className="doc-aff__ghost"
              data-testid="doc-aff-schedule-btn"
              onClick={onGoSchedule}
            >
              ← Schedule editor
            </button>
          </div>
        )}
      </div>

      {moveId !== null && rows !== null && (() => {
        const target = rows.find((r) => r.appointment_id === moveId);
        if (!target) return null;
        return (
          <DoctorResolve
            appointment={{
              id: target.appointment_id,
              patient_phone: target.patient_phone,
              patientLabel: patientLabelFromPhone(target.patient_phone),
              maskedPhone: maskPhone(target.patient_phone),
              branch_id: target.branch_id,
              branchName: maskedBranch(target.branch_id),
              branchTz: tzForRow(target),
              appointment_type_id: target.appointment_type_id,
              start_datetime: target.start_datetime,
              end_datetime: target.end_datetime,
              reason: target.reason,
            }}
            onCancel={onCancelResolve}
            onMoved={async (info) => {
              onResolved(info);
              await refreshAfter();
            }}
            describeError={describeMoveError}
          />
        );
      })()}

      {completionModal && (
        <DoctorResolutionSaved
          info={completionModal}
          remaining={open.length - 1}
          recent={completionAudit}
          onClose={() => setCompletionModal(null)}
          onResolveAnother={() => {
            setCompletionModal(null);
          }}
        />
      )}

      {cancelId !== null && rowById(cancelId) !== null && (() => {
        const target = rowById(cancelId);
        if (target === null) return null;
        return (
          <DoctorCancel
            appointment={{
              id: target.appointment_id,
              branchTz: tzForRow(target),
              start_datetime: target.start_datetime,
              end_datetime: target.end_datetime,
              patientLabel: patientLabelFromPhone(target.patient_phone),
              maskedPhone: maskPhone(target.patient_phone),
              branchName: maskedBranch(target.branch_id),
            }}
            onCancel={onCloseCancel}
            onCancelled={onCancelled}
            onStale={onCancelStale}
            describeError={describeCancelError}
          />
        );
      })()}

      {markId !== null && rowById(markId) !== null && (() => {
        const target = rowById(markId);
        if (target === null) return null;
        return (
          <DoctorMarkStatus
            appointment={{
              id: target.appointment_id,
              branchTz: tzForRow(target),
              start_datetime: target.start_datetime,
              end_datetime: target.end_datetime,
              patientLabel: patientLabelFromPhone(target.patient_phone),
              maskedPhone: maskPhone(target.patient_phone),
              branchName: maskedBranch(target.branch_id),
              createdAt: target.created_at,
            }}
            onCancel={onCloseMark}
            onMarked={onMarked}
            onStale={onMarkStale}
            describeError={describeMarkError}
          />
        );
      })()}
    </DoctorFrame>
  );
}

interface ColumnRow {
  id: string;
  tz: string;
  branch: string;
  typeId: string;
  start: string;
  end: string;
  fromStart?: string;
  reason?: string;
  patientLabel?: string;
  maskedPhone: string;
  /** When the appointment was booked (ISO UTC) — the REAL booking age. */
  createdAt?: string;
  resolved?: boolean;
}

interface ColumnProps {
  tone: 'todo' | 'doing' | 'scheduling' | 'done';
  title: string;
  count: number;
  rows: ColumnRow[];
  loading?: boolean;
  active?: boolean;
  emptyMessage?: string;
  renderAction?: (row: ColumnRow) => React.ReactNode;
}

function Column({
  tone,
  title,
  count,
  rows,
  loading,
  active,
  emptyMessage,
  renderAction,
}: ColumnProps) {
  return (
    <div className={`doc-aff__col doc-aff__col--${tone}`} data-testid={`doc-aff-col-${tone}`}>
      <div className="doc-aff__col-head" data-testid={`doc-aff-col-${tone}-head`}>
        <div className="doc-aff__col-title">{title}</div>
        <div className="doc-aff__col-count" data-testid={`doc-aff-col-${tone}-count`}>{count}</div>
      </div>
      <div className="doc-aff__col-body" data-testid={`doc-aff-col-${tone}-body`}>
        {loading && <div className="doc-aff__empty">Loading…</div>}
        {!loading && rows.length === 0 && (
          <div className="doc-aff__empty">
            {emptyMessage ?? 'No appointments in this column.'}
          </div>
        )}
        {rows.map((r) => {
          const isActive = active === true;
          const startTime = formatTimeInTz(r.start, r.tz);
          const endTime = formatTimeInTz(r.end, r.tz);
          const startDay = formatDateInTz(r.start, r.tz);
          const startMD = formatMonthDay(r.start, r.tz);
          const issue = r.reason
            ? r.reason === 'closed_day'
              ? 'Outside new branch operating hours (closed day).'
              : 'Outside new branch operating hours.'
            : r.fromStart
              ? `Moved from ${formatDateInTz(r.fromStart, r.tz)} → ${startMD} · ${startTime}`
              : 'Moved by doctor.';
          return (
            <div
              key={r.id}
              className={
                'doc-aff__card' +
                (isActive ? ' doc-aff__card--active' : '') +
                (r.resolved ? ' doc-aff__card--resolved' : '')
              }
              data-testid={`doc-aff-card-${r.id}`}
            >
              <div className="doc-aff__card-patient">
                {r.patientLabel ?? 'Patient'}
              </div>
              <div className="doc-aff__card-time">
                {startDay} · {startTime} – {endTime}
              </div>
              <div className="doc-aff__card-where">
                {r.branch} · {r.maskedPhone}
              </div>
              <div
                className={
                  r.resolved ? 'doc-aff__card-issue doc-aff__card-issue--done' : 'doc-aff__card-issue'
                }
              >
                {issue}
              </div>
              {renderAction && (
                <div className="doc-aff__card-actions" data-testid={`doc-aff-card-${r.id}-actions`}>
                  {renderAction(r)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}