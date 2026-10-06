/**
 * Admin Receptionists page — `/admin/receptionists`.
 *
 * Pixel-perfect port of mockup 19
 * (docs/design/mockups/v1/mockups/19-admin-receptionists.html). Driven by
 * the E1-S4 API surface: `GET/POST /admin/receptionists`,
 * `GET/PATCH /admin/receptionists/:id`.
 *
 * Layout (mockup 19-B):
 *   - Header (crumb + H1 + subline: "X active · Y inactive · single
 *     branch per receptionist (BR-004)")
 *   - Cross-links: Branches / Doctors / Today's view (placeholders,
 *     deferred)
 *   - Filter bar: search input + All / Active / Inactive segmented
 *     toggle + All-branches select
 *   - Card grid: `repeat(auto-fill, minmax(310px, 1fr))`. Each card
 *     shows: avatar (initials), name + email, Active/Inactive pill,
 *     branch-locked card (📍 ic + "Assigned branch" + 🔒), stats
 *     placeholder, and three action buttons. Inactive cards are grey.
 *     The grid ends with a dashed "+ Add" card.
 *
 * BR-004 invariant: receptionists have exactly one branch, so the page
 * renders a single "Assigned branch" tile (with a 🔒) rather than the
 * doctor-style multi-branch list.
 *
 * F-19 (mirrors F-18): deactivating a receptionist does NOT 409 even
 * when they have future Scheduled appointments — the PATCH response
 * carries `warning: 'receptionist_has_future_appointments'` +
 * `future_appointment_count: N`. The page surfaces this warning as a
 * post-save banner (success colour) instead of a blocking modal.
 *
 * BR-059 (deactivate-blocks-future-appts) does NOT apply here — that
 * rule was for branches. Receptionists are operators, not the
 * appointment subject, so deactivating is non-blocking per F-19.
 *
 * Create + edit happen in a single in-page modal that mirrors the
 * AdminBranches pattern. No tests in this pass (per user instruction).
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
  createReceptionist,
  listBranches,
  listReceptionists,
  patchReceptionist,
  type BranchDto,
  type ReceptionistWithBranchDto,
} from '../api/client';
import styles from './AdminReceptionists.module.css';

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
  code: 'receptionist_has_future_appointments';
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
    } else if (err.code === 'invalid_branch_id') {
      message = 'Branch id is invalid (must be a UUID).';
    } else if (err.code === 'invalid_active') {
      message = 'Status must be Active or Inactive.';
    } else if (err.code === 'branch_not_found') {
      message = 'That branch no longer exists.';
    } else if (err.code === 'receptionist_not_found') {
      message = 'That receptionist no longer exists.';
    } else if (err.code === 'email_already_exists') {
      message =
        'A receptionist with that email already exists. Edit them instead.';
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
  const parts = fullName.trim().split(/\s+/);
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

export function AdminReceptionists() {
  const [receptionists, setReceptionists] = useState<
    ReceptionistWithBranchDto[]
  >([]);
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
  const [editBranchId, setEditBranchId] = useState<string>('');
  const [editActive, setEditActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState<FormError | null>(null);

  // Post-deactivate warning banner (F-19 — non-blocking).
  const [warning, setWarning] = useState<Warning | null>(null);

  const modalRef = useRef<HTMLDivElement | null>(null);

  // Reload both lists in parallel; receptionists depend on branches
  // only via the embedded `branch` object (already denormalised in the
  // response), but the filter-bar `<select>` shows live branch names so
  // we need the list too.
  const reload = useCallback(async (): Promise<void> => {
    const [recep, br] = await Promise.all([
      listReceptionists(),
      listBranches(),
    ]);
    setReceptionists(recep);
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
    for (const r of receptionists) {
      if (r.active) active += 1;
      else inactive += 1;
    }
    return { active, inactive, total: active + inactive };
  }, [receptionists]);

  // Filtered + searched view. The `search` input is client-side only
  // — the API does not support it (full list is small).
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return receptionists.filter((r) => {
      if (filterMode === 'active' && !r.active) return false;
      if (filterMode === 'inactive' && r.active) return false;
      if (filterBranchId && r.branch_id !== filterBranchId) return false;
      if (q.length > 0) {
        const haystack = `${r.full_name} ${r.email}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [receptionists, search, filterMode, filterBranchId]);

  // Active count per branch — for the segmented badge (mockup 19 lines 94-96).
  const segCounts = useMemo(() => {
    let active = 0;
    let inactive = 0;
    for (const r of receptionists) {
      if (r.active) active += 1;
      else inactive += 1;
    }
    return { all: receptionists.length, active, inactive };
  }, [receptionists]);

  // Branch options (active + inactive). Mockup 19 doesn't filter by
  // active branch but we follow the same pattern as the doctors page
  // and show everything the API returned.
  const branchOptions = useMemo(() => {
    return [...branches].sort((a, b) => a.name.localeCompare(b.name));
  }, [branches]);

  // ─── Modal open / close ───────────────────────────────────────
  const onOpenCreate = useCallback(() => {
    setMode('create');
    setEditId(null);
    setEditFullName('');
    setEditEmail('');
    setEditBranchId(branches[0]?.id ?? '');
    setEditActive(true);
    setFormErr(null);
  }, [branches]);

  const onOpenEdit = useCallback((r: ReceptionistWithBranchDto) => {
    setMode('edit');
    setEditId(r.id);
    setEditFullName(r.full_name);
    setEditEmail(r.email);
    setEditBranchId(r.branch_id);
    setEditActive(r.active);
    setFormErr(null);
  }, []);

  const onCloseModal = useCallback(() => {
    if (busy) return;
    setMode('closed');
    setFormErr(null);
  }, [busy]);

  // Close the modal on Escape.
  useEffect(() => {
    if (mode === 'closed') return;
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') onCloseModal();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mode, onCloseModal]);

  // ─── Submit (create + edit) ───────────────────────────────────
  const onSubmit = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setFormErr(null);

      const fullName = editFullName.trim();
      const email = editEmail.trim().toLowerCase();
      const branchId = editBranchId;

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
      if (!isValidUuidClient(branchId)) {
        setFormErr({
          status: 400,
          code: 'invalid_branch_id',
          message: 'Pick a branch.',
        });
        return;
      }

      setBusy(true);
      try {
        if (mode === 'create') {
          await createReceptionist({ full_name: fullName, email, branch_id: branchId });
          await reload();
          setMode('closed');
          return;
        }
        // mode === 'edit'
        if (!editId) return;
        const original = receptionists.find((r) => r.id === editId);
        if (!original) {
          setFormErr(
            describeApiError(
              new ApiError(404, 'receptionist_not_found'),
            ),
          );
          return;
        }
        const patch: {
          full_name?: string;
          active?: boolean;
          branch_id?: string;
        } = {};
        if (fullName !== original.full_name) patch.full_name = fullName;
        if (branchId !== original.branch_id) patch.branch_id = branchId;
        if (editActive !== original.active) patch.active = editActive;
        if (Object.keys(patch).length === 0) {
          setFormErr({
            status: 400,
            code: 'no_fields_to_update',
            message: 'Nothing to save.',
          });
          return;
        }
        const resp = await patchReceptionist(editId, patch);
        await reload();
        setMode('closed');
        // F-19: if the server reported a future-appointment warning,
        // surface it as a banner. The deactivate still succeeded.
        if (
          resp.warning === 'receptionist_has_future_appointments' &&
          resp.future_appointment_count > 0
        ) {
          setWarning({
            code: 'receptionist_has_future_appointments',
            future_appointment_count: resp.future_appointment_count,
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
      editBranchId,
      editActive,
      mode,
      editId,
      receptionists,
      reload,
    ],
  );

  // One-shot deactivate shortcut (mockup card foot has a Deactivate
  // button — it doesn't open the full edit modal). It always sends
  // `{active: false}`; other fields stay unchanged. The modal close
  // path runs through the normal `onSubmit`.
  const onDeactivate = useCallback(
    async (r: ReceptionistWithBranchDto) => {
      if (r.active === false) return;
      setBusy(true);
      setFormErr(null);
      try {
        const resp = await patchReceptionist(r.id, { active: false });
        await reload();
        if (
          resp.warning === 'receptionist_has_future_appointments' &&
          resp.future_appointment_count > 0
        ) {
          setWarning({
            code: 'receptionist_has_future_appointments',
            future_appointment_count: resp.future_appointment_count,
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
    async (r: ReceptionistWithBranchDto) => {
      if (r.active === true) return;
      setBusy(true);
      setFormErr(null);
      try {
        await patchReceptionist(r.id, { active: true });
        await reload();
      } catch (caught) {
        setFormErr(describeApiError(caught));
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );

  const onScrimClick = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement> | React.MouseEvent<HTMLDivElement>) => {
      if (e.target === modalRef.current) onCloseModal();
    },
    [onCloseModal],
  );

  if (loading) {
    return (
      <div className={styles['page']}>
        <p className={styles['sub']}>Loading receptionists…</p>
      </div>
    );
  }

  if (loadErr) {
    return (
      <div className={styles['page']}>
        <h1>Receptionists</h1>
        <div className={styles['error-banner']} role="alert">
          <strong>{loadErr.code}:</strong> {loadErr.message}
        </div>
      </div>
    );
  }

  return (
    <div className={styles['page']}>
      <header className={styles['page-header']}>
        <div className={styles['crumb']}>Admin &rarr; Receptionists</div>
        <h1>Receptionists</h1>
        <p className={styles['sub']}>
          {counts.active} active
          {counts.inactive > 0 ? ` · ${counts.inactive} inactive` : ''}
          {' · '}
          single branch per receptionist (BR-004)
        </p>
      </header>

      <div className={styles['cross-links']}>
        <span className={styles['cross-link']} aria-disabled="true">
          &rarr; Branches
        </span>
        <span className={styles['cross-link']} aria-disabled="true">
          &rarr; Doctors
        </span>
        <span className={styles['cross-link']} aria-disabled="true">
          Today&rsquo;s view
        </span>
      </div>

      {warning && (
        <div className={styles['warning-banner']} role="status">
          <strong>{warning.full_name}</strong> was deactivated, but has{' '}
          <strong>
            {warning.future_appointment_count} future appointment
            {warning.future_appointment_count === 1 ? '' : 's'}
          </strong>
          . They stay Scheduled; the receptionist can no longer manage
          them.
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
          placeholder="Search receptionists"
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
        {visible.map((r) => {
          const cardClass = r.active
            ? styles['rec-card']
            : `${styles['rec-card']} ${styles['rec-card--inactive']}`;
          return (
            <div key={r.id} className={cardClass}>
              <div className={styles['head']}>
                <div className={styles['av']} aria-hidden="true">
                  {initialsOf(r.full_name)}
                </div>
                <div className={styles['name-block']}>
                  <div className={styles['name']}>{r.full_name}</div>
                  <div className={styles['email']}>{r.email}</div>
                </div>
                {r.active ? (
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

              <div className={styles['branch-locked']}>
                <div className={styles['branch-locked__ic']} aria-hidden="true">
                  📍
                </div>
                <div className={styles['branch-locked__body']}>
                  <div className={styles['branch-locked__label']}>
                    Assigned branch
                  </div>
                  <div className={styles['branch-locked__name']}>
                    {r.branch.name}
                  </div>
                </div>
                <div
                  className={styles['branch-locked__lock']}
                  title="Single branch per receptionist (BR-004)"
                  aria-hidden="true"
                >
                  🔒
                </div>
              </div>

              <div className={styles['stats']}>
                <div className={styles['stat']}>
                  <div className={styles['stat__label']}>Appts today</div>
                  <div className={styles['stat__value']}>—</div>
                </div>
                <div className={styles['stat']}>
                  <div className={styles['stat__label']}>Last login</div>
                  <div className={styles['stat__value']}>—</div>
                </div>
              </div>

              <div className={styles['actions']}>
                <button
                  type="button"
                  className={styles['action-btn']}
                  onClick={() => onOpenEdit(r)}
                  disabled={busy}
                >
                  Edit
                </button>
                {r.active ? (
                  <button
                    type="button"
                    className={`${styles['action-btn']} ${styles['action-btn--danger']}`}
                    onClick={() => {
                      void onDeactivate(r);
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
                      void onReactivate(r);
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

        {/* "+ Add" card (mockup 19 line 270) */}
        <div
          className={`${styles['rec-card']} ${styles['rec-card--add']}`}
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
          <div className={styles['add-label']}>New receptionist</div>
        </div>
      </div>

      {/* ─── Create / Edit modal ────────────────────────────── */}
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
            aria-labelledby="recepModalTitle"
          >
            <div className={styles['modal-head']}>
              <div className={styles['modal-head__body']}>
                <div className={styles['modal-title']} id="recepModalTitle">
                  {mode === 'create'
                    ? 'New receptionist'
                    : `Edit · ${editFullName || 'receptionist'}`}
                </div>
                <p className={styles['modal-sub']}>
                  {mode === 'create'
                    ? 'Receptionists manage appointments at exactly one branch.'
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
                  <label htmlFor="recep-name">
                    Full name <span className={styles['req']}>*</span>
                  </label>
                  <input
                    id="recep-name"
                    type="text"
                    value={editFullName}
                    onChange={(e) => setEditFullName(e.target.value)}
                    maxLength={NAME_MAX + 1}
                    disabled={busy}
                    placeholder="e.g. Noura Al-Harbi"
                    autoComplete="off"
                  />
                  <div className={styles['hint']}>
                    1..{NAME_MAX} characters. Required.
                  </div>
                </div>

                <div className={styles['form-group']}>
                  <label htmlFor="recep-email">
                    Email <span className={styles['req']}>*</span>
                  </label>
                  <input
                    id="recep-email"
                    type="email"
                    value={editEmail}
                    onChange={(e) => setEditEmail(e.target.value)}
                    maxLength={EMAIL_MAX + 1}
                    disabled={busy}
                    placeholder="e.g. n.alharbi@clinic.local"
                    autoComplete="off"
                  />
                  <div className={styles['hint']}>
                    Used for sign-in and audit. 3..{EMAIL_MAX} characters.
                  </div>
                </div>

                <div className={styles['form-group']}>
                  <label htmlFor="recep-branch">
                    Assigned branch <span className={styles['req']}>*</span>
                  </label>
                  <select
                    id="recep-branch"
                    value={editBranchId}
                    onChange={(e) => setEditBranchId(e.target.value)}
                    disabled={busy}
                  >
                    {branchOptions.length === 0 && (
                      <option value="">No branches yet — create one first</option>
                    )}
                    {branchOptions.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                        {b.active ? '' : ' (inactive)'}
                      </option>
                    ))}
                  </select>
                  <div className={styles['hint']}>
                    Single branch per receptionist (BR-004).
                  </div>
                </div>

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
                      (F-19) — they stay Scheduled. A warning surfaces
                      in the page banner if any exist.
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
                    !isValidUuidClient(editBranchId)
                  }
                >
                  {busy
                    ? mode === 'create'
                      ? 'Creating…'
                      : 'Saving…'
                    : mode === 'create'
                      ? 'Create receptionist'
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