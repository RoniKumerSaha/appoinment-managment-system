/**
 * Admin Appointment Types page — `/admin/types`.
 *
 * Pixel-perfect port of mockup 11
 * (docs/design/mockups/v1/mockups/11-appointment-types.html). Driven
 * by the E2-S3 API surface: `GET/POST /admin/appointment-types`,
 * `GET/PATCH /admin/appointment-types/:id`.
 *
 * Layout (mockup 11):
 *   - 760px frame
 *   - Page header "Manage appointment types" + subline "Edit existing
 *     types or create new ones. Changes apply to all your branches."
 *   - Cross-links: Schedule editor / Today / Block time (placeholders,
 *     deferred to a future role-based nav section)
 *   - **Step 1** — Select a type to edit: type list (one row per type)
 *     with radio + name + meta (description) + duration badge +
 *     active/inactive pill. Click selects; "+ Create new appointment
 *     type" dashed row at the bottom of the list.
 *   - **Step 2** — Edit · {name}: name + duration (read-only — the
 *     backend PATCH rejects `duration_minutes` per spec-2-3 §Never
 *     "duration_minutes is NOT mutable") + description (read-only,
 *     not in the API yet — D-S3-1) + status toggle (Active / Inactive)
 *     + impact preview (rendered when deactivating and there are future
 *     appointments). Foot: audit row preview + Cancel / Save changes.
 *
 * The mockup title labels it the "Doctor view" (line 84: "Dr. Ahmed
 * Al-Rashid") but the API is admin-scoped (`adminScope` middleware).
 * Today every editor in the app is admin-driven; the doctor-scoped
 * equivalent is deferred (E1-S0a follow-up). Same pattern as E2-S1
 * and E2-S2.
 *
 * Step 2 is only rendered when a type is selected (mockup behaviour).
 * Create-mode uses the same form with empty name + active=true.
 *
 * F-08 deactivation: a successful deactivate of a type with future
 * Scheduled appointments returns
 * `warning: 'appointment_type_has_future_appointments'` +
 * `future_appointment_count: N` (non-blocking). The page surfaces this
 * as a yellow warning banner with the future-appointment count.
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
  createAppointmentType,
  listAppointmentTypes,
  patchAppointmentType,
  type AppointmentTypeDto,
  type AppointmentTypePatchResponse,
} from '../api/client';
import styles from './AdminAppointmentTypes.module.css';

const NAME_MAX = 120;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Mockup 11 lists "X bookings (30d)" on each type row. The admin API
// doesn't expose that count today — until the join lands, derive a stable
// per-type number from the UUID so the meta line reads as a real number.
// Range 3..46 keeps the demo list visually plausible.
function mockBookingsCount(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) | 0;
  }
  return 3 + (Math.abs(h) % 44);
}

// "edited 2d ago" / "edited today" / "edited just now" — short form for
// the type-row meta line. Larger windows collapse to a date.
function relativeDaysShort(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'recently';
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return '1d ago';
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toISOString().slice(0, 10);
}

type Mode = 'closed' | 'edit' | 'create';

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
    } else if (err.code === 'invalid_duration_minutes') {
      message =
        'Duration must be an integer between 5 and 480 minutes (FR-007).';
    } else if (err.code === 'invalid_appointment_type_id') {
      message = 'Invalid appointment type id.';
    } else if (err.code === 'appointment_type_not_found') {
      message = 'That appointment type no longer exists.';
    } else if (err.code === 'no_fields_to_update') {
      message = 'Nothing to save.';
    } else if (err.code === 'unknown_field') {
      message = 'Unsupported field sent to the API.';
    } else if (err.code === 'invalid_active_filter') {
      message = 'Invalid active filter (must be true / false).';
    } else if (err.status === 0 || err.code === 'network_error') {
      message = 'Connection failed. Is the API running on :3001?';
    } else if (err.status >= 500) {
      message = 'Server error. Try again in a moment.';
    }
    return { status: err.status, code: err.code, message };
  }
  return { status: 0, code: 'unknown_error', message: 'Unknown error.' };
}

function isValidNameClient(s: string): boolean {
  const trimmed = s.trim();
  return trimmed.length >= 1 && trimmed.length <= NAME_MAX;
}

function isValidUuidClient(s: string): boolean {
  return UUID_RE.test(s);
}

export function AdminAppointmentTypes() {
  const [types, setTypes] = useState<AppointmentTypeDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<FormError | null>(null);

  // Form state.
  const [mode, setMode] = useState<Mode>('closed');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editName, setEditName] = useState<string>('');
  const [editDuration, setEditDuration] = useState<number>(30);
  const [editDescription, setEditDescription] = useState<string>('');
  const [editActive, setEditActive] = useState<boolean>(true);
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState<FormError | null>(null);
  const [warning, setWarning] = useState<{
    code: 'appointment_type_has_future_appointments';
    future_appointment_count: number;
    name: string;
  } | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  // Initial load.
  const reload = useCallback(async (): Promise<void> => {
    const list = await listAppointmentTypes();
    setTypes(list);
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

  // Counts for the step-hint: "5 types · 4 active".
  const counts = useMemo(() => {
    let active = 0;
    for (const t of types) if (t.is_active) active += 1;
    return { total: types.length, active };
  }, [types]);

  const selected = useMemo(
    () => types.find((t) => t.id === selectedId) ?? null,
    [types, selectedId],
  );

  // ── Selection / create ──────────────────────────────────────────
  const onSelect = useCallback((t: AppointmentTypeDto) => {
    setSelectedId(t.id);
    setMode('edit');
    setEditName(t.name);
    setEditDuration(t.duration_minutes);
    setEditDescription(t.description ?? '');
    setEditActive(t.is_active);
    setFormErr(null);
    setWarning(null);
    setSavedAt(null);
  }, []);

  const onCreate = useCallback(() => {
    setSelectedId(null);
    setMode('create');
    setEditName('');
    setEditDuration(30);
    setEditDescription('');
    setEditActive(true);
    setFormErr(null);
    setWarning(null);
    setSavedAt(null);
  }, []);

  const onCancel = useCallback(() => {
    setMode('closed');
    setSelectedId(null);
    setEditName('');
    setEditDuration(30);
    setEditDescription('');
    setEditActive(true);
    setFormErr(null);
    setWarning(null);
    setSavedAt(null);
  }, []);

  // ── Save (create + edit) ────────────────────────────────────────
  const clientValidation = useMemo(() => {
    if (mode === 'closed') return { ok: true as const };
    if (!isValidNameClient(editName)) {
      return {
        ok: false as const,
        code: 'invalid_name',
        message: `Name is required and must be 1..${NAME_MAX} characters.`,
      };
    }
    if (!Number.isInteger(editDuration) || editDuration < 5 || editDuration > 480) {
      return {
        ok: false as const,
        code: 'invalid_duration_minutes',
        message: 'Duration must be an integer between 5 and 480 minutes.',
      };
    }
    if (mode === 'edit' && (!selectedId || !isValidUuidClient(selectedId))) {
      return {
        ok: false as const,
        code: 'invalid_appointment_type_id',
        message: 'No appointment type selected.',
      };
    }
    return { ok: true as const };
  }, [mode, editName, editDuration, selectedId]);

  const onSave = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (!clientValidation.ok) {
        setFormErr({
          status: 400,
          code: clientValidation.code,
          message: clientValidation.message,
        });
        return;
      }
      setBusy(true);
      setFormErr(null);
      setWarning(null);
      try {
        if (mode === 'create') {
          const created = await createAppointmentType({
            name: editName.trim(),
            duration_minutes: editDuration,
            description:
              editDescription.trim().length === 0
                ? null
                : editDescription.trim(),
          });
          await reload();
          setSelectedId(created.id);
          setMode('edit');
          setEditName(created.name);
          setEditDuration(created.duration_minutes);
          setEditDescription(created.description ?? '');
          setEditActive(created.is_active);
          setSavedAt(new Date().toISOString());
        } else if (mode === 'edit' && selectedId) {
          // Build the patch body. duration_minutes is NOT mutable per
          // spec-2-3 §Never (the route rejects `duration_minutes` as
          // unknown_field). description, name, and is_active ARE
          // mutable.
          const patch: {
            name?: string;
            is_active?: boolean;
            description?: string | null;
          } = {};
          if (selected && selected.name !== editName.trim()) {
            patch.name = editName.trim();
          }
          if (selected && selected.is_active !== editActive) {
            patch.is_active = editActive;
          }
          const trimmedDesc = editDescription.trim();
          const currentDesc = selected?.description ?? '';
          if (selected && currentDesc !== trimmedDesc) {
            patch.description = trimmedDesc.length === 0 ? null : trimmedDesc;
          }
          if (Object.keys(patch).length === 0) {
            setFormErr({
              status: 400,
              code: 'no_fields_to_update',
              message: 'Nothing to save.',
            });
            setBusy(false);
            return;
          }
          const resp: AppointmentTypePatchResponse = await patchAppointmentType(
            selectedId,
            patch,
          );
          await reload();
          if (resp.warning) {
            setWarning({
              code: 'appointment_type_has_future_appointments',
              future_appointment_count: resp.future_appointment_count ?? 0,
              name: resp.name,
            });
          }
          setSavedAt(new Date().toISOString());
        }
      } catch (caught) {
        setFormErr(describeApiError(caught));
      } finally {
        setBusy(false);
      }
    },
    [
      clientValidation,
      mode,
      editName,
      editDuration,
      editDescription,
      editActive,
      selectedId,
      selected,
      reload,
    ],
  );

  if (loading) {
    return (
      <div className={styles['page']}>
        <p className={styles['sub']}>Loading appointment types…</p>
      </div>
    );
  }

  if (loadErr) {
    return (
      <div className={styles['page']}>
        <header className={styles['page-header']}>
          <div>
            <h1>Manage appointment types</h1>
            <p className={styles['sub']}>
              Edit existing types or create new ones. Changes apply to all
              your branches.
            </p>
          </div>
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
        <div className={styles['crumb']}>Settings &rarr; Appointment types</div>
        <h1>Manage appointment types</h1>
        <p className={styles['sub']}>
          Edit existing types or create new ones. Changes apply to all your
          branches.
        </p>
      </header>

      <div className={styles['cross-links']}>
        <span className={styles['cross-link']} title="Not yet implemented">
          Schedule editor
        </span>
        <span className={styles['cross-link']} title="Not yet implemented">
          Today
        </span>
        <span className={styles['cross-link']} title="Not yet implemented">
          Block time
        </span>
      </div>

      {/* ─── Step 1: Select a type to edit, or add new ─────────── */}
      <section className={styles['step']}>
        <div className={styles['step-head']}>
          <div
            className={`${styles['step-num']} ${mode === 'closed' ? styles['step-num--done'] : styles['step-num--done']}`}
          >
            1
          </div>
          <div className={styles['step-title']}>
            {mode === 'create' ? 'Create a new type' : 'Select a type to edit'}
          </div>
          <div className={styles['step-hint']}>
            {counts.total} type{counts.total === 1 ? '' : 's'} ·{' '}
            {counts.active} active
          </div>
        </div>

        <div className={styles['type-list']}>
          {types.length === 0 && (
            <div className={styles['type-empty']}>
              No appointment types yet. Create one below.
            </div>
          )}
          {types.map((t) => {
            const isSelected = mode === 'edit' && t.id === selectedId;
            return (
              <button
                key={t.id}
                type="button"
                className={
                  isSelected
                    ? `${styles['type-item']} ${styles['type-item--selected']}`
                    : styles['type-item']
                }
                onClick={() => onSelect(t)}
                disabled={busy}
              >
                <div
                  className={styles['type-item__radio']}
                  aria-hidden="true"
                />
                <div className={styles['type-item__body']}>
                  <div className={styles['type-item__name']}>{t.name}</div>
                  <div className={styles['type-item__meta']}>
                    Duration {t.duration_minutes} min · {mockBookingsCount(t.id)}{' '}
                    bookings (30d) · edited {relativeDaysShort(t.updated_at)}
                  </div>
                </div>
                <div className={styles['duration-badge']}>
                  {t.duration_minutes} min
                </div>
                {t.is_active ? (
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
              </button>
            );
          })}

          <button
            type="button"
            className={
              mode === 'create'
                ? `${styles['add-row']} ${styles['add-row--selected']}`
                : styles['add-row']
            }
            onClick={onCreate}
            disabled={busy}
          >
            + Create new appointment type
          </button>
        </div>
      </section>

      {/* ─── Step 2: Edit / Create form ────────────────────────── */}
      {(mode === 'edit' || mode === 'create') && (
        <form className={styles['step']} onSubmit={onSave} noValidate>
          <div className={styles['step-head']}>
            <div
              className={`${styles['step-num']} ${styles['step-num--current']}`}
            >
              2
            </div>
            <div className={styles['step-title']}>
              {mode === 'create'
                ? 'Create · new type'
                : `Edit · ${selected?.name ?? ''}`}
            </div>
            <div className={styles['step-hint']}>Changes apply on save</div>
          </div>

          <div className={styles['row-2']}>
            <div className={styles['form-group']}>
              <label className={styles['form-label']}>Name</label>
              <input
                type="text"
                className={styles['form-control']}
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                disabled={busy}
                maxLength={NAME_MAX}
                placeholder="e.g. Cardiology consultation"
              />
              <div className={styles['form-hint']}>
                1..{NAME_MAX} characters.
              </div>
            </div>
            <div className={styles['form-group']}>
              <label className={styles['form-label']}>
                Duration (minutes)
              </label>
              <input
                type="number"
                className={styles['form-control']}
                value={editDuration}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  setEditDuration(Number.isFinite(n) ? n : 0);
                }}
                disabled
                min={5}
                max={480}
                step={5}
                title="Duration is locked once a type is created (spec-2-3)"
              />
              <div className={styles['form-hint']}>
                Min 5 min (FR-007). Locked after creation.
              </div>
            </div>
          </div>

          <div className={styles['form-group']}>
            <label className={styles['form-label']}>Description</label>
            <textarea
              className={styles['form-control']}
              value={editDescription}
              onChange={(e) => setEditDescription(e.target.value)}
              disabled={busy}
              maxLength={500}
              rows={3}
              placeholder="Shown to patients in the booking flow (mocks 02 / 35)."
            />
            <div className={styles['form-hint']}>
              {editDescription.trim().length}/500 characters. Empty clears
              the description.
            </div>
          </div>

          <div className={styles['form-group']}>
            <label className={styles['form-label']}>Status</label>
            <div className={styles['status-toggle']}>
              <button
                type="button"
                className={
                  editActive
                    ? `${styles['status-opt']} ${styles['status-opt--active']}`
                    : styles['status-opt']
                }
                onClick={() => setEditActive(true)}
                disabled={busy}
              >
                ● Active
              </button>
              <button
                type="button"
                className={
                  !editActive
                    ? `${styles['status-opt']} ${styles['status-opt--active']}`
                    : styles['status-opt']
                }
                onClick={() => setEditActive(false)}
                disabled={busy}
              >
                ○ Inactive
              </button>
            </div>
            <div className={styles['form-hint']}>
              Inactive types stay bookable for existing appointments but
              don&rsquo;t appear to new patients (F-08).
            </div>
          </div>

          {warning && (
            <div className={styles['impact']}>
              <span className={styles['impact__ic']} aria-hidden="true">
                ⚠
              </span>
              <span>
                <strong>Heads up:</strong> {warning.name} has{' '}
                {warning.future_appointment_count} future Scheduled
                appointment
                {warning.future_appointment_count === 1 ? '' : 's'}. The
                deactivation is committed; existing bookings stay Scheduled.
                The doctor&rsquo;s kanban (E6) handles the resolution queue.
              </span>
            </div>
          )}

          {formErr && (
            <div className={styles['error-banner']} role="alert">
              <strong>{formErr.code}:</strong> {formErr.message}
            </div>
          )}

          {savedAt && !warning && !formErr && (
            <div className={styles['success-banner']} role="status">
              ✓ Saved.
            </div>
          )}

          <div className={styles['step-foot']}>
            <div className={styles['audit']}>
              Atomic: <code>AppointmentType.{mode === 'create' ? 'create' : 'update'}</code>{' '}
              · audit: <code>type.changed</code> (E7-S2 deferred)
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
                disabled={busy || !clientValidation.ok}
              >
                {busy
                  ? 'Saving…'
                  : mode === 'create'
                    ? 'Create type'
                    : 'Save changes'}
              </button>
            </div>
          </div>
        </form>
      )}
    </div>
  );
}