/**
 * Admin Doctors page — `/admin/doctors`.
 *
 * Pixel-perfect port of mockup 18
 * (docs/design/mockups/v1/mockups/18-admin-doctors.html). Driven by
 * the E1-S3 API surface: `GET/POST /admin/doctors`,
 * `GET/PATCH /admin/doctors/:id`, `PUT /admin/doctors/:id/branches`.
 *
 * Layout (mockup 18-B):
 *   - Header (crumb + H1 + subline: "X active · Y inactive · assigned
 *     across N branches")
 *   - Cross-links: Branches / Receptionists / Branch hours impact
 *     (placeholders, deferred)
 *   - Filter bar: search input + All / Active / Inactive segmented
 *     toggle + All-branches select
 *   - Card grid: `repeat(auto-fill, minmax(310px, 1fr))`. Each card
 *     shows: avatar (initials, smaller 44px vs receptionists' 48px),
 *     name + email, Active/Inactive pill, "Branches" label + branch
 *     chips (multi-branch), 2-cell stats grid (Future appts + Specialty
 *     — both placeholders for E1-S3-ui), and three action buttons
 *     (Edit / Assign / Deactivate). Inactive cards are grey.
 *   - "+ Add" card at the end of the grid.
 *
 * Doctors can work at multiple branches within the singleton clinic
 * (BR-002 single-clinic anchor + multi-branch via doctor_branch). The
 * "Branches" section on each card shows one chip per assigned branch;
 * the "+ N more" overflow is rendered when there are more than 3.
 *
 * F-18 (mirrors F-19): deactivating a doctor does NOT 409 even when
 * they have future Scheduled appointments — the PATCH response carries
 * `warning: 'doctor_has_future_appointments'` +
 * `future_appointment_count: N`. The page surfaces this warning as a
 * post-save banner (success colour) instead of a blocking modal. Same
 * pattern as E1-S4-ui.
 *
 * The "Assign" button on each card opens the
 * `<AdminDoctorAssign doctorId onBackToDoctors />` sub-page (mockup 31,
 * shipped in this story as a sibling page). The "Edit" button opens an
 * in-page modal that supports rename + status toggle (no branch
 * reassignment — that's the Assign page's job). The "+ Add" card opens
 * a Create modal that includes the branch multi-select.
 *
 * No tests in this pass (per user instruction).
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  ApiError,
  createDoctor,
  listBranches,
  listDoctors,
  patchDoctor,
  type BranchDto,
  type DoctorPatchResponse,
  type DoctorWithBranchesDto,
} from '../api/client';
import styles from './AdminDoctors.module.css';

const NAME_MAX = 120;
const EMAIL_MAX = 254;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type FilterMode = 'all' | 'active' | 'inactive';
type Mode = 'closed' | 'create' | 'edit';

interface FormError {
  status: number;
  code: string;
  message: string;
}

interface Warning {
  code: 'doctor_has_future_appointments';
  future_appointment_count: number;
  full_name: string;
}

function describeApiError(err: unknown): FormError {
  if (err instanceof ApiError) {
    let message = err.code;
    if (err.code === 'invalid_full_name') {
      message = `Full name is required and must be 1..${NAME_MAX} characters.`;
    } else if (err.code === 'invalid_email') {
      message = `Email must be a valid address (3..${EMAIL_MAX} characters).`;
    } else if (err.code === 'invalid_branch_ids') {
      message =
        'At least one branch is required and each id must be a valid UUID.';
    } else if (err.code === 'invalid_branch_id') {
      message = 'A branch id in the list is not a valid UUID.';
    } else if (err.code === 'invalid_active') {
      message = 'Status must be Active or Inactive.';
    } else if (err.code === 'branch_not_found') {
      message = 'One or more branches no longer exist.';
    } else if (err.code === 'doctor_not_found') {
      message = 'That doctor no longer exists.';
    } else if (err.code === 'email_already_exists') {
      message =
        'A doctor with that email already exists. Edit them instead.';
    } else if (
      err.code === 'doctor_must_work_at_least_one_branch'
    ) {
      message = 'A doctor must work at least one branch.';
    } else if (err.code === 'no_fields_to_update') {
      message = 'Nothing to save.';
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
  // Strip the "Dr. " prefix for the avatar so the initials line up with
  // the displayed name (mockup 18 cards show "Dr. Ahmed Al-Rashid" with
  // initials "AR"). The helper below handles the "Dr." prefix as
  // ignorable so we don't end up with "DA" instead of "AR".
  const stripped = fullName.replace(/^Dr\.?\s+/i, '');
  const parts = stripped.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? '' : '';
  return (first + last).toUpperCase() || '??';
}

function isValidEmailClient(s: string): boolean {
  return (
    s.length >= 3 &&
    s.length <= EMAIL_MAX &&
    EMAIL_RE.test(s)
  );
}

function isValidUuidClient(s: string): boolean {
  return UUID_RE.test(s);
}

export function AdminDoctors({
  onOpenDoctorAssign,
  onOpenDoctorSchedule,
  onOpenDoctorBlocks,
}: {
  onOpenDoctorAssign?: (doctorId: string) => void;
  onOpenDoctorSchedule?: (doctorId: string) => void;
  onOpenDoctorBlocks?: (doctorId: string) => void;
}) {
  const [doctors, setDoctors] = useState<DoctorWithBranchesDto[]>([]);
  const [branches, setBranches] = useState<BranchDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<FormError | null>(null);

  // Filters
  const [search, setSearch] = useState('');
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [filterBranchId, setFilterBranchId] = useState<string>('');

  // Modal state
  const [mode, setMode] = useState<Mode>('closed');
  const [editId, setEditId] = useState<string | null>(null);
  const [editFullName, setEditFullName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editBranchIds, setEditBranchIds] = useState<string[]>([]);
  const [editActive, setEditActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState<FormError | null>(null);

  // Post-deactivate warning banner (F-18 — non-blocking).
  const [warning, setWarning] = useState<Warning | null>(null);

  const modalRef = useRef<HTMLDivElement | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    const [doc, br] = await Promise.all([listDoctors(), listBranches()]);
    setDoctors(doc);
    setBranches(br);
  }, []);

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

  // Counts for the subline.
  const counts = useMemo(() => {
    let active = 0;
    let inactive = 0;
    for (const d of doctors) {
      if (d.active) active += 1;
      else inactive += 1;
    }
    const distinctBranchIds = new Set<string>();
    for (const d of doctors) {
      for (const b of d.branches) distinctBranchIds.add(b.id);
    }
    return {
      active,
      inactive,
      total: active + inactive,
      branchCount: distinctBranchIds.size,
    };
  }, [doctors]);

  // Filtered + searched view.
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return doctors.filter((d) => {
      if (filterMode === 'active' && !d.active) return false;
      if (filterMode === 'inactive' && d.active) return false;
      if (
        filterBranchId &&
        !d.branches.some((b) => b.id === filterBranchId)
      ) {
        return false;
      }
      if (q.length > 0) {
        const haystack = `${d.full_name} ${d.email}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [doctors, search, filterMode, filterBranchId]);

  const segCounts = useMemo(() => {
    let active = 0;
    let inactive = 0;
    for (const d of doctors) {
      if (d.active) active += 1;
      else inactive += 1;
    }
    return { all: doctors.length, active, inactive };
  }, [doctors]);

  const branchOptions = useMemo(() => {
    return [...branches].sort((a, b) => a.name.localeCompare(b.name));
  }, [branches]);

  // ─── Modal open / close ───────────────────────────────────────
  const onOpenCreate = useCallback(() => {
    setMode('create');
    setEditId(null);
    setEditFullName('');
    setEditEmail('');
    setEditBranchIds(branches[0]?.id ? [branches[0].id] : []);
    setEditActive(true);
    setFormErr(null);
  }, [branches]);

  const onOpenEdit = useCallback((d: DoctorWithBranchesDto) => {
    setMode('edit');
    setEditId(d.id);
    setEditFullName(d.full_name);
    setEditEmail(d.email);
    setEditBranchIds(d.branches.map((b) => b.id));
    setEditActive(d.active);
    setFormErr(null);
  }, []);

  const onCloseModal = useCallback(() => {
    if (busy) return;
    setMode('closed');
    setFormErr(null);
  }, [busy]);

  useEffect(() => {
    if (mode === 'closed') return;
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') onCloseModal();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mode, onCloseModal]);

  // Toggle a branch id in the create/edit modal's checkbox list.
  const onToggleBranch = useCallback(
    (branchId: string) => {
      if (busy) return;
      setEditBranchIds((prev) => {
        if (prev.includes(branchId)) {
          return prev.filter((x) => x !== branchId);
        }
        return [...prev, branchId];
      });
    },
    [busy],
  );

  // ─── Submit (create + edit) ───────────────────────────────────
  const onSubmit = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setFormErr(null);

      const fullName = editFullName.trim();
      const email = editEmail.trim().toLowerCase();
      const branchIds = editBranchIds;

      if (fullName.length < 1 || fullName.length > NAME_MAX) {
        setFormErr({
          status: 400,
          code: 'invalid_full_name',
          message: `Full name is required and must be 1..${NAME_MAX} characters.`,
        });
        return;
      }
      if (!isValidEmailClient(email)) {
        setFormErr({
          status: 400,
          code: 'invalid_email',
          message: `Email must be a valid address (3..${EMAIL_MAX} characters).`,
        });
        return;
      }
      if (branchIds.length === 0) {
        setFormErr({
          status: 400,
          code: 'invalid_branch_ids',
          message: 'A doctor must work at least one branch.',
        });
        return;
      }
      for (const bid of branchIds) {
        if (!isValidUuidClient(bid)) {
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
        if (mode === 'create') {
          await createDoctor({ full_name: fullName, email, branch_ids: branchIds });
          await reload();
          setMode('closed');
          return;
        }
        // mode === 'edit'
        if (!editId) return;
        const original = doctors.find((d) => d.id === editId);
        if (!original) {
          setFormErr(
            describeApiError(new ApiError(404, 'doctor_not_found')),
          );
          return;
        }
        // PATCH: full_name + active only. The branch list is managed
        // via the dedicated Assign page (PUT /branches). Edit modal
        // does NOT touch branch_ids.
        const patch: { full_name?: string; active?: boolean } = {};
        if (fullName !== original.full_name) patch.full_name = fullName;
        if (editActive !== original.active) patch.active = editActive;
        let resp: DoctorPatchResponse | null = null;
        if (Object.keys(patch).length > 0) {
          resp = await patchDoctor(editId, patch);
        }
        // If branches were re-selected in the modal (Create-only flow
        // would have used POST; in Edit the branch checkbox list is
        // presentational, so we don't PUT on edit). The Edit modal
        // intentionally hides the branch checkbox grid — see comment
        // in the render block below.
        await reload();
        setMode('closed');
        if (
          resp &&
          resp.warning === 'doctor_has_future_appointments' &&
          (resp.future_appointment_count ?? 0) > 0
        ) {
          setWarning({
            code: 'doctor_has_future_appointments',
            future_appointment_count: resp.future_appointment_count ?? 0,
            full_name: resp.full_name,
          });
        }
      } catch (caught) {
        setFormErr(describeApiError(caught));
      } finally {
        setBusy(false);
      }
    },
    [
      editFullName,
      editEmail,
      editBranchIds,
      editActive,
      mode,
      editId,
      doctors,
      reload,
    ],
  );

  const onDeactivate = useCallback(
    async (d: DoctorWithBranchesDto) => {
      if (d.active === false) return;
      setBusy(true);
      setFormErr(null);
      try {
        const resp = await patchDoctor(d.id, { active: false });
        await reload();
        if (
          resp.warning === 'doctor_has_future_appointments' &&
          (resp.future_appointment_count ?? 0) > 0
        ) {
          setWarning({
            code: 'doctor_has_future_appointments',
            future_appointment_count: resp.future_appointment_count ?? 0,
            full_name: resp.full_name,
          });
        }
      } catch (caught) {
        setFormErr(describeApiError(caught));
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );

  const onReactivate = useCallback(
    async (d: DoctorWithBranchesDto) => {
      if (d.active === true) return;
      setBusy(true);
      setFormErr(null);
      try {
        await patchDoctor(d.id, { active: true });
        await reload();
      } catch (caught) {
        setFormErr(describeApiError(caught));
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );

  // One-shot PUT-branches from the card foot's "Assign" button. The
  // full reassign-branches flow lives in AdminDoctorAssign — this
  // path is a no-op fallback (the button on each card opens the
  // dedicated sub-page; see render block).
  // The render wires the card's "Assign" button to onOpenDoctorAssign
  // when provided; the inline toggle is intentionally absent so we
  // don't ship two parallel flows.

  const onScrimClick = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement> | React.MouseEvent<HTMLDivElement>) => {
      if (e.target === modalRef.current) onCloseModal();
    },
    [onCloseModal],
  );

  if (loading) {
    return (
      <div className={styles['page']}>
        <p className={styles['sub']}>Loading doctors…</p>
      </div>
    );
  }

  if (loadErr) {
    return (
      <div className={styles['page']}>
        <h1>Doctors</h1>
        <div className={styles['error-banner']} role="alert">
          <strong>{loadErr.code}:</strong> {loadErr.message}
        </div>
      </div>
    );
  }

  return (
    <div className={styles['page']}>
      <header className={styles['page-header']}>
        <div className={styles['crumb']}>Admin &rarr; Doctors</div>
        <h1>Doctors</h1>
        <p className={styles['sub']}>
          {counts.active} active
          {counts.inactive > 0 ? ` · ${counts.inactive} inactive` : ''}
          {' · '}
          assigned across {counts.branchCount} branch
          {counts.branchCount === 1 ? '' : 'es'}
        </p>
      </header>

      <div className={styles['cross-links']}>
        <span className={styles['cross-link']} aria-disabled="true">
          &rarr; Branches
        </span>
        <span className={styles['cross-link']} aria-disabled="true">
          &rarr; Receptionists
        </span>
        <span className={styles['cross-link']} aria-disabled="true">
          Branch hours impact
        </span>
      </div>

      {warning && (
        <div className={styles['warning-banner']} role="status">
          <strong>{warning.full_name}</strong> was deactivated, but has{' '}
          <strong>
            {warning.future_appointment_count} future appointment
            {warning.future_appointment_count === 1 ? '' : 's'}
          </strong>
          . They stay Scheduled; the doctor&rsquo;s kanban (E6) handles
          the resolution queue.
          <button
            type="button"
            className={styles['warning-banner__close']}
            onClick={() => setWarning(null)}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {/* ─── Filter bar ──────────────────────────────────────── */}
      <div className={styles['filter-bar']}>
        <input
          className={styles['search']}
          placeholder="Search doctors"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className={styles['seg']} role="tablist">
          <button
            type="button"
            className={
              filterMode === 'all'
                ? `${styles['seg-btn']} ${styles['seg-btn--active']}`
                : styles['seg-btn']
            }
            onClick={() => setFilterMode('all')}
            aria-pressed={filterMode === 'all'}
          >
            All ({segCounts.all})
          </button>
          <button
            type="button"
            className={
              filterMode === 'active'
                ? `${styles['seg-btn']} ${styles['seg-btn--active']}`
                : styles['seg-btn']
            }
            onClick={() => setFilterMode('active')}
            aria-pressed={filterMode === 'active'}
          >
            Active ({segCounts.active})
          </button>
          <button
            type="button"
            className={
              filterMode === 'inactive'
                ? `${styles['seg-btn']} ${styles['seg-btn--active']}`
                : styles['seg-btn']
            }
            onClick={() => setFilterMode('inactive')}
            aria-pressed={filterMode === 'inactive'}
          >
            Inactive ({segCounts.inactive})
          </button>
        </div>
        <select
          className={styles['branch-select']}
          value={filterBranchId}
          onChange={(e) => setFilterBranchId(e.target.value)}
        >
          <option value="">All branches</option>
          {branchOptions.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
              {b.active ? '' : ' · inactive'}
            </option>
          ))}
        </select>
      </div>

      {/* ─── Card grid ───────────────────────────────────────── */}
      <div className={styles['grid']}>
        {visible.map((d) => {
          const cardClass = d.active
            ? styles['doc-card']
            : `${styles['doc-card']} ${styles['doc-card--inactive']}`;
          return (
            <div key={d.id} className={cardClass}>
              <div className={styles['head']}>
                <div className={styles['av']} aria-hidden="true">
                  {initialsOf(d.full_name)}
                </div>
                <div className={styles['name-block']}>
                  <div className={styles['name']}>{d.full_name}</div>
                  <div className={styles['email']}>{d.email}</div>
                </div>
                {d.active ? (
                  <span
                    className={`${styles['pill']} ${styles['pill--active']}`}
                  >
                    ● Active
                  </span>
                ) : (
                  <span
                    className={`${styles['pill']} ${styles['pill--inactive']}`}
                  >
                    ○ Inactive
                  </span>
                )}
              </div>

              <div className={styles['branches']}>
                <div className={styles['branches__label']}>Branches</div>
                {d.branches.length === 0 ? (
                  <span className={styles['branch-chip-empty']}>
                    No branches
                  </span>
                ) : (
                  <div className={styles['branches__chips']}>
                    {d.branches.map((b) => (
                      <span key={b.id} className={styles['branch-chip']}>
                        {b.name}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div className={styles['stats']}>
                <div className={styles['stat']}>
                  <div className={styles['stat__label']}>Future appts</div>
                  <div className={styles['stat__value']}>—</div>
                </div>
                <div className={styles['stat']}>
                  <div className={styles['stat__label']}>Specialty</div>
                  <div className={styles['stat__value']}>—</div>
                </div>
              </div>

              <div className={styles['actions']}>
                <button
                  type="button"
                  className={styles['action-btn']}
                  onClick={() => onOpenEdit(d)}
                  disabled={busy}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className={`${styles['action-btn']} ${styles['action-btn--primary']}`}
                  onClick={() => {
                    if (onOpenDoctorAssign) onOpenDoctorAssign(d.id);
                  }}
                  disabled={busy || !onOpenDoctorAssign}
                  title={
                    onOpenDoctorAssign
                      ? 'Reassign branches'
                      : 'Not yet implemented'
                  }
                >
                  Assign
                </button>
                <button
                  type="button"
                  className={styles['action-btn']}
                  onClick={() => {
                    if (onOpenDoctorSchedule) onOpenDoctorSchedule(d.id);
                  }}
                  disabled={busy || !onOpenDoctorSchedule}
                  title={
                    onOpenDoctorSchedule
                      ? 'Edit weekly schedule'
                      : 'Not yet implemented'
                  }
                >
                  Schedule
                </button>
                <button
                  type="button"
                  className={styles['action-btn']}
                  onClick={() => {
                    if (onOpenDoctorBlocks) onOpenDoctorBlocks(d.id);
                  }}
                  disabled={busy || !onOpenDoctorBlocks}
                  title={
                    onOpenDoctorBlocks
                      ? 'Block time off'
                      : 'Not yet implemented'
                  }
                >
                  Block time
                </button>
                {d.active ? (
                  <button
                    type="button"
                    className={`${styles['action-btn']} ${styles['action-btn--danger']}`}
                    onClick={() => {
                      void onDeactivate(d);
                    }}
                    disabled={busy}
                  >
                    Deactivate
                  </button>
                ) : (
                  <button
                    type="button"
                    className={`${styles['action-btn']} ${styles['action-btn--primary']}`}
                    onClick={() => {
                      void onReactivate(d);
                    }}
                    disabled={busy}
                  >
                    Reactivate
                  </button>
                )}
              </div>
            </div>
          );
        })}

        <div
          className={`${styles['doc-card']} ${styles['doc-card--add']}`}
          role="button"
          tabIndex={0}
          onClick={onOpenCreate}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onOpenCreate();
            }
          }}
        >
          <div className={styles['add-icon']}>+</div>
          <div className={styles['add-label']}>New doctor</div>
        </div>
      </div>

      {/* ─── Create modal (Edit modal mirrors Create) ────────── */}
      {mode !== 'closed' && (
        <div
          className={styles['modal-backdrop']}
          ref={modalRef}
          onClick={onScrimClick}
          role="presentation"
        >
          <div
            className={styles['modal']}
            role="dialog"
            aria-modal="true"
            aria-labelledby="docModalTitle"
          >
            <div className={styles['modal-head']}>
              <div className={styles['modal-head__body']}>
                <div className={styles['modal-title']} id="docModalTitle">
                  {mode === 'create'
                    ? 'New doctor'
                    : `Edit · ${editFullName || 'doctor'}`}
                </div>
                <p className={styles['modal-sub']}>
                  {mode === 'create'
                    ? 'Doctors work at one or more branches within the clinic (BR-002).'
                    : 'Changes save when you click Save.'}
                </p>
              </div>
              <button
                type="button"
                className={styles['modal-x']}
                onClick={onCloseModal}
                aria-label="Close"
                disabled={busy}
              >
                ×
              </button>
            </div>
            <form onSubmit={onSubmit} noValidate>
              <div className={styles['modal-body']}>
                <div className={styles['form-group']}>
                  <label htmlFor="doc-name">
                    Full name <span className={styles['req']}>*</span>
                  </label>
                  <input
                    id="doc-name"
                    type="text"
                    value={editFullName}
                    onChange={(e) => setEditFullName(e.target.value)}
                    maxLength={NAME_MAX + 1}
                    disabled={busy}
                    placeholder="e.g. Dr. Ahmed Al-Rashid"
                    autoComplete="off"
                  />
                  <div className={styles['hint']}>
                    1..{NAME_MAX} characters. Required.
                  </div>
                </div>

                <div className={styles['form-group']}>
                  <label htmlFor="doc-email">
                    Email <span className={styles['req']}>*</span>
                  </label>
                  <input
                    id="doc-email"
                    type="email"
                    value={editEmail}
                    onChange={(e) => setEditEmail(e.target.value)}
                    maxLength={EMAIL_MAX + 1}
                    disabled={busy}
                    placeholder="e.g. a.alrashid@clinic.local"
                    autoComplete="off"
                  />
                  <div className={styles['hint']}>
                    Used for sign-in and audit. 3..{EMAIL_MAX} characters.
                  </div>
                </div>

                {mode === 'create' && (
                  <div className={styles['form-group']}>
                    <label>
                      Assigned branches <span className={styles['req']}>*</span>
                    </label>
                    <div className={styles['branch-check-list']}>
                      {branchOptions.length === 0 && (
                        <div className={styles['branch-empty']}>
                          No branches yet — create one first.
                        </div>
                      )}
                      {branchOptions.map((b) => {
                        const checked = editBranchIds.includes(b.id);
                        return (
                          <label
                            key={b.id}
                            className={
                              checked
                                ? `${styles['branch-check']} ${styles['branch-check--selected']}`
                                : styles['branch-check']
                            }
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => onToggleBranch(b.id)}
                              disabled={busy}
                            />
                            <div className={styles['branch-check__check']} aria-hidden="true">
                              {checked ? '✓' : ''}
                            </div>
                            <div className={styles['branch-check__body']}>
                              <div className={styles['branch-check__name']}>
                                {b.name}
                                {b.active ? '' : ' (inactive)'}
                              </div>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                    <div className={styles['hint']}>
                      Pick at least one. Use the &ldquo;Assign&rdquo;
                      card button to change a doctor&rsquo;s branches
                      after creation.
                    </div>
                  </div>
                )}

                {mode === 'edit' && (
                  <div className={styles['form-group']}>
                    <label>Status</label>
                    <div className={styles['status-toggle']}>
                      <div
                        className={
                          editActive
                            ? `${styles['opt']} ${styles['opt--active']}`
                            : styles['opt']
                        }
                        role="button"
                        tabIndex={busy ? -1 : 0}
                        aria-pressed={editActive}
                        onClick={() => {
                          if (!busy) setEditActive(true);
                        }}
                        onKeyDown={(e) => {
                          if (
                            (e.key === 'Enter' || e.key === ' ') &&
                            !busy
                          ) {
                            e.preventDefault();
                            setEditActive(true);
                          }
                        }}
                      >
                        ● Active
                      </div>
                      <div
                        className={
                          !editActive
                            ? `${styles['opt']} ${styles['opt--active']}`
                            : styles['opt']
                        }
                        role="button"
                        tabIndex={busy ? -1 : 0}
                        aria-pressed={!editActive}
                        onClick={() => {
                          if (!busy) setEditActive(false);
                        }}
                        onKeyDown={(e) => {
                          if (
                            (e.key === 'Enter' || e.key === ' ') &&
                            !busy
                          ) {
                            e.preventDefault();
                            setEditActive(false);
                          }
                        }}
                      >
                        ○ Inactive
                      </div>
                    </div>
                    <div className={styles['hint']}>
                      Deactivating does not block future appointments
                      (F-18) — they stay Scheduled. A warning surfaces
                      in the page banner if any exist. Use the
                      &ldquo;Assign&rdquo; card button to change
                      branches.
                    </div>
                  </div>
                )}

                {formErr && (
                  <div className={styles['error-banner']} role="alert">
                    <strong>{formErr.code}:</strong> {formErr.message}
                  </div>
                )}
              </div>

              <div className={styles['modal-foot']}>
                <button
                  type="button"
                  className={styles['btn-ghost']}
                  onClick={onCloseModal}
                  disabled={busy}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className={styles['btn-primary']}
                  disabled={
                    busy ||
                    editFullName.trim().length === 0 ||
                    editEmail.trim().length === 0 ||
                    (mode === 'create' && editBranchIds.length === 0)
                  }
                >
                  {busy
                    ? mode === 'create'
                      ? 'Creating…'
                      : 'Saving…'
                    : mode === 'create'
                      ? 'Create doctor'
                      : 'Save changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
