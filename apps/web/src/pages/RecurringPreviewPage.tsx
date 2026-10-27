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
 * — the owner (DoctorApp) holds the series input and the preview result
 * and passes them down. The "Create N appointments" button calls the
 * owner, which POSTs `/recurring/confirm` with the `preview_id`.
 */
import type { ReactNode } from 'react';
import { DoctorFrame } from './DoctorFrame';
import styles from './RecurringPreviewPage.module.css';
import type {
  RecurringPreviewResponse,
  RecurringSkippedOccurrence,
} from '../api/client';

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
 *  `doctor_blocked`, …). They are rendered as-is — the server owns the
 *  vocabulary, and inventing a display label here would let the two
 *  drift apart. */
function humanizeReason(reason: string): string {
  return reason.replace(/_/g, ' ');
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

  return (
    <DoctorFrame>
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
              <div className={`${styles['summary-num']} ${styles['summary-num-ok']}`}>
                {creates.length}
              </div>
              <div className={styles['summary-text']}>
                <strong>will be created</strong>of {requested} requested
              </div>
              <div className={`${styles['summary-num']} ${styles['summary-num-skip']}`}>
                {skips.length}
              </div>
              <div className={styles['summary-text']}>
                <strong>will be skipped</strong>with reasons below
              </div>
            </div>

            <div className={styles['checks-label']}>
              Checks performed per occurrence
            </div>
            <div className={styles['checks-grid']}>
              {CHECKS.map((c) => (
                <div key={c}>➜“ {c}</div>
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
                All {creates.length + skips.length} occurrences
              </div>
              <div className={styles['section-sub']}>
                Each row shows the validation result for that date.
              </div>
            </div>
          </div>
          <div className={styles['section-body']}>
            <div
              className={`${styles['group-label']} ${styles['group-label-create']}`}
            >
              ➜“ Will be created ({creates.length})
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
                  <span className={styles['occ-row-badge']}>➜“ Create</span>
                </div>
              ))}
            </div>

            <div
              className={`${styles['group-label']} ${styles['group-label-skip']}`}
            >
              ➜— Will be skipped ({skips.length})
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
                  <span className={styles['occ-row-badge']}>➜— Skip</span>
                </div>
              ))}
            </div>

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
                Atomic batch insert — all {creates.length} created or none.
              </div>
            </div>
          </div>
          <div className={styles['section-body']}>
            Creating <strong>{creates.length} appointments</strong> as an atomic batch.
            If any one fails (race condition), all are rolled back and the slot is
            released.
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
              disabled={busy || creates.length === 0}
            >
              {busy ? 'Creating…' : `Create ${creates.length} appointments →`}
            </button>
          </div>
        </div>
      </div>
    </DoctorFrame>
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
