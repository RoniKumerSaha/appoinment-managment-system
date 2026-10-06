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
  listPublicBranches,
  type DoctorAffectedAppointment,
  type PublicBranchDto,
} from '../api/client';
import { useAuth } from '../auth/store';
import { DoctorFrame } from './DoctorFrame';
import { DoctorResolve } from './DoctorResolve';
import { DoctorResolutionSaved } from './DoctorResolutionSaved';
import {
  formatDateInTz,
  formatMonthDay,
  formatTimeInTz,
  maskPhone,
  patientLabelFromPhone,
} from './doctor-utils';
import './DoctorAffected.module.css';

interface DoctorAffectedProps {
  onGoSchedule?: () => void;
}

interface CompletedMove {
  appointment_id: string;
  patient_phone: string;
  appointment_type_id: string;
  branch_id: string;
  from_start: string;
  to_start: string;
  to_end: string;
  branchName: string;
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
    }
  );

  const refreshAfter = useCallback(async (): Promise<void> => {
    await refresh();
  }, [refresh]);

  // Masked branch id fallback.
  const maskedBranch = (id: string): string => {
    const b = branches.get(id);
    if (b) return b.name;
    return `Branch ··${id.slice(-4)}`;
  };

  const tzForRow = (row: DoctorAffectedAppointment): string => {
    const b = branches.get(row.branch_id);
    return b?.tz ?? 'UTC';
  };

  // Display rows that should appear in "To do" / "In progress" /
  // "Awaiting slot choice" / "Resolved". Resolved rows are
  // session-local; we only show the most recent one in the
  // success modal, but the column still renders the full list.
  const open = useMemo(() => {
    if (rows === null) return [] as DoctorAffectedAppointment[];
    return rows;
  }, [rows]);

  return (
    <DoctorFrame>
      <div className="doc-aff__page">
        <div className="doc-aff__alert">
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
            <div className="doc-aff__alert-stats">
              <span className="doc-aff__pill doc-aff__pill--todo">
                <span className="doc-aff__pill-dot" /> {open.length} to do
              </span>
              {inProgressId !== null && (
                <span className="doc-aff__pill doc-aff__pill--doing">
                  <span className="doc-aff__pill-dot" /> 1 in progress
                </span>
              )}
              {resolved.length > 0 && (
                <span className="doc-aff__pill doc-aff__pill--done">
                  <span className="doc-aff__pill-dot" /> {resolved.length} resolved
                </span>
              )}
            </div>
          )}
        </div>

        <div className="doc-aff__header">
          <h1 className="doc-aff__title">Resolve affected appointments</h1>
          <p className="doc-aff__sub">
            Move each patient to a new slot, or cancel. Each row lists an
            appointment outside the current branch operating hours.
          </p>
        </div>

        {err && <div className="doc-aff__error">{err}</div>}
        {toast && <div className="doc-aff__toast">{toast}</div>}

        <div className="doc-aff__board">
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
              <button
                type="button"
                className="doc-aff__card-btn"
                onClick={() => onMove(row.id)}
              >
                Move →
              </button>
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
              <button
                type="button"
                className="doc-aff__card-btn"
                onClick={() => onMove(row.id)}
              >
                Continue →
              </button>
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
              tz: branches.get(r.branch_id)?.tz ?? 'UTC',
              branch: r.branchName,
              typeId: r.appointment_type_id,
              start: r.toStart,
              end: r.toEnd,
              fromStart: r.fromStart,
              maskedPhone: maskPhone(r.patient_phone),
              resolved: true,
            }))}
            renderAction={() => null}
          />
        </div>

        {onGoSchedule && (
          <div className="doc-aff__footer">
            <button
              type="button"
              className="doc-aff__ghost"
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
          onClose={() => setCompletionModal(null)}
          onResolveAnother={() => {
            setCompletionModal(null);
          }}
        />
      )}
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
    <div className={`doc-aff__col doc-aff__col--${tone}`}>
      <div className="doc-aff__col-head">
        <div className="doc-aff__col-title">{title}</div>
        <div className="doc-aff__col-count">{count}</div>
      </div>
      <div className="doc-aff__col-body">
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
              {!r.resolved && renderAction && (
                <div className="doc-aff__card-actions">
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