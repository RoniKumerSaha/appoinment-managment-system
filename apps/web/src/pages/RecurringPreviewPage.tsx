/**
 * RecurringPreviewPage — E7-E series preview screen (mock 07).
 *
 * Pixel-perfect port of mockup 07
 * (docs/design/mockups/v1/mockups/07-recurring-preview.html).
 *
 * 760px stacked-vertical flow, 4 numbered section cards:
 *   1. Series details (meta-cell grid)
 *   2. Validation summary (create vs skip counts)
 *   3. Occurrences detail (create/skip rows with reasons)
 *   4. Confirm creation (text + Cancel + Edit pattern + Create N →)
 *
 * The page is fed by the REAL preview response (`POST /recurring/preview`)
 * — the owner (DoctorApp / ReceptionistApp) holds the series input and
 * the preview result and passes them down. The "Create N appointments"
 * button calls the owner, which POSTs `/recurring/confirm` with the
 * `preview_id`.
 *
 * Both roles run this flow, so the frame is a prop rather than a
 * hardcoded `<DoctorFrame>`: the receptionist's preview has to sit
 * inside the RECEPTIONIST's nav (their own sections, `#/reception`
 * links), not the doctor's. Rendering `DoctorFrame` here would have
 * given a receptionist the doctor's section links — every one of them
 * a 403.
 */
import type { ReactNode } from 'react';
import { DoctorFrame } from './DoctorFrame';
import { ReceptionistFrame } from './ReceptionistFrame';
import styles from './RecurringPreviewPage.module.css';
import type {
  RecurringPreviewResponse,
  RecurringSkippedOccurrence,
} from '../api/client';

/** Which surface the page is rendered on. */
export type RecurringRole = 'doctor' | 'receptionist';

const CHECKS = [
  'Branch operating hours',
  'Doctor schedule',
  'Doctor blocks',
  'Existing doctor appointments',
  'Patient overlap across doctors',
  'Patient dedup (one per doctor)',
  '30-day booking window',
  'Same-day exclusion',
];

export interface RecurringPreviewLabels {
  patient: string;
  doctor: string;
  branch: string;
  type: string;
}

export interface RecurringPreviewPageProps {
  preview: RecurringPreviewResponse;
  labels: RecurringPreviewLabels;
  /** Number of occurrences the user asked for. The preview response
   *  carries only the surviving occurrences, so the requested count has
   *  to come from the request. */
  requested: number;
  error: string | null;
  busy: boolean;
  onCancel: () => void;
  onEditPattern: () => void;
  onConfirm: () => void;
  /** Which surface to render in. Defaults to the doctor. */
  role?: RecurringRole;
}

function StepNum({ n }: { n: number }): ReactNode {
  return <div className={styles['section-num']}>{n}</div>;
}

/** `2026-11-04` → `Wed, Nov 4`. The local_date is already in the
 *  branch's timezone, so it is rendered as a plain calendar date with
 *  no timezone conversion. */
function formatLocalDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  if (!y || !m || !d) return iso;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  const dow = date.toLocaleDateString('en-US', {
    weekday: 'short',
    timeZone: 'UTC',
  });
  const mon = date.toLocaleDateString('en-US', {
    month: 'short',
    timeZone: 'UTC',
  });
  return `${dow}, ${mon} ${Number(d)}`;
}

/** `2026-11-04T14:00:00.000Z` → `10:00`. The instant is rendered in
 *  the branch's timezone — the hours are wall-clock in that zone, so
 *  the ISO instant alone would be misleading. */
function formatLocalTime(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(iso));
  } catch {
    return '—';
  }
}

function formatRange(
  startIso: string,
  endIso: string,
  tz: string,
): string {
  return `${formatLocalTime(startIso, tz)} – ${formatLocalTime(endIso, tz)}`;
}

/** The server's skip reasons are snake_case codes (`outside_branch_hours`,
 *  `doctor_blocked`, …). The mockup shows them as plain sentences
 *  ("Outside 30-day window"), and the server's vocabulary is a closed
 *  set (`SkipReason` in apps/api/src/routes/recurring-helpers.ts), so
 *  the mapping is safe to keep in one place here.
 *
 *  The fallback keeps the raw code — an unknown reason is still shown
 *  verbatim rather than silently swallowed. */
function humanizeReason(reason: string): string {
  switch (reason) {
    case 'outside_branch_hours':
      return 'Outside branch hours';
    case 'doctor_unavailable':
      return 'Doctor not scheduled';
    case 'doctor_blocked':
      return 'Doctor is blocked';
    case 'doctor_inactive':
      return 'Doctor is inactive';
    case 'branch_inactive':
      return 'Branch is inactive';
    case 'appointment_type_inactive':
      return 'Appointment type is inactive';
    case 'slot_raced':
      return 'Slot was taken by another booking';
    case 'patient_has_future_with_doctor':
      return 'Patient already has an appointment with this doctor';
    case 'patient_time_conflict':
      return 'Patient already has an appointment at that time';
    case 'outside_30d_window':
      return 'Outside the 30-day booking window';
    case 'same_day_exclusion':
      return 'Same-day bookings are not allowed';
    default:
      return reason.replace(/_/g, ' ');
  }
}

