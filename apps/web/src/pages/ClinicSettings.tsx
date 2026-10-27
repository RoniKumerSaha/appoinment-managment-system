/**
 * Clinic settings page — `/admin/clinic`.
 *
 * Pixel-perfect port of mockup 32 (docs/design/mockups/v1/mockups/32-admin-clinic-settings.html).
 * The page is driven entirely by the `ClinicDto` from `GET /admin/clinic`; the
 * tagline and 3 read-only identity rows are static (mockup-content — not
 * stored in the DB today).
 *
 * Behaviour:
 *   - On mount: fetch the clinic. Loading / error / data states.
 *   - Identity card: input is uncontrolled-ish (we mirror the API's
 *     `name` into local state on load and on save).
 *   - `Save clinic name` fires PATCH /admin/clinic; on 200 the input is
 *     replaced with the API response and `getClinic()` is re-fetched to
 *     pick up the bumped `updated_at`. `Cancel` discards the dirty edit.
 *   - `Discard changes` resets `draftName` to the API's `name`.
 *   - `View audit log` opens the inline "Audit access policy" card
 *     (per the E7-S2 D-E7-S-UI-1 deferral: admins do not see
 *     appointment audit rows per PRD §2.4; the card documents what
 *     they don't see and why). No back-end call.
 *   - Stat tiles link to the deeper admin sections via the parent
 *     router's `onNavigate`.
 *   - "Deactivate clinic…" navigates to `/admin/branches` where the
 *     actual branch-deactivate flow (mocks 38/42) lives today.
 *     Clinic-level deactivation is a separate future story (E1-S5 or
 *     later) — no clinic-level endpoint exists yet. The button is
 *     preserved for mockup parity; the navigation is the closest
 *     working affordance today.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError, getClinic, patchClinic, type ClinicDto } from '../api/client';
import type { AdminSection } from '../AppShell';
import { Link } from '../router/usePathRoute';
import styles from './ClinicSettings.module.css';

const NAME_MAX = 120;

// Mockup 32's static read-only rows. These are NOT in the database; the
// mockup shows them for context. Real admin identity metadata (the
// `admin` row's full_name) is out of scope for E1-S0-ui; future stories
// will surface it here.
const IDENTITY_DEPLOYMENT_REGION = 'me-central-1 · Riyadh, KSA';
const IDENTITY_CREATED_BY = 'Sara Al-Otaibi';
const IDENTITY_TAGLINE = 'Boring software that gets appointments right.';

function formatCreated(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function pluralActive(n: number): string {
  return n === 1 ? '1 active' : `${n.toLocaleString()} active`;
}

interface CountsViewModel {
  branches: { total: number; active: number; inactive: number };
  doctors: { total: number; active: number; inactive: number };
  receptionists: { total: number; active: number; inactive: number };
  patients: { total: number };
}

function toCountsViewModel(c: ClinicDto['counts']): CountsViewModel {
  return {
    branches: {
      total: c.branches_total,
      active: c.branches_active,
      inactive: c.branches_inactive,
    },
    doctors: {
      total: c.doctors_total,
      active: c.doctors_active,
      inactive: c.doctors_inactive,
    },
    receptionists: {
      total: c.receptionists_total,
      active: c.receptionists_active,
      inactive: c.receptionists_inactive,
    },
    patients: { total: c.patients_total },
  };
}

function StatTile({
  label,
  num,
  sub,
  to,
}: {
  label: string;
  num: number;
  sub: React.ReactNode;
  to?: string;
}) {
  if (to) {
    return (
      <Link className={styles.stat} to={to}>
        <div className={styles['stat__label']}>{label}</div>
        <div className={styles['stat__num']}>{num.toLocaleString()}</div>
        <div className={styles['stat__sub']}>{sub}</div>
      </Link>
    );
  }
  return (
    <div className={styles.stat} style={{ cursor: 'default' }}>
      <div className={styles['stat__label']}>{label}</div>
      <div className={styles['stat__num']}>{num.toLocaleString()}</div>
      <div className={styles['stat__sub']}>{sub}</div>
    </div>
  );
}

export function ClinicSettings({
  onNavigate,
}: {
  onNavigate?: (section: AdminSection) => void;
} = {}) {
  const [data, setData] = useState<ClinicDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [draftName, setDraftName] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [auditCardOpen, setAuditCardOpen] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const dto = await getClinic();
      setData(dto);
      setDraftName(dto.name);
    } catch (err) {
      setLoadError(
        err instanceof ApiError
          ? `${err.status} ${err.code}`
          : 'network_error',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const dirty = data != null && draftName !== data.name;
  const trimmedDraft = draftName.trim();
  const draftValid =
    trimmedDraft.length >= 1 && trimmedDraft.length <= NAME_MAX;
  const canSave = dirty && draftValid && !saving;

  async function saveName() {
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      const dto = await patchClinic(trimmedDraft);
      setData(dto);
      setDraftName(dto.name);
    } catch (err) {
      setSaveError(
        err instanceof ApiError
          ? `${err.status} ${err.code}`
          : 'network_error',
      );
    } finally {
      setSaving(false);
    }
  }

  function onSaveNameSubmit(e: FormEvent) {
    e.preventDefault();
    void saveName();
  }

  function onCancelName() {
    if (data) setDraftName(data.name);
    setSaveError(null);
  }

  function onDiscardChanges() {
    if (data) setDraftName(data.name);
    setSaveError(null);
  }

  function onViewAuditLog() {
    // E7-S2 D-E7-S-UI-1: admins don't see appointment audit (PRD §2.4).
    // The "View audit log" button opens a static policy card explaining
    // what they don't see and why. No back-end call.
    setAuditCardOpen((v) => !v);
  }

  function onDeactivateClinic() {
    // Clinic-level deactivation is a future story (E1-S5+). The
    // closest working affordance today is the branch-deactivate flow
    // on `/admin/branches` (mocks 38/42, with the BR-059 ConflictModal
    // when a branch has future appointments). Navigate the admin to
    // that surface; if the parent didn't pass `onNavigate` (e.g. in
    // isolation), fall back to a hash-route for development.
    if (onNavigate) {
      onNavigate('branches');
    } else {
      window.location.hash = '#branches';
    }
  }

  if (loading && !data) {
    return (
      <div className={styles.status} role="status" aria-live="polite">
        Loading clinic…
      </div>
    );
  }

  if (loadError && !data) {
    return (
      <div className={`${styles.status} ${styles['status--error']}`} role="alert">
        Could not load clinic settings: {loadError}
        <div className={styles['status__retry']}>
          <button
            type="button"
            className={styles['btn-secondary']}
            onClick={() => void refresh()}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!data) {
    return null;
  }

  const vm = toCountsViewModel(data.counts);

  return (
    <div className={styles.page}>
      {/* Breadcrumb */}
      <div className={styles.crumb}>
        <Link to="#/admin/clinic">Admin</Link>
        <span className={styles['crumb__sep']}>›</span>
        <span className={styles['crumb__here']}>Clinic settings</span>
      </div>

      {/* Page header */}
      <div className={styles['page-header']}>
        <div className={styles['page-header__title']}>
          <h1>Clinic settings</h1>
          <div className={styles['page-header__sub']}>
            Edit clinic identity and review what&rsquo;s running across every branch.
          </div>
        </div>
        <div className={styles['page-header__actions']}>
          <button
            type="button"
            className={styles['btn-ghost']}
            onClick={onViewAuditLog}
            aria-expanded={auditCardOpen}
            aria-controls="audit-policy-card"
          >
            View audit log
          </button>
          <button
            type="button"
            className={styles['btn-secondary']}
            onClick={onDiscardChanges}
            disabled={!dirty || saving}
          >
            Discard changes
          </button>
          <button
            type="button"
            className={styles['btn-primary']}
            onClick={() => void saveName()}
            disabled={!canSave}
            aria-label="Save clinic"
          >
            {saving ? 'Saving…' : 'Save clinic'}
          </button>
        </div>
      </div>

      {/* Single-clinic note */}
      {auditCardOpen && (
        <section
          id="audit-policy-card"
          className={styles['audit-card']}
          role="region"
          aria-label="Audit access policy"
        >
          <div className={styles['audit-card__head']}>
            <div className={styles['audit-card__icon']} aria-hidden="true">
              ⓘ
            </div>
            <div>
              <div className={styles['audit-card__title']}>
                Audit access policy
              </div>
              <div className={styles['audit-card__hint']}>
                Why you don&apos;t see appointment audit rows here.
              </div>
            </div>
            <button
              type="button"
              className={styles['audit-card__close']}
              onClick={onViewAuditLog}
              aria-label="Close"
            >
              ×
            </button>
          </div>
          <div className={styles['audit-card__body']}>
            <p className={styles['audit-card__lead']}>
              Per PRD §2.4 (Privacy boundaries), admins do{' '}
              <strong>not</strong> see appointment-level audit rows.
              Appointment audit captures patient identifiers and clinical
              reasoning — surfacing it on the admin role would re-introduce
              a clinician-grade read into the operator seat, which the
              product&apos;s privacy posture explicitly forbids.
            </p>
            <ul className={styles['audit-card__list']}>
              <li>
                <strong>What you can&apos;t see:</strong> appointment create /
                cancel / reschedule / status-marked / recurring-created
                audit rows, or branch / doctor / receptionist /
                appointment-type change events — configuration audit is
                not captured yet.
              </li>
              <li>
                <strong>Who can see appointment audit:</strong> the
                assigned doctor (via{' '}
                <code>GET /doctor/appointments/:id/audit</code>) and the
                receptionist at that branch (via{' '}
                <code>GET /reception/appointments/:id/audit</code>).
              </li>
            </ul>
            <p className={styles['audit-card__foot']}>
              The full policy envelope is on the{' '}
              <Link className={styles['audit-card__foot-link']} to="#/admin/audit">
                Audit log
              </Link>{' '}
              page (renders <code>GET /admin/audit</code>).
            </p>
          </div>
        </section>
      )}

      {/* Single-clinic note */}
      <div className={styles['info-banner']}>
        <div className={styles['info-banner__icon']} aria-hidden="true">i</div>
        <div className={styles['info-banner__copy']}>
          <strong>Single-clinic deployment.</strong> All branches, doctors,
          receptionists, and patients in this system belong to one clinic.
          The data model is multi-tenant-ready; expanding to multiple
          clinics is a future-deployment concern, not a UX change here.
        </div>
      </div>

      {/* Identity card */}
      <form
        className={styles.card}
        onSubmit={onSaveNameSubmit}
        noValidate
      >
        <header className={styles['card-head']}>
          <div className={styles['card-head__title']}>Clinic identity</div>
          <div className={styles['card-head__hint']}>
            Visible to every patient during booking and to staff in the topbar.
          </div>
        </header>

        <div className={styles['card-body']}>
          <div className={styles['divider-label']}>Display name</div>
          <div className={styles['form-row']}>
            <div className={styles['form-row__label']}>
              Clinic name <span className={styles.req}>*</span>
            </div>
            <div className={styles['form-row__field']}>
              <input
                type="text"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                maxLength={NAME_MAX}
                aria-label="Clinic name"
              />
              <div className={styles['form-row__meta']}>
                Shown to patients on the landing page and in confirmation emails.
              </div>
            </div>
          </div>
          <div className={styles['form-row']}>
            <div className={styles['form-row__label']}>Display tagline</div>
            <div className={styles['form-row__field']}>
              <input
                type="text"
                value={IDENTITY_TAGLINE}
                disabled
                aria-label="Display tagline"
              />
              <div className={styles['form-row__meta']}>
                Optional. Up to 80 characters.
              </div>
            </div>
          </div>
        </div>

        <div className={`${styles['card-body']} ${styles['card-body--tight']}`}>
          <div className={styles['divider-label']}>
            Configuration keys (read-only)
          </div>
          <div className={styles['readonly-row']}>
            <div className={styles['readonly-row__label']}>Clinic ID</div>
            <div className={styles['readonly-row__value']}>{data.id}</div>
          </div>
          <div className={styles['readonly-row']}>
            <div className={styles['readonly-row__label']}>
              Deployment region
            </div>
            <div className={styles['readonly-row__value']}>
              {IDENTITY_DEPLOYMENT_REGION}
            </div>
          </div>
          <div className={styles['readonly-row']}>
            <div className={styles['readonly-row__label']}>Created</div>
            <div className={styles['readonly-row__value']}>
              {formatCreated(data.created_at)} · by {IDENTITY_CREATED_BY}
            </div>
          </div>
        </div>

        <footer className={styles['card-foot']}>
          {saveError && (
            <span
              role="alert"
              style={{
                color: 'var(--danger-strong)',
                fontSize: 'var(--text-sm)',
                marginRight: 'auto',
                alignSelf: 'center',
              }}
            >
              Save failed: {saveError}
            </span>
          )}
          <button
            type="button"
            className={styles['btn-ghost']}
            onClick={onCancelName}
            disabled={!dirty || saving}
          >
            Cancel
          </button>
          <button
            type="submit"
            className={styles['btn-primary']}
            disabled={!canSave}
            aria-label="Save clinic name"
          >
            {saving ? 'Saving…' : 'Save clinic name'}
          </button>
        </footer>
      </form>

      {/* Operational snapshot */}
      <section className={styles.card}>
        <header className={styles['card-head']}>
          <div className={styles['card-head__title']}>Operational snapshot</div>
          <div className={styles['card-head__hint']}>
            Live counts. Click a tile to jump into that section.
          </div>
        </header>

        <div className={styles.stats}>
          <StatTile
            label="Branches"
            num={vm.branches.total}
            to="#/admin/branches"
            sub={
              <>
                <span className={styles.ok}>{pluralActive(vm.branches.active)}</span>
                {vm.branches.inactive > 0 && (
                  <> · {vm.branches.inactive} inactive</>
                )}
              </>
            }
          />
          <StatTile
            label="Doctors"
            num={vm.doctors.total}
            to="#/admin/doctors"
            sub={
              <>
                <span className={styles.ok}>{pluralActive(vm.doctors.active)}</span>
                {vm.doctors.inactive > 0 && (
                  <> · {vm.doctors.inactive} inactive</>
                )}
              </>
            }
          />
          <StatTile
            label="Receptionists"
            num={vm.receptionists.total}
            to="#/admin/receptionists"
            sub={
              <>
                <span className={styles.ok}>
                  {pluralActive(vm.receptionists.active)}
                </span>
                {vm.receptionists.inactive > 0 && (
                  <> · {vm.receptionists.inactive} inactive</>
                )}
              </>
            }
          />
          <StatTile
            label="Patients"
            num={vm.patients.total}
            sub={null}
          />
        </div>

        <div className={styles.quicklinks}>
          <Link className={styles.qlink} to="#/admin/branches">
            <div className={styles['qlink__ic']} aria-hidden="true">⌂</div>
            <div className={styles['qlink__body']}>
              <div className={styles['qlink__t']}>Manage branches</div>
              <div className={styles['qlink__s']}>
                Add, edit, deactivate branches · operating hours
              </div>
            </div>
            <div className={styles['qlink__arr']} aria-hidden="true">›</div>
          </Link>
          <Link className={styles.qlink} to="#/admin/doctors">
            <div className={styles['qlink__ic']} aria-hidden="true">✚</div>
            <div className={styles['qlink__body']}>
              <div className={styles['qlink__t']}>Manage doctors</div>
              <div className={styles['qlink__s']}>
                Create, deactivate, assign branches
              </div>
            </div>
            <div className={styles['qlink__arr']} aria-hidden="true">›</div>
          </Link>
          <Link className={styles.qlink} to="#/admin/receptionists">
            <div className={styles['qlink__ic']} aria-hidden="true">☎</div>
            <div className={styles['qlink__body']}>
              <div className={styles['qlink__t']}>Manage receptionists</div>
              <div className={styles['qlink__s']}>One branch per receptionist</div>
            </div>
            <div className={styles['qlink__arr']} aria-hidden="true">›</div>
          </Link>
        </div>
      </section>

      {/* Booking policy */}
      <section className={styles.card}>
        <header className={styles['card-head']}>
          <div className={styles['card-head__title']}>Booking policy</div>
          <div className={styles['card-head__hint']}>
            MVP constants. Promoting these to admin-editable is a future
            consideration (PRD §14).
          </div>
        </header>
        <div className={styles['card-body']}>
          <div className={styles['readonly-row']}>
            <div className={styles['readonly-row__label']}>Booking window</div>
            <div className={styles['readonly-row__value']}>30 days (fixed)</div>
          </div>
          <div className={styles['readonly-row']}>
            <div className={styles['readonly-row__label']}>
              Same-day booking
            </div>
            <div className={styles['readonly-row__value']}>
              Not allowed · earliest is tomorrow
            </div>
          </div>
          <div className={styles['readonly-row']}>
            <div className={styles['readonly-row__label']}>
              Buffer between appointments
            </div>
            <div className={styles['readonly-row__value']}>
              None · back-to-back slots
            </div>
          </div>
          <div className={styles['readonly-row']}>
            <div className={styles['readonly-row__label']}>
              Recurring series cap
            </div>
            <div className={styles['readonly-row__value']}>
              30-day window
            </div>
          </div>
          <div className={styles['readonly-row']}>
            <div className={styles['readonly-row__label']}>
              Patient authentication
            </div>
            <div className={styles['readonly-row__value']}>
              SMS OTP · 5-min TTL · 3-attempt cap / 10-min lockout
            </div>
          </div>
        </div>
      </section>

      {/* Danger zone */}
      <section className={`${styles.card} ${styles['card--danger']}`}>
        <header className={`${styles['card-head']} ${styles['card-head--danger']}`}>
          <div className={`${styles['card-head__title']} ${styles['card-head__title--danger']}`}>
            Danger zone
          </div>
          <div className={styles['card-head__hint']}>
            Affects every patient and staff user. Requires typed confirmation.
          </div>
        </header>
        <div className={styles['card-body']}>
          <div className={styles['danger-body']}>
            <div className={styles['danger-body__copy']}>
              <div className={styles['danger-body__t']}>Deactivate this clinic</div>
              <div className={styles['danger-body__s']}>
                Stops every booking across every branch. Existing appointments
                remain Scheduled; you&rsquo;ll need to cancel them individually.
              </div>
            </div>
            <button
              type="button"
              className={styles['btn-danger-secondary']}
              onClick={onDeactivateClinic}
            >
              Deactivate clinic…
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
