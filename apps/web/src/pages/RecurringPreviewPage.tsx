/**
 * RecurringPreviewPage — E7-E series preview screen (mock 07).
 *
 * Pixel-perfect port of mockup 07
 * (docs/design/mockups/v1/mockups/07-recurring-preview.html).
 *
 * 760px stacked-vertical flow, 4 numbered section cards:
 *   1. Series details (meta-cell grid)
 *   2. Validation summary (create vs skip counts)
 *   3. Occurrences detail (4 create, 2 skip with footnote)
 *   4. Confirm creation (text + Cancel + Edit pattern + Create 4 →)
 *
 * No tests in this pass (per user instruction).
 */
import type { ReactNode } from 'react';
import { DoctorFrame } from './DoctorFrame';
import styles from './RecurringPreviewPage.module.css';

interface Occurrence {
  date: string;
  time: string;
  status: 'create' | 'skip';
  reason?: string;
}

const SERIES = {
  patient: 'Sara M. · +966 5XX XXX 7777',
  doctor: 'Dr. Ahmed Al-Rashid (you)',
  branch: 'Branch A — Downtown',
  type: 'Cardiology consultation · 45 min',
  pattern: 'Weekly · Monday',
  time: '10:00 – 10:45',
  start: 'Mon, Aug 25 · 10:00',
  requested: 6,
};

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

const OCCURRENCES: Occurrence[] = [
  { date: 'Mon, Aug 25', time: '10:00 – 10:45 · Branch A · Cardiology', status: 'create' },
  { date: 'Mon, Sep 1', time: '10:00 – 10:45 · Branch A · Cardiology', status: 'create' },
  { date: 'Mon, Sep 15', time: '10:00 – 10:45 · Branch A · Cardiology', status: 'create' },
  { date: 'Mon, Sep 22', time: '10:00 – 10:45 · Branch A · Cardiology', status: 'create' },
  {
    date: 'Mon, Sep 8',
    time: '10:00 – 10:45 · Branch A',
    status: 'skip',
    reason: 'Doctor blocked: cardiology conference',
  },
  {
    date: 'Mon, Sep 22',
    time: '10:00 – 10:45 · Branch A',
    status: 'skip',
    reason: 'Outside 30-day window',
  },
];

function StepNum({ n }: { n: number }): ReactNode {
  return <div className={styles['section-num']}>{n}</div>;
}

export function RecurringPreviewPage(): ReactNode {
  const creates = OCCURRENCES.filter((o) => o.status === 'create');
  const skips = OCCURRENCES.filter((o) => o.status === 'skip');

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
              <Cell k="Patient" v={SERIES.patient} />
              <Cell k="Doctor" v={SERIES.doctor} />
              <Cell k="Branch" v={SERIES.branch} />
              <Cell k="Type" v={SERIES.type} />
              <Cell k="Pattern" v={SERIES.pattern} />
              <Cell k="Time" v={SERIES.time} />
              <Cell k="Start" v={SERIES.start} />
              <Cell k="Occurrences" v={`${SERIES.requested} requested`} />
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
                <strong>will be created</strong>of {SERIES.requested} requested
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
                All {OCCURRENCES.length} occurrences
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
                  key={`c-${o.date}`}
                  className={`${styles['occ-row']} ${styles['occ-row-create']}`}
                >
                  <div className={styles['occ-row-date']}>{o.date}</div>
                  <div className={styles['occ-row-time']}>{o.time}</div>
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
                  key={`s-${o.date}`}
                  className={`${styles['occ-row']} ${styles['occ-row-skip']}`}
                >
                  <div className={styles['occ-row-date']}>{o.date}</div>
                  <div className={styles['occ-row-time']}>{o.time}</div>
                  {o.reason && (
                    <span className={styles['occ-row-reason']}>{o.reason}</span>
                  )}
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
            <button type="button" className={styles['btn-ghost']}>
              Cancel
            </button>
            <button type="button" className={styles['btn-secondary']}>
              Edit pattern
            </button>
            <button type="button" className={styles['btn-primary']}>
              Create {creates.length} appointments →
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