export function RecurringPreviewPage({
  preview,
  labels,
  requested,
  error,
  busy,
  onCancel,
  onEditPattern,
  onConfirm,
  role = 'doctor',
}: RecurringPreviewPageProps): ReactNode {
  const creates = preview.will_create;
  const skips: RecurringSkippedOccurrence[] = preview.skipped_with_reason;
  const tz = preview.branch.tz;
  const patternLabel =
    preview.recurrence.kind === 'every_two_weeks'
      ? 'Every 2 weeks'
      : preview.recurrence.kind === 'custom_days'
        ? `Custom · every ${preview.recurrence.interval_days} days`
        : 'Weekly';

  const body = (
    <div className={styles['page']}>
        <header className={styles['page-header']}>
          <h1>Preview recurring series</h1>
          <p className={styles['sub']}>
            Each occurrence was validated independently. Independent appointments once
            created.
          </p>
        </header>

        {error !== null && (
          <div className={styles['footnote']} role="alert">
            {error}
          </div>
        )}

        {/* Step 1 — Series details */}
        <div className={styles['section']}>
          <div className={styles['section-head']}>
            <StepNum n={1} />
            <div style={{ flex: 1 }}>
              <div className={styles['section-title']}>Series details</div>
              <div className={styles['section-sub']}>
                Patient · doctor · branch · type · time · pattern
              </div>
            </div>
          </div>
          <div className={styles['section-body']}>
            <div className={styles['meta-row']}>
              <Cell k="Patient" v={labels.patient} />
              <Cell k="Doctor" v={labels.doctor} />
              <Cell k="Branch" v={labels.branch} />
              <Cell k="Type" v={labels.type} />
              <Cell k="Pattern" v={patternLabel} />
              <Cell
                k="Time"
                v={`${preview.recurrence.time_of_day} · ${preview.recurrence.duration_minutes} min`}
              />
              <Cell
                k="Start"
                v={`${formatLocalDate(preview.recurrence.start_date)} · ${preview.recurrence.time_of_day}`}
              />
              <Cell k="Occurrences" v={`${requested} requested`} />
            </div>
          </div>
        </div>

        {/* Step 2 — Validation summary */}
        <div className={styles['section']}>
          <div className={styles['section-head']}>
            <StepNum n={2} />
            <div style={{ flex: 1 }}>
              <div className={styles['section-title']}>Validation summary</div>
              <div className={styles['section-sub']}>
                Server pre-validated each occurrence (FR-046).
              </div>
            </div>
          </div>
          <div className={styles['section-body']}>
            <div className={styles['summary-card']}>
              <div
                className={`${styles['summary-num']} ${
                  creates.length === 0
                    ? styles['summary-num-ok-empty']
                    : styles['summary-num-ok']
                }`}
              >
                {creates.length}
              </div>
              <div className={styles['summary-text']}>
                <strong>will be created</strong>
                of {requested} requested
              </div>
              <div className={`${styles['summary-num']} ${styles['summary-num-skip']}`}>
                {skips.length}
              </div>
              <div className={styles['summary-text']}>
                <strong>will be skipped</strong>
                {skips.length > 0 ? 'with reasons below' : 'nothing was rejected'}
              </div>
            </div>

            {creates.length === 0 && skips.length > 0 && (
              <div className={styles['all-skipped-note']}>
                <strong>
                  All {skips.length} occurrence{skips.length === 1 ? '' : 's'} failed
                  validation.
                </strong>{' '}
                Nothing can be created from this pattern — the reasons are listed
                below.
              </div>
            )}

            <div className={styles['checks-label']}>
              Checks performed per occurrence
            </div>
            <div className={styles['checks-grid']}>
              {CHECKS.map((c) => (
                <div key={c}>✓ {c}</div>
              ))}
            </div>
          </div>
        </div>

        {/* Step 3 — Occurrences detail */}
        <div className={styles['section']}>
          <div className={styles['section-head']}>
            <StepNum n={3} />
            <div style={{ flex: 1 }}>
              <div className={styles['section-title']}>
                All {creates.length + skips.length} occurrence
                {creates.length + skips.length === 1 ? '' : 's'}
              </div>
              <div className={styles['section-sub']}>
                {creates.length === 0 && skips.length > 0
                  ? 'Every date was rejected — the reason is listed against each one.'
                  : 'Each row shows the validation result for that date.'}
              </div>
            </div>
          </div>
          <div className={styles['section-body']}>
            {/* An empty group heading ("Will be created (0)") is dead
                weight — a label with no rows under it. The group is
                only rendered when it has something in it. */}
            {creates.length > 0 && (
              <>
                <div
                  className={`${styles['group-label']} ${styles['group-label-create']}`}
                >
                  ✓ Will be created ({creates.length})
                </div>
                <div className={styles['occ-list']}>
                  {creates.map((o) => (
                    <div
                      key={`c-${o.index}`}
                      className={`${styles['occ-row']} ${styles['occ-row-create']}`}
                    >
                      <div className={styles['occ-row-date']}>
                        {formatLocalDate(o.local_date)}
                      </div>
                      <div className={styles['occ-row-time']}>
                        {formatRange(o.start_datetime, o.end_datetime, tz)}
                      </div>
                      <span className={styles['occ-row-badge']}>✓ Create</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {skips.length > 0 && (
              <>
                <div
                  className={`${styles['group-label']} ${styles['group-label-skip']}`}
                >
                  — Will be skipped ({skips.length})
                </div>
                <div className={styles['occ-list']}>
                  {skips.map((o) => (
                    <div
                      key={`s-${o.index}`}
                      className={`${styles['occ-row']} ${styles['occ-row-skip']}`}
                    >
                      <div className={styles['occ-row-date']}>
                        {formatLocalDate(o.local_date)}
                      </div>
                      <div className={styles['occ-row-time']}>
                        {formatRange(o.start_datetime, o.end_datetime, tz)}
                      </div>
                      <span className={styles['occ-row-reason']}>
                        {humanizeReason(o.reason)}
                      </span>
                      <span className={styles['occ-row-badge']}>— Skip</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            <div className={styles['footnote']}>
              <strong>Note:</strong> Per-occurrence independence (BR-052). Once created,
              each appointment behaves independently — cancel or reschedule individually.
              Editing the pattern after creation does not retroactively change existing
              appointments.
            </div>
          </div>
        </div>

        {/* Step 4 — Confirm creation */}
        <div className={styles['section']}>
          <div className={styles['section-head']}>
            <StepNum n={4} />
            <div style={{ flex: 1 }}>
              <div className={styles['section-title']}>Confirm creation</div>
              <div className={styles['section-sub']}>
                {creates.length === 0
                  ? 'Nothing to create.'
                  : `Atomic batch insert — all ${creates.length} created or none.`}
              </div>
            </div>
          </div>
          <div className={styles['section-body']}>
            {creates.length === 0 ? (
              <>
                <strong>No appointments will be created.</strong> Every one of the{' '}
                {skips.length} occurrence{skips.length === 1 ? '' : 's'} was rejected
                by the checks above. Adjust the pattern — a different time, day, or
                doctor — and preview again.
              </>
            ) : (
              <>
                Creating <strong>{creates.length} appointment{creates.length === 1 ? '' : 's'}</strong>{' '}
                as an atomic batch. If any one fails (race condition), all are rolled
                back and the slot is released.
                {skips.length > 0 && (
                  <>
                    {' '}
                    The {skips.length} skipped occurrence
                    {skips.length === 1 ? '' : 's'} above will not be created.
                  </>
                )}
              </>
            )}
          </div>
          <div className={styles['section-actions']}>
            <button
              type="button"
              className={styles['btn-ghost']}
              onClick={onCancel}
              disabled={busy}
            >
              Cancel
            </button>
            {/* With nothing to create there is no primary CTA to show —
                a disabled "Create 0 appointments →" button reads as a
                broken control. "Edit pattern" is the only useful
                action left, so it takes the primary slot and the
                secondary copy of it is dropped — two identically
                labelled buttons side by side is worse than one. */}
            {creates.length > 0 ? (
              <>
                <button
                  type="button"
                  className={styles['btn-secondary']}
                  onClick={onEditPattern}
                  disabled={busy}
                >
                  Edit pattern
                </button>
                <button
                  type="button"
                  className={styles['btn-primary']}
                  onClick={onConfirm}
                  disabled={busy}
                >
                  {busy
                    ? 'Creating…'
                    : `Create ${creates.length} appointment${creates.length === 1 ? '' : 's'} →`}
                </button>
              </>
            ) : (
              <button
                type="button"
                className={styles['btn-primary']}
                onClick={onEditPattern}
                disabled={busy}
              >
                Edit pattern
              </button>
            )}
          </div>
        </div>
      </div>
  );

  return role === 'receptionist' ? (
    <ReceptionistFrame activeNav="series">{body}</ReceptionistFrame>
  ) : (
    <DoctorFrame activeNav="series">{body}</DoctorFrame>
  );
}

function Cell({ k, v }: { k: string; v: string }): ReactNode {
  return (
    <div className={styles['meta-cell']}>
      <div className={styles['meta-cell-key']}>{k}</div>
      <div className={styles['meta-cell-value']}>{v}</div>
    </div>
  );
}
