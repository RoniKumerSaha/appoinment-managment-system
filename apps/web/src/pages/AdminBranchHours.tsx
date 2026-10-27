/**
 * Admin Branch Hours page — `/admin/branch-hours/:branchId`.
 *
 * Pixel-perfect port of mockup 28
 * (docs/design/mockups/v1/mockups/28-admin-branch-hours-editor.html).
 * The page is reached from AdminBranches via an "Edit hours" link on
 * the step-2 foot.
 *
 * Three steps on a 980px frame (mockup 28 line 11):
 *   - Step 1: branch context (read-only summary card)
 *   - Step 2: weekly hours editor (7 rows × open/close/toggle)
 *   - Step 3: save & preview impact
 *
 * After the user clicks "Save & preview impact", the page calls
 * `POST /admin/branches/:id/hours` and renders a fourth step card
 * inline (replaces mockup 39's resolution page — live resolution
 * tracking ships with E6-S2 #16). The 409 path opens a side-by-side
 * resolution flow (mockup 28's "5 appointments will be flagged" → the
 * actual impact count + affected-doctor list + an "Acknowledge & save"
 * button when `requires_doctor_acknowledgement: true`).
 *
 * The page is unreachable from the top nav; it lives one level below
 * AdminBranches. The AppShell's `active` stays on "branches" while this
 * page renders.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ApiError,
  getBranchHours,
  getBranch,
  patchBranchHours,
  type AffectedAppointment,
  type AffectedDoctor,
  type BranchDto,
  type HoursImpactSummary,
  type HoursRow,
} from '../api/client';
import styles from './AdminBranchHours.module.css';

const DAY_LABELS: Record<number, string> = {
  0: 'Sun',
  1: 'Mon',
  2: 'Tue',
  3: 'Wed',
  4: 'Thu',
  5: 'Fri',
  6: 'Sat',
};

const DEFAULT_DAY: HoursRow = {
  day_of_week: 0,
  open_time: '09:00',
  close_time: '17:00',
  is_closed: false,
};

interface FormError {
  status: number;
  code: string;
  message: string;
}

function describeApiError(err: unknown): FormError {
  if (err instanceof ApiError) {
    let message = err.code;
    if (err.code === 'invalid_branch_id') {
      message = 'Invalid branch id.';
    } else if (err.code === 'branch_not_found') {
      message = 'That branch no longer exists.';
    } else if (err.code === 'invalid_hours_length') {
      message = 'Hours must cover all 7 days.';
    } else if (err.code === 'invalid_day_of_week') {
      message = 'Day-of-week must be 0..6 with each day present exactly once.';
    } else if (err.code === 'invalid_time_range') {
      message = 'Open time must be earlier than close time on an open day.';
    } else if (err.code === 'invalid_timezone') {
      message = 'Timezone is not a valid IANA name.';
    } else if (err.code === 'no_fields_to_update') {
      message = 'Nothing to save.';
    } else if (err.code === 'unknown_field') {
      message = 'Unsupported field sent to the API.';
    } else if (
      err.code === 'appointments_outside_hours' ||
      err.status === 409
    ) {
      message = 'Saving would flag future appointments outside the new window.';
    } else if (err.status === 0 || err.code === 'network_error') {
      message = 'Connection failed. Is the API running on :3001?';
    } else if (err.status >= 500) {
      message = 'Server error. Try again in a moment.';
    }
    return { status: err.status, code: err.code, message };
  }
  return { status: 0, code: 'unknown_error', message: 'Unknown error.' };
}

function hhmm(s: string | null | undefined): string {
  if (typeof s !== 'string') return '09:00';
  // The API may return HH:MM:SS (Postgres time) — strip the seconds.
  return s.length >= 5 ? s.slice(0, 5) : s;
}

function buildDefaultHours(): HoursRow[] {
  return Array.from({ length: 7 }, (_, i) => ({
    ...DEFAULT_DAY,
    day_of_week: i,
  }));
}

function rowsEqual(a: HoursRow, b: HoursRow): boolean {
  if (a.is_closed !== b.is_closed) return false;
  if (a.is_closed) return true;
  return hhmm(a.open_time) === hhmm(b.open_time) && hhmm(a.close_time) === hhmm(b.close_time);
}

function totalHoursThisWeek(rows: HoursRow[]): number {
  let total = 0;
  for (const r of rows) {
    if (r.is_closed) continue;
    const o = hhmm(r.open_time);
    const c = hhmm(r.close_time);
    const [oh, om] = o.split(':').map(Number);
    const [ch, cm] = c.split(':').map(Number);
    if (
      typeof oh !== 'number' ||
      typeof om !== 'number' ||
      typeof ch !== 'number' ||
      typeof cm !== 'number'
    ) {
      continue;
    }
    const minutes = (ch ?? 0) * 60 + (cm ?? 0) - ((oh ?? 0) * 60 + (om ?? 0));
    if (minutes > 0) total += minutes / 60;
  }
  return total;
}

function formatAppointmentLine(a: AffectedAppointment): string {
  const start = new Date(a.start_datetime);
  const end = new Date(a.end_datetime);
  const fmt = (d: Date): string => {
    if (Number.isNaN(d.getTime())) return '—';
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const min = String(d.getUTCMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
  };
  const reason =
    a.reason === 'closed_day' ? 'closed day' : 'before open / after close';
  return `${fmt(start)}–${fmt(end)} UTC · ${reason}`;
}

interface AdminBranchHoursProps {
  branchId: string;
  onBackToBranches: () => void;
}

export function AdminBranchHours({
  branchId,
  onBackToBranches,
}: AdminBranchHoursProps) {
  const [branch, setBranch] = useState<BranchDto | null>(null);
  const [originalAddress, setOriginalAddress] = useState<string | null>(null);
  const [originalTz, setOriginalTz] = useState<string>('');
  const [original, setOriginal] = useState<HoursRow[]>([]);
  const [edit, setEdit] = useState<HoursRow[]>([]);
  const [address, setAddress] = useState<string>('');
  const [tz, setTz] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<FormError | null>(null);
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState<FormError | null>(null);
  const [impact, setImpact] = useState<HoursImpactSummary | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [impactExpanded, setImpactExpanded] = useState(false);

  // Initial load — fetch branch metadata + current hours in parallel.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadErr(null);
    setImpact(null);
    setSavedAt(null);
    Promise.all([getBranch(branchId), getBranchHours(branchId)])
      .then(([b, h]) => {
        if (cancelled) return;
        setBranch(b);
        setOriginalAddress(h.address);
        setAddress(h.address ?? '');
        setOriginalTz(h.tz);
        setTz(h.tz);
        // The GET path returns `[]` for a fresh branch; build the default
        // 7-row set so the editor is always renderable.
        const initial =
          h.hours.length === 7
            ? h.hours
            : buildDefaultHours();
        setOriginal(initial);
        setEdit(initial.map((r) => ({ ...r })));
      })
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
  }, [branchId]);

  // Compute the dirty-set for visual highlighting (mockup 28 line 166-170).
  const dirty = useMemo(() => {
    const set = new Set<number>();
    for (const r of edit) {
      const orig = original.find((o) => o.day_of_week === r.day_of_week);
      if (orig && !rowsEqual(orig, r)) {
        set.add(r.day_of_week);
      }
    }
    return set;
  }, [edit, original]);

  const totalHours = useMemo(() => totalHoursThisWeek(edit), [edit]);

  const isDirty = dirty.size > 0 || (originalAddress ?? null) !== (address || null);
  const ack = impact?.requires_doctor_acknowledgement === true;

  const updateRow = useCallback(
    (day: number, patch: Partial<HoursRow>) => {
      setEdit((rows) =>
        rows.map((r) => (r.day_of_week === day ? { ...r, ...patch } : r)),
      );
    },
    [],
  );

  const onToggleClosed = useCallback(
    (day: number) => {
      setEdit((rows) =>
        rows.map((r) => {
          if (r.day_of_week !== day) return r;
          if (r.is_closed) {
            return { ...r, is_closed: false };
          }
          return {
            ...r,
            is_closed: true,
            open_time: null,
            close_time: null,
          };
        }),
      );
    },
    [],
  );

  const onDiscard = useCallback(() => {
    setEdit(original.map((r) => ({ ...r })));
    setFormErr(null);
    setImpact(null);
  }, [original]);

  const onSave = useCallback(
    async (acknowledge: boolean) => {
      setFormErr(null);
      setBusy(true);
      try {
        // Build the hours body, normalising HH:MM:SS to HH:MM.
        const hoursBody: HoursRow[] = edit.map((r) => ({
          day_of_week: r.day_of_week,
          open_time: r.is_closed ? null : hhmm(r.open_time),
          close_time: r.is_closed ? null : hhmm(r.close_time),
          is_closed: r.is_closed,
        }));
        const body: {
          hours: HoursRow[];
          address?: string | null;
          tz?: string;
        } = { hours: hoursBody };
        const trimmedAddress = address.trim();
        if ((originalAddress ?? null) !== (trimmedAddress || null)) {
          body.address = trimmedAddress === '' ? null : trimmedAddress;
        }
        // The timezone is editable on this screen and is part of what the
        // hours are interpreted in — a timezone change silently changes
        // every slot's wall-clock meaning, so it is sent alongside the
        // hours rather than left as a local-only field.
        const trimmedTz = tz.trim();
        if (trimmedTz !== originalTz) {
          body.tz = trimmedTz;
        }
        const resp = await patchBranchHours(branchId, body, acknowledge);
        // Refresh local state from the canonical response.
        setOriginal(resp.hours.map((r) => ({ ...r })));
        setEdit(resp.hours.map((r) => ({ ...r })));
        setOriginalAddress(resp.branch.address);
        setAddress(resp.branch.address ?? '');
        setOriginalTz(resp.branch.tz);
        setTz(resp.branch.tz);
        setImpact({
          count_affected: resp.impact.count_affected,
          affected_doctors: [],
          requires_doctor_acknowledgement:
            resp.impact.requires_doctor_acknowledgement,
        });
        if (branch) {
          setBranch({
            ...branch,
            updated_at: resp.branch.updated_at,
          });
        }
        setSavedAt(new Date().toISOString());
        if (resp.impact.count_affected === 0) {
          setImpactExpanded(false);
        }
      } catch (caught) {
        if (
          caught instanceof ApiError &&
          caught.status === 409 &&
          caught.code === 'appointments_outside_hours'
        ) {
          // The PATCH-409 envelope includes an `impact` object with
          // counts + affected_doctors + ack flag. Affected-list is only
          // present on the preview path; for the PATCH-409 path we
          // surface what the server gave us.
          const impact = caught.body['impact'];
          if (impact && typeof impact === 'object') {
            setImpact(impact as HoursImpactSummary);
            setImpactExpanded(true);
            return;
          }
        }
        setFormErr(describeApiError(caught));
      } finally {
        setBusy(false);
      }
    },
    [edit, address, tz, branchId, branch, originalAddress, originalTz],
  );

  if (loading) {
    return (
      <div className={styles['page']}>
        <p className={styles['sub']}>Loading branch hours…</p>
      </div>
    );
  }

  if (loadErr) {
    return (
      <div className={styles['page']}>
        <header className={styles['page-header']}>
          <div className={styles['page-header__left']}>
            <div className={styles['crumb']}>Admin &rarr; Branches &rarr; Hours</div>
            <h1>Edit operating hours</h1>
          </div>
          <button
            type="button"
            className={styles['back-link']}
            onClick={onBackToBranches}
          >
            &larr; Back to branches
          </button>
        </header>
        <div className={styles['error-banner']} role="alert">
          <strong>{loadErr.code}:</strong> {loadErr.message}
        </div>
      </div>
    );
  }

  return (
    <div className={styles['page']}>
      <header className={styles['page-header']}>
        <div className={styles['page-header__left']}>
          <div className={styles['crumb']}>
            Admin &rarr; Branches &rarr; {branch?.name ?? 'Branch'} &rarr; Hours
          </div>
          <h1>Edit operating hours</h1>
          <p className={styles['sub']}>
            Changes flag future appointments that fall outside new hours.
            Status is preserved; doctors see a Resolve badge.
          </p>
        </div>
        <button
          type="button"
          className={styles['back-link']}
          onClick={onBackToBranches}
        >
          &larr; Back to branches
        </button>
      </header>

      {/* ─── Step 1: branch context ──────────────────────────── */}
      <section className={styles['step']}>
        <div className={styles['step-head']}>
          <div
            className={`${styles['step-num']} ${styles['step-num--done']}`}
          >
            1
          </div>
          <div className={styles['step-title']}>Branch &amp; effective date</div>
          <div className={styles['step-hint']}>{branch?.name ?? '—'}</div>
        </div>
        <div className={styles['picker-row']}>
          <div className={styles['picker']}>
            <div className={styles['picker__label']}>Branch</div>
            <div className={styles['picker__value']}>{branch?.name ?? '—'}</div>
            <div className={styles['picker__lock']}>
              {branch?.active ? 'Active' : 'Inactive'} ·{' '}
              {/* doctor + future-appt counts deferred to E1-S3 + E3-S1 */}
              hours-only edit
            </div>
          </div>
          <div className={styles['picker']}>
            <div className={styles['picker__label']}>Address</div>
            <input
              className={styles['picker__input']}
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              maxLength={500}
              placeholder="Optional · e.g. King Fahd Rd, Olaya District"
              disabled={busy}
            />
            <div className={styles['picker__lock']}>
              Street address (max 500 chars). Optional.
            </div>
          </div>
        </div>
        <div className={styles['picker-row']}>
          <div className={styles['picker']}>
            <div className={styles['picker__label']}>Timezone (IANA)</div>
            <input
              className={styles['picker__input']}
              type="text"
              value={tz}
              onChange={(e) => setTz(e.target.value)}
              disabled={busy}
              placeholder="e.g. Asia/Riyadh"
            />
            <div className={styles['picker__lock']}>
              Hours are wall-clock; interpret in this zone.
            </div>
          </div>
          <div className={styles['picker']}>
            <div className={styles['picker__label']}>Effective from</div>
            <div className={styles['picker__value']}>
              {savedAt
                ? new Date(savedAt).toUTCString().slice(0, 16)
                : 'On save'}
            </div>
            <div className={styles['picker__lock']}>
              Hours take effect on save; existing future appointments are
              preserved (status unchanged).
            </div>
          </div>
        </div>
      </section>

      {/* ─── Step 2: weekly hours ─────────────────────────────── */}
      <section className={styles['step']}>
        <div className={styles['step-head']}>
          <div
            className={`${styles['step-num']} ${styles['step-num--current']}`}
          >
            2
          </div>
          <div className={styles['step-title']}>Weekly hours</div>
          <div className={styles['step-hint']}>
            Click toggle to enable / disable a day
          </div>
        </div>
        <table className={styles['hours-table']}>
          <thead>
            <tr>
              <th>Day</th>
              <th>Open</th>
              <th>Close</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {edit.map((r) => {
              const isChanged = dirty.has(r.day_of_week);
              const rowCls = isChanged
                ? `${styles['changed']}`
                : r.is_closed
                  ? `${styles['off']}`
                  : '';
              return (
                <tr key={r.day_of_week} className={rowCls}>
                  <td className={styles['day']}>
                    {DAY_LABELS[r.day_of_week] ?? '?'}
                  </td>
                  <td>
                    <input
                      type="time"
                      value={hhmm(r.open_time)}
                      onChange={(e) =>
                        updateRow(r.day_of_week, { open_time: e.target.value })
                      }
                      disabled={busy || r.is_closed}
                    />
                  </td>
                  <td>
                    <span className={styles['sep']}>–</span>
                    <input
                      type="time"
                      value={hhmm(r.close_time)}
                      onChange={(e) =>
                        updateRow(r.day_of_week, { close_time: e.target.value })
                      }
                      disabled={busy || r.is_closed}
                    />
                  </td>
                  <td>
                    <label
                      className={
                        r.is_closed
                          ? styles['toggle']
                          : `${styles['toggle']} ${styles['toggle--on']}`
                      }
                    >
                      <input
                        type="checkbox"
                        checked={!r.is_closed}
                        onChange={() => onToggleClosed(r.day_of_week)}
                        disabled={busy}
                      />
                      <span className={styles['switch']} aria-hidden="true" />
                      {r.is_closed ? 'Closed' : 'Open'}
                    </label>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className={styles['summary-bar']}>
          <span className={styles['item']}>
            <strong>Total:</strong> {totalHours.toFixed(1)}h / week
          </span>
          <span className={styles['sep']}>·</span>
          <span className={styles['item']}>
            <strong>Open days:</strong>{' '}
            {edit.filter((r) => !r.is_closed).length} / 7
          </span>
          <span className={styles['sep']}>·</span>
          <span className={styles['item']}>
            <strong>Effective:</strong>{' '}
            {savedAt ? new Date(savedAt).toUTCString().slice(0, 16) : 'On save'}
          </span>
        </div>
      </section>

      {/* ─── Step 3: save & preview impact ───────────────────── */}
      <section className={styles['step']}>
        <div className={styles['step-head']}>
          <div
            className={
              savedAt
                ? `${styles['step-num']} ${styles['step-num--done']}`
                : `${styles['step-num']} ${styles['step-num--future']}`
            }
          >
            3
          </div>
          <div className={styles['step-title']}>Save &amp; preview impact</div>
          <div className={styles['step-hint']}>
            {isDirty ? 'Unsaved changes' : 'No pending changes'}
          </div>
        </div>
        <p className={styles['lead']}>
          Saving updates the branch&apos; weekly hours. Future appointments
          that fall outside the new window are flagged (status preserved);
          doctors see a Resolve badge on their own dashboard.
        </p>
        {formErr && (
          <div className={styles['error-banner']} role="alert">
            <strong>{formErr.code}:</strong> {formErr.message}
          </div>
        )}
        <div className={styles['step-foot']}>
          <span className={styles['audit']}>
            Audit row preview: <code>branch.hours_changed</code>, actor=admin,
            metadata={'{sat: 09–13}'}
          </span>
          <div className={styles['btn-group']}>
            <button
              type="button"
              className={styles['btn-ghost']}
              onClick={onDiscard}
              disabled={busy || !isDirty}
            >
              Discard changes
            </button>
            <button
              type="button"
              className={styles['btn-primary']}
              onClick={() => onSave(false)}
              disabled={busy || !isDirty}
            >
              {busy ? 'Saving…' : 'Save & preview impact →'}
            </button>
          </div>
        </div>
      </section>

      {/* ─── Step 4: impact preview (inline) ──────────────────── */}
      {impact && (
        <section className={styles['step']}>
          <div className={styles['step-head']}>
            <div
              className={
                impact.count_affected === 0
                  ? `${styles['step-num']} ${styles['step-num--done']}`
                  : `${styles['step-num']} ${styles['step-num--current']}`
              }
            >
              4
            </div>
            <div className={styles['step-title']}>Impact preview</div>
            <div className={styles['step-hint']}>
              {impact.count_affected === 0
                ? 'No appointments affected'
                : `${impact.count_affected} appointment${
                    impact.count_affected === 1 ? '' : 's'
                  } flagged`}
            </div>
          </div>

          {impact.count_affected === 0 ? (
            <p className={styles['lead']}>
              No future appointments fall outside the new window. Saved.
            </p>
          ) : (
            <>
              <div className={styles['impact-summary']}>
                <div
                  className={
                    impact.count_affected > 0
                      ? `${styles['impact-tile']} ${styles['impact-tile--warn']}`
                      : styles['impact-tile']
                  }
                >
                  <div className={styles['impact-tile__label']}>
                    Flagged (count only)
                  </div>
                  <div className={styles['impact-tile__value']}>
                    {impact.count_affected}
                  </div>
                </div>
                <div className={styles['impact-tile']}>
                  <div className={styles['impact-tile__label']}>
                    Doctor acknowledgement
                  </div>
                  <div className={styles['impact-tile__value']}>
                    {ack ? 'Required' : 'Not required'}
                  </div>
                </div>
              </div>

              {impact.affected_doctors.length > 0 && (
                <div className={styles['impact-doctors']}>
                  <div className={styles['impact-doctors__head']}>
                    Affected doctors (counts only · BR-065)
                  </div>
                  <ul className={styles['impact-doctors__list']}>
                    {impact.affected_doctors.map((d: AffectedDoctor) => (
                      <li
                        key={d.doctor_id}
                        className={styles['impact-doctors__row']}
                      >
                        <span className={styles['name']}>{d.doctor_name}</span>
                        <span className={styles['count']}>{d.count}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {impact.affected && impact.affected.length > 0 && (
                <div className={styles['impact-affected']}>
                  Affected appointments ({impact.affected.length}):
                  <ul>
                    {impact.affected.map(
                      (a: AffectedAppointment) => (
                        <li key={a.appointment_id}>
                          {formatAppointmentLine(a)}
                        </li>
                      ),
                    )}
                  </ul>
                </div>
              )}

              {ack && (
                <div className={styles['step-foot']}>
                  <span className={styles['audit']}>
                    Doctor-not-at-branch: re-PATCH with{' '}
                    <code>acknowledge_doctor_impact=true</code> to commit.
                  </span>
                  <div className={styles['btn-group']}>
                    <button
                      type="button"
                      className={styles['btn-ghost']}
                      onClick={onDiscard}
                      disabled={busy}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className={styles['btn-primary']}
                      onClick={() => onSave(true)}
                      disabled={busy}
                    >
                      {busy ? 'Acknowledging…' : 'Acknowledge & save'}
                    </button>
                  </div>
                </div>
              )}

              {impactExpanded && impact.affected === undefined && (
                <p className={styles['lead']}>
                  Detailed appointment list available via the impact preview
                  endpoint; this pass shows counts + doctor breakdown per the
                  privacy rule.
                </p>
              )}
            </>
          )}

          <div className={styles['privacy-note']}>
            <span aria-hidden="true">ℹ</span>
            <span>
              <strong>Privacy (BR-065):</strong> the impact preview returns
              counts and doctor-level aggregates only — never patient names,
              phone numbers, or appointment reasons. Status is preserved;
              the affected appointments stay <code>Scheduled</code> until a
              doctor or receptionist resolves them.
            </span>
          </div>
        </section>
      )}
    </div>
  );
}