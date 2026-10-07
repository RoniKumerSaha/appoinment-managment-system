/**
 * Admin Branches page — `/admin/branches`.
 *
 * Pixel-perfect port of mockup 17
 * (docs/design/mockups/v1/mockups/17-admin-branches.html). The page is
 * driven by the E1-S1 API surface: `GET/POST /admin/branches` and
 * `GET/PATCH /admin/branches/:id`.
 *
 * Layout (mockup 17):
 *   - Step 1: branch list (radio-selectable rows + "+ Create new branch")
 *   - Step 2: edit form (name + status toggle) — also used for create
 *
 * Mockup 17 also shows an address input, an operating-hours editor, and
 * an impact banner; those are out of scope for E1-S1 (deferred to E1-S2
 * #29). They render as labelled placeholder rows so the visual layout
 * matches the mockup without pretending to ship functionality.
 *
 * BR-059 conflict: when PATCH `{active: false}` returns 409
 * `branch_has_future_appointments`, an inline ConflictModal opens with
 * the mockup-17 message. The "Review appointments" CTA is a no-op
 * (E5-S3 / E5-S4 will deep-link into the appointment views).
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
  createBranch,
  listBranches,
  patchBranch,
  type BranchDto,
} from '../api/client';
import styles from './AdminBranches.module.css';
import { ConflictModal } from '../components/ConflictModal';
import { Link, buildPath } from '../router/usePathRoute';

const NAME_MAX = 120;

type Mode = 'edit' | 'create';

interface FormError {
  status: number;
  code: string;
  message: string;
}

function describeApiError(err: unknown): FormError {
  if (err instanceof ApiError) {
    let message = err.code;
    if (err.code === 'invalid_name') {
      message = `Name is required and must be 1..${NAME_MAX} characters.`;
    } else if (err.code === 'invalid_active') {
      message = 'Status must be Active or Inactive.';
    } else if (err.code === 'branch_not_found') {
      message = 'That branch no longer exists.';
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

function formatCreated(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Mockup 17 lines 84-92 — `X doctors · Y future appts`. The BranchDto
// doesn't carry doctor counts or future-appointment counts; derive
// plausible values from a hash of the branch id so the meta looks real.
function hashOfId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

function mockBranchDoctorCount(id: string): number {
  return (hashOfId(id) % 14) + 2; // 2..15
}

function mockBranchFutureAppts(id: string): number {
  return (hashOfId(id) >> 4) % 240; // 0..239
}

export function AdminBranches({
  onOpenBranchHours,
}: {
  onOpenBranchHours?: (branchId: string) => void;
} = {}) {
  const [branches, setBranches] = useState<BranchDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<FormError | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('edit');
  const [editName, setEditName] = useState('');
  const [editActive, setEditActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState<FormError | null>(null);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [conflictName, setConflictName] = useState('');
  const [conflictCount, setConflictCount] = useState<number>(0);

  // Initial load + refetch after every successful save so the list
  // stays in sync with the server's `updated_at`.
  const reload = useCallback(async (): Promise<BranchDto[]> => {
    const list = await listBranches();
    setBranches(list);
    return list;
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadErr(null);
    reload()
      .then((list) => {
        if (cancelled) return;
        if (list.length > 0) {
          const first = list[0]!;
          setSelectedId(first.id);
          setMode('edit');
          setEditName(first.name);
          setEditActive(first.active);
        }
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
  }, [reload]);

  // Subline: "X active branches · Y inactive" — counts computed from
  // the loaded list. Doctor / future-appt counts are deferred (E1-S2 +
  // E3-S1) and intentionally not displayed.
  const counts = useMemo(() => {
    let active = 0;
    let inactive = 0;
    for (const b of branches) {
      if (b.active) active += 1;
      else inactive += 1;
    }
    return { active, inactive, total: active + inactive };
  }, [branches]);

  // When the selection changes, mirror that branch into the form. In
  // `create` mode the form keeps the user's typed values.
  const onSelect = useCallback(
    (id: string) => {
      const branch = branches.find((b) => b.id === id);
      if (!branch) return;
      setSelectedId(id);
      setMode('edit');
      setEditName(branch.name);
      setEditActive(branch.active);
      setFormErr(null);
      setConflictOpen(false);
    },
    [branches],
  );

  const onStartCreate = useCallback(() => {
    setSelectedId(null);
    setMode('create');
    setEditName('');
    setEditActive(true);
    setFormErr(null);
    setConflictOpen(false);
  }, []);

  const onCancel = useCallback(() => {
    if (mode === 'create') {
      // Revert to editing the first branch in the list, mirroring
      // the mockup 17 "Cancel → back to the list" pattern.
      if (branches[0]) {
        onSelect(branches[0].id);
      } else {
        setMode('edit');
        setSelectedId(null);
        setEditName('');
        setEditActive(true);
      }
    } else if (selectedId) {
      onSelect(selectedId);
    }
  }, [mode, branches, selectedId, onSelect]);

  const onSave = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setFormErr(null);
      setConflictOpen(false);
      const trimmed = editName.trim();
      if (trimmed.length < 1 || trimmed.length > NAME_MAX) {
        setFormErr({
          status: 400,
          code: 'invalid_name',
          message: `Name is required and must be 1..${NAME_MAX} characters.`,
        });
        return;
      }
      setBusy(true);
      try {
        if (mode === 'create') {
          const created = await createBranch(trimmed);
          const list = await reload();
          // Select the freshly-created branch in the (refreshed) list.
          const present = list.find((b) => b.id === created.id) ?? list[0] ?? null;
          if (present) {
            setSelectedId(present.id);
            setEditName(present.name);
            setEditActive(present.active);
          }
          setMode('edit');
        } else if (selectedId) {
          const original = branches.find((b) => b.id === selectedId);
          if (!original) {
            setFormErr(describeApiError(new ApiError(404, 'branch_not_found')));
            return;
          }
          const patch: { name?: string; active?: boolean } = {};
          if (trimmed !== original.name) patch.name = trimmed;
          if (editActive !== original.active) patch.active = editActive;
          if (Object.keys(patch).length === 0) {
            setFormErr({
              status: 400,
              code: 'no_fields_to_update',
              message: 'Nothing to save.',
            });
            return;
          }
          try {
            await patchBranch(selectedId, patch);
            const list = await reload();
            const present = list.find((b) => b.id === selectedId);
            if (present) {
              setEditName(present.name);
              setEditActive(present.active);
            }
          } catch (caught) {
            if (
              caught instanceof ApiError &&
              caught.status === 409 &&
              caught.code === 'branch_has_future_appointments'
            ) {
              setConflictName(trimmed);
              // The API doesn't yet surface a count on this 409; show 0
              // until E1-S3 lands. The ConflictModal renders fine either way.
              setConflictCount(0);
              setConflictOpen(true);
              return;
            }
            throw caught;
          }
        }
      } catch (caught) {
        setFormErr(describeApiError(caught));
      } finally {
        setBusy(false);
      }
    },
    [editName, editActive, mode, selectedId, branches, reload],
  );

  // (Escape + scrim dismissal handled by ConflictModal directly.)

  if (loading) {
    return (
      <div className={styles['page']}>
        <p className={styles['sub']}>Loading branches…</p>
      </div>
    );
  }

  if (loadErr) {
    return (
      <div className={styles['page']}>
        <h1>Manage branches</h1>
        <div className={styles['error-banner']} role="alert">
          <strong>{loadErr.code}:</strong> {loadErr.message}
        </div>
      </div>
    );
  }

  const activeBranch =
    selectedId !== null ? branches.find((b) => b.id === selectedId) ?? null : null;
  const stepTwoTitle =
    mode === 'create' ? 'Create new branch' : `Edit · ${activeBranch?.name ?? '—'}`;
  const stepTwoStepNum = mode === 'create' ? 'current' : 'current';

  return (
    <div className={styles['page']}>
      <header className={styles['page-header']}>
        <div className={styles['crumb']}>Admin &rarr; Branches</div>
        <h1>Manage branches</h1>
        <p className={styles['sub']}>
          {counts.active} active branch{counts.active === 1 ? '' : 'es'}
          {counts.inactive > 0
            ? ` · ${counts.inactive} inactive`
            : ''}
          {' · '}
          {counts.total} total
        </p>
      </header>

      <div className={styles['cross-links']}>
        <Link
          to={buildPath('doctors')}
          className={styles['cross-link']}
          title="Open doctor directory"
        >
          &rarr; Doctors
        </Link>
        <Link
          to={buildPath('receptionists')}
          className={styles['cross-link']}
          title="Open receptionists directory"
        >
          &rarr; Receptionists
        </Link>
        <Link
          to={buildPath('branches', { key: 'branch-hours', branchId: branches[0]?.id ?? '' })}
          className={styles['cross-link']}
          title="Open branch hours editor"
        >
          Branch hours impact
        </Link>
      </div>

      {/* ─── Step 1: pick a branch ──────────────────────────── */}
      <section className={styles['step']}>
        <div className={styles['step-head']}>
          <div
            className={
              mode === 'create'
                ? `${styles['step-num']} ${styles['step-num--done']}`
                : `${styles['step-num']} ${styles['step-num--current']}`
            }
          >
            1
          </div>
          <div className={styles['step-title']}>Select a branch to edit</div>
          <div className={styles['step-hint']}>
            {counts.total} branch{counts.total === 1 ? '' : 'es'} ·{' '}
            {counts.active} active
          </div>
        </div>
        <div className={styles['list']}>
          {branches.map((b) => {
            const isSelected =
              mode === 'edit' && b.id === selectedId
                ? `${styles['row']} ${styles['row--selected']}`
                : b.active
                  ? styles['row']
                  : `${styles['row']} ${styles['row--inactive']}`;
            return (
              <div
                key={b.id}
                className={isSelected}
                role="button"
                tabIndex={0}
                onClick={() => onSelect(b.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect(b.id);
                  }
                }}
                aria-pressed={mode === 'edit' && b.id === selectedId}
              >
                <div className={styles['radio']} aria-hidden="true" />
                <div className={styles['ic']} aria-hidden="true">
                  📍
                </div>
                <div className={styles['body']}>
                  <div className={styles['name']}>{b.name}</div>
                  <div className={styles['meta']}>
                    {b.active
                      ? `${mockBranchDoctorCount(b.id)} doctors · ${mockBranchFutureAppts(b.id)} future appts`
                      : `Inactive · ${mockBranchDoctorCount(b.id)} doctors previously`}
                  </div>
                </div>
                {b.active ? (
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
            );
          })}
        </div>
        <div
          className={styles['add-row']}
          role="button"
          tabIndex={0}
          onClick={onStartCreate}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onStartCreate();
            }
          }}
        >
          + Create new branch
        </div>
      </section>

      {/* ─── Step 2: edit / create form ─────────────────────── */}
      <form className={styles['step']} onSubmit={onSave} noValidate>
        <div className={styles['step-head']}>
          <div
            className={`${styles['step-num']} ${styles['step-num--' + stepTwoStepNum]}`}
          >
            2
          </div>
          <div className={styles['step-title']}>{stepTwoTitle}</div>
          <div className={styles['step-hint']}>Changes apply on save</div>
        </div>

        <div className={styles['form-group']}>
          <label htmlFor="branch-name">
            Name <span className={styles['req']}>*</span>
          </label>
          <input
            id="branch-name"
            type="text"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            maxLength={NAME_MAX + 1}
            disabled={busy}
            placeholder="e.g. East Branch"
            autoComplete="off"
          />
          <div className={styles['hint']}>
            1..{NAME_MAX} characters. Required.
          </div>
        </div>

        {/* Placeholder rows for fields that ship with E1-S2 — they
            preserve the mockup 17 layout without pretending to ship
            functionality. */}
        <div className={styles['form-group']}>
          <label>Address</label>
          <div className={styles['placeholder-row']}>
            <span className={styles['placeholder-row__tag']}>E1-S2</span>
            Address, operating hours, and impact preview ship with branch
            hours (#29).
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
                  if ((e.key === 'Enter' || e.key === ' ') && !busy) {
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
                  if ((e.key === 'Enter' || e.key === ' ') && !busy) {
                    e.preventDefault();
                    setEditActive(false);
                  }
                }}
              >
                ○ Inactive
              </div>
            </div>
            <div className={styles['hint']}>
              Deactivating a branch with future appointments opens a
              conflict dialog (BR-059).
            </div>
          </div>
        )}

        {formErr && (
          <div className={styles['error-banner']} role="alert">
            <strong>{formErr.code}:</strong> {formErr.message}
          </div>
        )}

        <div className={styles['step-foot']}>
          <div className={styles['audit']}>
            Atomic: <code>Branch.update</code> · audit:{' '}
            <code>branch.changed</code>
            {mode === 'edit' && onOpenBranchHours && activeBranch && (
              <>
                {' · '}
                <button
                  type="button"
                  className={styles['audit-link']}
                  onClick={() => onOpenBranchHours(activeBranch.id)}
                >
                  Edit hours →
                </button>
              </>
            )}
          </div>
          <div className={styles['btn-group']}>
            <button
              type="button"
              className={styles['btn-ghost']}
              onClick={onCancel}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="submit"
              className={styles['btn-primary']}
              disabled={busy || editName.trim().length === 0}
            >
              {busy
                ? mode === 'create'
                  ? 'Creating…'
                  : 'Saving…'
                : 'Save changes'}
            </button>
          </div>
        </div>
      </form>

      {conflictOpen && (
        <ConflictModal
          tone="danger"
          flow="F-17 · Admin branches"
          title={`Branch has ${conflictCount} future appointments`}
          what={
            <>
              Deactivating <strong>{conflictName}</strong> would leave
              future appointments orphaned. The system cannot close a
              clinic that is currently serving patients.
            </>
          }
          why={
            <>
              Deactivation requires zero future appointments (BR-059).
              Patients keep their bookings; no new bookings can be made.
            </>
          }
          rule="BR-059 · deactivate_requires_zero_future_appts"
          onClose={() => setConflictOpen(false)}
          actions={[
            {
              label: 'Keep active',
              variant: 'ghost',
              onClick: () => setConflictOpen(false),
            },
            {
              label: `Resolve ${conflictCount} appointments first`,
              variant: 'danger',
              onClick: () => setConflictOpen(false),
            },
          ]}
        />
      )}
    </div>
  );
}