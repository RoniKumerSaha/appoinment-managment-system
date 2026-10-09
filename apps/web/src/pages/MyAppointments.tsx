/**
 * MyAppointments — E4-S1 / E4-S2 / E4-S3 / E4-S4 UI.
 *
 * Patient self-service hub (mockup 05 post-OTP state, mock 22 cancel
 * modal, mock 20 reschedule). The patient has already verified
 * their phone via W10 (the OTP step in mockup 05 is therefore
 * skipped — the page lands directly on the upcoming-appointments
 * list).
 *
 *  - E4-S1 — `GET /patient/appointments` lists the verified
 *    patient's future Scheduled rows. The phone is bound from
 *    `req.auth.claim.sub`; the response never carries
 *    `patient_name` (E7-S3 — the patient IS the patient).
 *  - E4-S2 — Cancel is a modal (mock 22). The cancel button
 *    doesn't navigate; the modal opens, the user confirms,
 *    POST /patient/appointments/:id/cancel fires, the list
 *    refetches.
 *  - E4-S3 — Reschedule is a full-page stacked-vertical flow
 *    (mock 20). The doctor is locked (FR-040, BR-042); branch,
 *    type, date, and time can change (FR-041). The new slot's
 *    duration MUST equal the appointment type's
 *    `duration_minutes` (E4-S3 hard-codes
 *    `new_slot_duration_minutes = apptType.duration_minutes`).
 *  - E4-S4 — Deep-link landing. The `useEffect` reads the URL
 *    query (`?action=cancel|reschedule&id=...`) and pre-opens
 *    the matching modal/page. (The router doesn't exist yet —
 *    we read `window.location.search` and patch the URL with
 *    `history.replaceState` after handling the link, so the
 *    back button doesn't re-trigger.)
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ApiError,
  getPatientDeepLink,
  listPatientAppointments,
  listPublicBranches,
  listPublicAppointmentTypes,
  listPublicDoctors,
  type PatientAppointmentDto,
  type PublicAppointmentTypeDto,
  type PublicBranchDto,
  type PublicDoctorDto,
} from '../api/client';
import { PatientFrame } from './PatientFrame';
import { CancelModal } from './CancelModal';
import { ReschedulePage } from './ReschedulePage';
import { useAuth } from '../auth/store';
import './MyAppointments.css';

interface MyAppointmentsProps {
  initialAction?: 'cancel' | 'reschedule';
  initialAppointmentId?: string;
  onGoFindDoctor: () => void;
}

interface AppointmentDisplay extends PatientAppointmentDto {
  doctorName: string;
  branchName: string;
  typeName: string;
  typeDuration: number;
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return 'Session expired. Please sign in again.';
    if (err.status === 403) return 'You do not have access to this view.';
    return `Could not load your appointments (${err.code}).`;
  }
  if (err instanceof TypeError) {
    return 'Connection failed. Is the API running on :3001?';
  }
  return 'Could not load your appointments.';
}

function dateBlockParts(
  iso: string,
): { month: string; day: string; dow: string } {
  const d = new Date(iso);
  const month = d.toLocaleDateString('en-US', {
    month: 'short',
    timeZone: 'UTC',
  });
  const day = String(d.getUTCDate());
  const dow = d.toLocaleDateString('en-US', {
    weekday: 'short',
    timeZone: 'UTC',
  });
  return { month, day, dow };
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

export function MyAppointments({
  initialAction,
  initialAppointmentId,
  onGoFindDoctor,
}: MyAppointmentsProps) {
  const { stored } = useAuth();
  const profile = stored?.profile ?? null;
  // Verified recap card — mockup 05. Falls back to a phone-tail label
  // when the profile hasn't carried a name yet (new patients).
  const verifiedLabel = profile
    ? profile.full_name ?? `Patient …${profile.email.slice(-5)}`
    : null;
  const verifiedInitials = profile
    ? profile.full_name
      ? profile.full_name
          .split(/\s+/)
          .slice(0, 2)
          .map((p) => p[0]?.toUpperCase() ?? '')
          .join('')
      : profile.email.slice(0, 2).toUpperCase()
    : '··';

  const [appts, setAppts] = useState<PatientAppointmentDto[] | null>(null);
  const [doctors, setDoctors] = useState<Map<string, PublicDoctorDto>>(
    () => new Map(),
  );
  const [branches, setBranches] = useState<Map<string, PublicBranchDto>>(
    () => new Map(),
  );
  const [types, setTypes] = useState<Map<string, PublicAppointmentTypeDto>>(
    () => new Map(),
  );
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);

  // Modals / pages
  const [cancelId, setCancelId] = useState<string | null>(null);
  const [rescheduleId, setRescheduleId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setErr(null);
    try {
      const [list, docs, typesRes] = await Promise.all([
        listPatientAppointments(),
        listPublicDoctors(),
        listPublicAppointmentTypes(),
      ]);
      setAppts(list.appointments);
      setDoctors(new Map(docs.doctors.map((d) => [d.id, d])));
      setTypes(
        new Map(
          typesRes.appointment_types.map((t) => [t.id, t]),
        ),
      );
      // Load branches for any doctor the patient has an appointment
      // with. We can't `listPublicBranches()` without a doctor_id,
      // so we do one call per distinct doctor.
      const doctorIds = Array.from(
        new Set(list.appointments.map((a) => a.doctor_id)),
      );
      const branchResults = await Promise.all(
        doctorIds.map((id) => listPublicBranches(id)),
      );
      const branchMap = new Map<string, PublicBranchDto>();
      for (const r of branchResults) {
        for (const b of r.branches) {
          if (!branchMap.has(b.id)) branchMap.set(b.id, b);
        }
      }
      setBranches(branchMap);
      setLoading(false);
    } catch (e: unknown) {
      setErr(describeError(e));
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // E4-S4 deep-link landing. If we got a deep-link target, probe it
  // and pre-open the matching surface. After handling, scrub the URL.
  useEffect(() => {
    if (!initialAction || !initialAppointmentId) return;
    let cancelled = false;
    (async () => {
      try {
        const link = await getPatientDeepLink(initialAppointmentId);
        if (cancelled) return;
        if (initialAction === 'cancel' && link.can_cancel) {
          setCancelId(initialAppointmentId);
        } else if (initialAction === 'reschedule' && link.can_reschedule) {
          setRescheduleId(initialAppointmentId);
        } else {
          setToast(
            link.can_cancel || link.can_reschedule
              ? 'That action is not available for this appointment.'
              : 'This appointment can no longer be changed.',
          );
        }
      } catch {
        if (!cancelled) {
          setToast('We could not find that appointment.');
        }
      } finally {
        if (!cancelled) {
          try {
            window.history.replaceState(
              {},
              '',
              window.location.pathname,
            );
          } catch {
            // ignore
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initialAction, initialAppointmentId]);

  // Map raw appointments to a denormalised display shape.
  const display: AppointmentDisplay[] = useMemo(() => {
    if (appts === null) return [];
    return appts.map((a) => {
      const doc = doctors.get(a.doctor_id);
      const br = branches.get(a.branch_id);
      const t = types.get(a.appointment_type_id);
      return {
        ...a,
        doctorName: doc ? doc.full_name : 'Doctor',
        branchName: br ? br.name : 'Branch',
        typeName: t ? t.name : 'Appointment',
        typeDuration: t ? t.duration_minutes : 0,
      };
    });
  }, [appts, doctors, branches, types]);

  const onCancelDone = useCallback(
    async (id: string): Promise<void> => {
      setCancelId(null);
      setToast('Your appointment has been cancelled. The slot is released.');
      window.setTimeout(() => setToast(null), 4000);
      await refresh();
    },
    [refresh],
  );

  const onRescheduleDone = useCallback(
    async (id: string): Promise<void> => {
      setRescheduleId(null);
      setToast('Your appointment has been moved.');
      window.setTimeout(() => setToast(null), 4000);
      await refresh();
    },
    [refresh],
  );

  const rescheduleTarget = useMemo(() => {
    if (rescheduleId === null) return null;
    return display.find((a) => a.id === rescheduleId) ?? null;
  }, [rescheduleId, display]);

  const cancelTarget = useMemo(() => {
    if (cancelId === null) return null;
    return display.find((a) => a.id === cancelId) ?? null;
  }, [cancelId, display]);

  return (
    <PatientFrame
      activeLink="my-appointments"
      onNavigate={(l) => {
        if (l === 'find-doctor') onGoFindDoctor();
      }}
      userName={profile?.full_name ?? undefined}
    >
      <div className="my-appts__page">
        <div className="my-appts__header">
          <div className="my-appts__crumb">My appointments</div>
          <h1 className="my-appts__title">Manage your appointments</h1>
          <p className="my-appts__sub">
            Review what you've booked. Reschedule or cancel below.
          </p>
        </div>

        {profile && verifiedLabel && (
          <div className="my-appts__verified">
            <div className="my-appts__verified-avatar" aria-hidden="true">
              {verifiedInitials}
            </div>
            <div className="my-appts__verified-body">
              <div className="my-appts__verified-line">
                <span className="my-appts__verified-badge">
                  <span aria-hidden="true">✓</span> You're verified
                </span>
                <span className="my-appts__verified-name">
                  {verifiedLabel}
                </span>
              </div>
              <div className="my-appts__verified-phone">
                Signed in as <code>{profile.email}</code>
              </div>
            </div>
          </div>
        )}

        <div className="my-appts__quicklinks">
          <button
            type="button"
            className="my-appts__quicklink"
            onClick={onGoFindDoctor}
          >
            Book another appointment
          </button>
          <button
            type="button"
            className="my-appts__recurring-chip"
            disabled
            title="Recurring series — coming with E4-S2"
          >
            Recurring series
          </button>
        </div>

        {err && <div className="my-appts__error">{err}</div>}
        {toast && <div className="my-appts__toast">{toast}</div>}

        <section className="my-appts__section">
          <div className="my-appts__section-head">
            <div className="my-appts__section-num">
              {display.length > 0 ? display.length : '–'}
            </div>
            <div className="my-appts__section-titles">
              <div className="my-appts__section-title">
                Upcoming appointments
              </div>
              <div className="my-appts__section-sub">
                {loading && appts === null
                  ? 'Loading…'
                  : display.length === 0
                    ? 'You have no upcoming appointments.'
                    : `${display.length} appointment${display.length === 1 ? '' : 's'} on file`}
              </div>
            </div>
          </div>
          <div className="my-appts__section-body">
            {!loading && appts !== null && display.length === 0 && (
              <div className="my-appts__empty">
                <p>You have no upcoming appointments.</p>
                <button
                  type="button"
                  className="my-appts__primary-btn"
                  onClick={onGoFindDoctor}
                >
                  Book an appointment
                </button>
              </div>
            )}
            {display.map((a) => {
              const db = dateBlockParts(a.start_datetime);
              return (
                <div key={a.id} className="my-appts__row">
                  <div className="my-appts__date-block">
                    <div className="my-appts__date-month">
                      {db.month}
                    </div>
                    <div className="my-appts__date-day">{db.day}</div>
                    <div className="my-appts__date-dow">{db.dow}</div>
                  </div>
                  <div className="my-appts__row-body">
                    <div className="my-appts__row-doctor">
                      Dr. {a.doctorName} · {a.typeName}
                    </div>
                    <div className="my-appts__row-meta">
                      {a.branchName} · {formatTime(a.start_datetime)} –{' '}
                      {formatTime(a.end_datetime)}
                      {a.typeDuration > 0
                        ? ` · ${a.typeDuration}m`
                        : ''}
                    </div>
                  </div>
                  <div className="my-appts__row-actions">
                    <button
                      type="button"
                      className="my-appts__action"
                      onClick={() => setRescheduleId(a.id)}
                    >
                      Reschedule
                    </button>
                    <button
                      type="button"
                      className="my-appts__action my-appts__action--danger"
                      onClick={() => setCancelId(a.id)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>

      {cancelTarget && (
        <CancelModal
          appointmentId={cancelTarget.id}
          doctorName={cancelTarget.doctorName}
          branchName={cancelTarget.branchName}
          typeName={cancelTarget.typeName}
          startDatetime={cancelTarget.start_datetime}
          endDatetime={cancelTarget.end_datetime}
          tz={cancelTarget.tz}
          onClose={() => setCancelId(null)}
          onDone={onCancelDone}
        />
      )}

      {rescheduleTarget && (
        <ReschedulePage
          appointment={rescheduleTarget}
          onClose={() => setRescheduleId(null)}
          onDone={onRescheduleDone}
        />
      )}

      <div className="my-appts__help-strip">
        <strong>Trouble verifying?</strong> We can text you a fresh code — call the
        clinic at <a href="tel:+966114558900">+966 11 455 8900</a>.
      </div>
    </PatientFrame>
  );
}
