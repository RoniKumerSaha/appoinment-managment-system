/**
 * DoctorAppointmentTypes — the doctor's view of the appointment
 * catalogue (`#/doctor?page=types`).
 *
 * `docs/design/user-flows/doctor.md` Act 1 lists "Appointment types"
 * as a DOCTOR section, and mockup 11 is the design for it. The only
 * implementation was `AdminAppointmentTypes` — an admin page at
 * `#/admin/types`, backed by `/admin/appointment-types` (gated by
 * `adminScope`). The doctor's own surfaces only ever referenced a
 * type by id:
 *
 *   - The recurring-series form pulled ids from the staff catalogue
 *     and rendered them in a `<select>`.
 *   - The affected queue showed a bare type id on each card.
 *
 * So a doctor could book a recurring series but had no way to see
 * what the clinic actually offers — no name, no duration, no
 * description.
 *
 * This page closes that gap. It is a READ-ONLY catalogue: creating,
 * renaming and deactivating a type is a clinic-wide administrative
 * act (it changes what every branch and every doctor can book), so
 * the doctor sees the list and the admin keeps the editor. The list
 * itself comes from `GET /staff-catalog/appointment-types`, which
 * every authenticated caller can read, so no new API route is
 * needed.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ApiError,
  listStaffAppointmentTypes,
  type AppointmentTypeDto,
} from '../api/client';
import { DoctorFrame } from './DoctorFrame';
import './DoctorAppointmentTypes.css';

/** "45 min" / "1h 30m" */
function durationLabel(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '—';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return 'Session expired. Please sign in again.';
    if (err.status === 403) return 'You do not have access to this view.';
    return `Could not load the appointment types (${err.code}).`;
  }
  if (err instanceof TypeError) {
    return 'Connection failed. Is the API running on :3001?';
  }
  return 'Could not load the appointment types.';
}

export function DoctorAppointmentTypes({
  activeNav,
}: {
  activeNav?: string;
}) {
  const [types, setTypes] = useState<AppointmentTypeDto[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setErr(null);
    try {
      const list = await listStaffAppointmentTypes();
      setTypes(list);
      setLoading(false);
    } catch (e: unknown) {
      setErr(describeError(e));
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const visible = useMemo(() => {
    if (types === null) return [];
    return showInactive ? types : types.filter((t) => t.is_active);
  }, [types, showInactive]);

  const inactiveCount =
    types === null ? 0 : types.filter((t) => !t.is_active).length;

  return (
    <DoctorFrame activeNav={activeNav}>
      <div className="doc-types__page" data-testid="doc-types">
        <header className="doc-types__header">
          <div>
            <h1 className="doc-types__title">Appointment types</h1>
            <p className="doc-types__sub">
              The consultations the clinic offers. These are the types you
              can book for your patients.
            </p>
          </div>
        </header>

        <div className="doc-types__toolbar">
          <label className="doc-types__toggle">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              aria-label="Show inactive types"
            />
            <span>
              Show inactive
              {inactiveCount > 0 ? ` (${inactiveCount})` : ''}
            </span>
          </label>
        </div>

        {err && (
          <div className="doc-types__error" data-testid="doc-types-error" role="alert">
            {err}
          </div>
        )}

        {loading && types === null && (
          <div className="doc-types__loading">Loading appointment types…</div>
        )}

        {!loading && types !== null && visible.length === 0 && (
          <div className="doc-types__empty" data-testid="doc-types-empty">
            No appointment types are available right now.
          </div>
        )}

        <div className="doc-types__list" data-testid="doc-types-list">
          {visible.map((t) => (
            <div
              key={t.id}
              className={
                t.is_active
                  ? 'doc-types__row'
                  : 'doc-types__row doc-types__row--dim'
              }
              data-testid={`doc-types-row-${t.id}`}
            >
              <div className="doc-types__row-main">
                <div className="doc-types__row-name">{t.name}</div>
                {t.description && (
                  <div className="doc-types__row-desc">{t.description}</div>
                )}
              </div>
              <div className="doc-types__row-duration">
                {durationLabel(t.duration_minutes)}
              </div>
              <div>
                <span
                  className={
                    t.is_active
                      ? 'doc-types__pill doc-types__pill--active'
                      : 'doc-types__pill doc-types__pill--inactive'
                  }
                >
                  {t.is_active ? '● Active' : '○ Inactive'}
                </span>
              </div>
            </div>
          ))}
        </div>

        <p className="doc-types__foot">
          Adding, renaming or retiring an appointment type is a clinic-wide
          change — ask an administrator if you need a new one.
        </p>
      </div>
    </DoctorFrame>
  );
}
