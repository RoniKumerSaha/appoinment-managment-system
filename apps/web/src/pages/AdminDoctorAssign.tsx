/**
 * Admin Doctor Assign (Reassign branches) sub-page — under
 * `/admin/doctors` (reached via the "Assign" button on a doctor card).
 *
 * Pixel-perfect port of mockup 31
 * (docs/design/mockups/v1/mockups/31-admin-doctors-reassign.html). Driven
 * by the E1-S3 API surface: `GET /admin/doctors/:id` to load the
 * doctor, `PUT /admin/doctors/:id/branches` to commit the new branch
 * set.
 *
 * Layout (mockup 31-A):
 *   - 980px-wide frame (mockup 31 line 11) — narrower than the card
 *     grid's 1300px because this is a focused editor.
 *   - Breadcrumb: "Admin → Doctors → {full_name} → Reassign branches"
 *   - H1 "Reassign branches" + subline about BR-002 single-clinic lock
 *   - "← Back to doctors" ghost button
 *   - Three step cards on the page:
 *     - **Step 1** — Doctor: read-only doctor card with avatar + name
 *       + email + status pill.
 *     - **Step 2** — Clinic & branch assignment: clinic picker (locked
 *       🔒, BR-002 single-clinic) + "Effective" picker (read-only
 *       "Immediately") + multi-select branch checkbox grid (the bulk
 *       of the page). The grid mirrors the mockup 31 lines 134-162
 *       rows: each row has a checkbox + branch name + meta line.
 *     - **Step 3** — Save & audit: lead paragraph + Discard / Save
 *       buttons. Foot: "Audit row preview: doctor.branches_changed,
 *       actor=admin, metadata={added: [...]}" (mockup 31 line 184
 *       verbatim). Real audit row writes are deferred to E7.
 *
 * Clinic + effective picker rows are display-only (the single-clinic
 * anchor is implicit per E1-S0a). The page is reduced to: pick branches
 * + save.
 *
 * The page is reached from the "Assign" button on each card in
 * `AdminDoctors.tsx`. The "← Back to doctors" button returns to the
 * card grid. App.tsx carries an `AdminSubPage` state
 * (`{key: 'doctor-assign', doctorId}`) layered on top of the existing
 * `AdminSection` state; the AppShell's `active` stays on "doctors" so
 * the nav still highlights Doctors.
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
  listBranches,
  putDoctorBranches,
  type BranchDto,
  type DoctorWithBranchesDto,
} from '../api/client';
import styles from './AdminDoctorAssign.module.css';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface FormError {
  status: number;
  code: string;
  message: string;
}

function describeApiError(err: unknown): FormError {
  if (err instanceof ApiError) {
    let message = err.code;
    if (err.code === 'invalid_branch_ids') {
      message = 'One or more branch ids are not valid UUIDs.';
    } else if (err.code === 'invalid_branch_id') {
      message = 'A branch id in the list is not a valid UUID.';
    } else if (err.code === 'branch_not_found') {
      message = 'One or more branches no longer exist.';
    } else if (err.code === 'doctor_not_found') {
      message = 'That doctor no longer exists.';
    } else if (
      err.code === 'doctor_must_work_at_least_one_branch'
    ) {
      message = 'A doctor must work at least one branch.';
    } else if (err.code === 'unknown_field') {
      message = 'Unsupported field sent to the API.';
    } else if (err.status === 0 || err.code === 'network_error') {
      message = 'Connection failed. Is the API running on :3001?';
    } else if (err.status >= 500) {
      message = 'Server error. Try again in a moment.';
    }
    return { status: err.status, code: err.code, message };
  }
  return { status: 0, code: 'unknown_error', message: 'Unknown error.' };
}

function initialsOf(fullName: string): string {
  const stripped = fullName.replace(/^Dr\.?\s+/i, '');
  const parts = stripped.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? '' : '';
  return (first + last).toUpperCase() || '??';
}

function isoToDateLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function AdminDoctorAssign({
  doctorId,
  onBackToDoctors,
}: {
  doctorId: string;
  onBackToDoctors: () => void;
}) {
  const [doctor, setDoctor] = useState<DoctorWithBranchesDto | null>(null);
  const [branches, setBranches] = useState<BranchDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<FormError | null>(null);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState<FormError | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  // Initial load.
  const reload = useCallback(async (): Promise<void> => {
    const [doc, br] = await Promise.all([
      getDoctor(doctorId),
      listBranches(),
    ]);
    setDoctor(doc);
    setBranches(br);
    setSelectedIds(new Set(doc.branches.map((b) => b.id)));
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

  // Stable sort by name.
  const sortedBranches = useMemo(
    () => [...branches].sort((a, b) => a.name.localeCompare(b.name)),
    [branches],
  );

  const originalIds = useMemo(
    () => new Set(doctor?.branches.map((b) => b.id) ?? []),
    [doctor],
  );

  // Diff for the audit-row preview + summary line.
  const diff = useMemo(() => {
    const added: string[] = [];
    const removed: string[] = [];
    for (const id of selectedIds) {
      if (!originalIds.has(id)) added.push(id);
    }
    for (const id of originalIds) {
      if (!selectedIds.has(id)) removed.push(id);
    }
    return { added, removed };
  }, [selectedIds, originalIds]);

  const onToggleBranch = useCallback(
    (id: string) => {
      if (busy) return;
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
        return next;
      });
    },
    [busy],
  );

  const onDiscard = useCallback(() => {
    if (busy) return;
    setSelectedIds(new Set(originalIds));
    setFormErr(null);
  }, [busy, originalIds]);

  const onSave = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setFormErr(null);
      const branchIds = Array.from(selectedIds);
      if (branchIds.length === 0) {
        setFormErr({
          status: 400,
          code: 'doctor_must_work_at_least_one_branch',
          message: 'A doctor must work at least one branch.',
        });
        return;
      }
      for (const id of branchIds) {
        if (!UUID_RE.test(id)) {
          setFormErr({
            status: 400,
            code: 'invalid_branch_ids',
            message: 'A branch id is not a valid UUID.',
          });
          return;
        }
      }
      setBusy(true);
      try {
        await putDoctorBranches(doctorId, branchIds);
        // Reload the doctor so `branches` is the new canonical set.
        await reload();
        setSavedAt(new Date().toISOString());
      } catch (caught) {
        setFormErr(describeApiError(caught));
      } finally {
        setBusy(false);
      }
    },
    [doctorId, selectedIds, reload],
  );

  if (loading) {
    return (
      <div className={styles['page']}>
        <p className={styles['sub']}>Loading doctor…</p>
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

  return (
    <div className={styles['page']}>
      <header className={styles['page-header']}>
        <div className={styles['crumb']}>
          Admin &rarr; Doctors &rarr; {doctor.full_name} &rarr; Reassign
          branches
        </div>
        <div className={styles['page-header__row']}>
          <div>
            <h1>Reassign branches</h1>
            <p className={styles['sub']}>
              Doctors can work at multiple branches within one clinic.
              Clinic assignment is locked (BR-002).
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

      {/* ─── Step 1: Doctor ───────────────────────────────────── */}
      <section className={styles['step']}>
        <div className={styles['step-head']}>
          <div className={`${styles['step-num']} ${styles['step-num--done']}`}>
            1
          </div>
          <div className={styles['step-title']}>Doctor</div>
          <div className={styles['step-hint']}>
            Joined {isoToDateLabel(doctor.created_at)}
          </div>
        </div>
        <div className={styles['doctor-card']}>
          <div className={styles['av']} aria-hidden="true">
            {initialsOf(doctor.full_name)}
          </div>
          <div className={styles['doctor-card__body']}>
            <div className={styles['doctor-card__name']}>
              {doctor.full_name}
              {doctor.active ? (
                <span className={styles['pill-active']}>Active</span>
              ) : (
                <span className={styles['pill-inactive']}>Inactive</span>
              )}
            </div>
            <div className={styles['doctor-card__meta']}>{doctor.email}</div>
          </div>
        </div>
      </section>

      {/* ─── Step 2: Clinic + branch assignment ───────────────── */}
      <section className={styles['step']}>
        <div className={styles['step-head']}>
          <div
            className={`${styles['step-num']} ${styles['step-num--current']}`}
          >
            2
          </div>
          <div className={styles['step-title']}>
            Clinic &amp; branch assignment
          </div>
          <div className={styles['step-hint']}>
            {selectedIds.size} of {branches.length} branches selected
          </div>
        </div>

        <div className={styles['picker-row']}>
          <div className={`${styles['picker']} ${styles['picker--locked']}`}>
            <div className={styles['picker__label']}>Clinic</div>
            <div className={styles['picker__value']}>MediSlot Riyadh</div>
            <div className={styles['picker__lock']}>
              🔒 Single-clinic rule (BR-002)
            </div>
          </div>
          <div className={styles['picker']}>
            <div className={styles['picker__label']}>Effective</div>
            <div className={styles['picker__value']}>Immediately</div>
            <div className={styles['picker__lock']}>
              No future-dated branch changes in MVP
            </div>
          </div>
        </div>

        <div className={styles['branches']}>
          {sortedBranches.length === 0 && (
            <div className={styles['branch-empty']}>
              No branches yet — create one first.
            </div>
          )}
          {sortedBranches.map((b) => {
            const checked = selectedIds.has(b.id);
            return (
              <label
                key={b.id}
                className={
                  checked
                    ? `${styles['branch-row']} ${styles['branch-row--selected']}`
                    : styles['branch-row']
                }
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggleBranch(b.id)}
                  disabled={busy}
                />
                <div
                  className={styles['branch-row__check']}
                  aria-hidden="true"
                >
                  {checked ? '✓' : ''}
                </div>
                <div className={styles['branch-row__body']}>
                  <div className={styles['branch-row__name']}>{b.name}</div>
                  <div className={styles['branch-row__meta']}>
                    {b.active ? '' : 'Inactive · '}
                    {/* Doctor / future-appointment counts are deferred
                        to E2 / E3 stories that own the appointment
                        queries. Today the meta line only shows
                        activity status. */}
                  </div>
                </div>
              </label>
            );
          })}
        </div>

        <div className={styles['summary']}>
          <span className={styles['summary__item']}>
            <strong>{selectedIds.size}</strong> branch
            {selectedIds.size === 1 ? '' : 'es'} assigned
          </span>
          {diff.added.length > 0 && (
            <>
              <span className={styles['summary__sep']}>·</span>
              <span className={styles['summary__item']}>
                <strong>+{diff.added.length}</strong> added
              </span>
            </>
          )}
          {diff.removed.length > 0 && (
            <>
              <span className={styles['summary__sep']}>·</span>
              <span className={styles['summary__item']}>
                <strong>&minus;{diff.removed.length}</strong> removed
              </span>
            </>
          )}
          {savedAt && (
            <>
              <span className={styles['summary__sep']}>·</span>
              <span className={styles['summary__item']}>
                Saved {isoToDateLabel(savedAt)}
              </span>
            </>
          )}
        </div>

        {(diff.added.length > 0 || diff.removed.length > 0) && (
          <div className={styles['impact']}>
            <span className={styles['impact__icon']} aria-hidden="true">
              ⚠
            </span>
            <span>
              <strong>Temporary assignment:</strong> branches changed
              take effect immediately. Future appointments at removed
              branches stay Scheduled — the doctor&rsquo;s kanban (E6)
              handles the resolution queue.
            </span>
          </div>
        )}
      </section>

      {/* ─── Step 3: Save & audit ────────────────────────────── */}
      <form className={styles['step']} onSubmit={onSave} noValidate>
        <div className={styles['step-head']}>
          <div className={styles['step-title']}>Save &amp; audit</div>
        </div>

        <p className={styles['lead']}>
          Saving replaces the doctor&rsquo;s branch set in full. The
          change is recorded as <code>doctor.branches_changed</code> in
          the audit log with the diff above.
        </p>

        {formErr && (
          <div className={styles['error-banner']} role="alert">
            <strong>{formErr.code}:</strong> {formErr.message}
          </div>
        )}

        <div className={styles['step-foot']}>
          <div className={styles['audit']}>
            Audit row preview: <code>
              doctor.branches_changed, actor=admin, metadata=
              {'{'}added: [
              {diff.added.length > 0
                ? diff.added
                    .map(
                      (id) =>
                        branches.find((b) => b.id === id)?.name ??
                        id.slice(0, 8),
                    )
                    .join(', ')
                : '—'}
              ], removed: [
              {diff.removed.length > 0
                ? diff.removed
                    .map(
                      (id) =>
                        branches.find((b) => b.id === id)?.name ??
                        id.slice(0, 8),
                    )
                    .join(', ')
                : '—'}
              ]{'}'}
            </code>
          </div>
          <div className={styles['btn-group']}>
            <button
              type="button"
              className={styles['btn-ghost']}
              onClick={onDiscard}
              disabled={
                busy ||
                (selectedIds.size === originalIds.size &&
                  Array.from(selectedIds).every((id) => originalIds.has(id)))
              }
            >
              Discard changes
            </button>
            <button
              type="submit"
              className={styles['btn-primary']}
              disabled={
                busy ||
                selectedIds.size === 0 ||
                (selectedIds.size === originalIds.size &&
                  Array.from(selectedIds).every((id) => originalIds.has(id)))
              }
            >
              {busy ? 'Saving…' : `Save · ${selectedIds.size} branch${selectedIds.size === 1 ? '' : 'es'}`}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}