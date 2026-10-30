/**
 * RecurringConfirmPage — E7-E recurring confirm screen (mock 23).
 *
 * Pixel-perfect port of mockup 23
 * (docs/design/mockups/v1/mockups/23-recurring-confirm.html).
 *
 * 760px stacked-vertical flow. Hero summary card with 3 stat
 * columns (Will be created / Skipped / Requested). Tabs switch
 * between To be created / Skipped. Each occurrence row uses a
 * date-block column (month/day/dow) + title + meta + ok/reason
 * pill — same shape as the appointment card (DESIGN-SYSTEM §7.10).
 *
 * The page is fed by the REAL confirm response
 * (`POST /recurring/confirm`) — the owner (DoctorApp /
 * ReceptionistApp) holds the request that produced it and passes it
 * down. The page is presentational: it renders what the server said
 * and reports button intent back through props.
 *
 * As with the preview screen, the frame is a prop: a receptionist
 * running this flow has to land in the RECEPTIONIST's nav, not the
 * doctor's. The doctor-only "Back out" screen (`RecurringBackOut`)
 * reads the series through a doctor-scoped route, so it is not
 * offered here — `onBackOut` is simply left undefined.
 */
import { useState, type ReactNode } from 'react';
import { DoctorFrame } from './DoctorFrame';
import { ReceptionistFrame } from './ReceptionistFrame';
import styles from './RecurringConfirmPage.module.css';
import type {
  RecurringConfirmResponse,
  RecurringCreatedOccurrence,
  RecurringSkippedAtConfirm,
} from '../api/client';
import type { RecurringRole } from './RecurringPreviewPage';

type Tab = 'create' | 'skip';

export interface RecurringConfirmLabels {
  patient: string;
  doctor: string;
  branch: string;
  type: string;
  pattern: string;
}

export interface RecurringConfirmPageProps {
  result: RecurringConfirmResponse;
  labels: RecurringConfirmLabels;
  requested: number;
  error: string | null;
  busy: boolean;
  onEditSchedule: () => void;
  onDone: () => void;
  /** Open the back-out screen for the series that was just created
   *  (mock 40). Optional so the page can be rendered without it —
   *  and left undefined for the receptionist, whose series cannot be
   *  read back through the doctor-scoped route it uses. */
  onBackOut?: () => void;
  /** Which surface to render in. Defaults to the doctor. */
  role?: RecurringRole;
}

/** `2026-11-04` → the month/day/weekday triple the date-block
 *  column renders. The local_date is already in the branch's
 *  timezone, so it is read as a plain calendar date. */
function dateBlock(iso: string): {
  month: string;
  day: string;
  dow: string;
} {
  const [y, m, d] = iso.split('-');
  if (!y || !m || !d) return { month: '', day: '', dow: '' };
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return {
    month: date
      .toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })
      .toUpperCase(),
    day: String(Number(d)),
    dow: date.toLocaleDateString('en-US', {
      weekday: 'short',
      timeZone: 'UTC',
    }),
  };
}

/** The server's skip reasons are snake_case codes (`outside_branch_hours`,
 *  `doctor_blocked`, …). They are rendered as-is — the server owns the
 *  vocabulary, and inventing a display label here would let the two
 *  drift apart. */
function humanizeReason(reason: string): string {
  return reason.replace(/_/g, ' ');
}

export function RecurringConfirmPage({
  result,
  labels,
  requested,
  error,
  busy,
  onEditSchedule,
  onDone,
  onBackOut,
  role = 'doctor',
}: RecurringConfirmPageProps): ReactNode {
  const [tab, setTab] = useState<Tab>('create');
  const created: RecurringCreatedOccurrence[] = result.created;
  const skipped: RecurringSkippedAtConfirm[] = result.skipped;
  const creates = created.length;
  const skips = skipped.length;

  const renderCreated = (o: RecurringCreatedOccurrence): ReactNode => {
    const block = dateBlock(o.local_date);
    return (
      <div key={`c-${o.occurrence_index}`} className={styles['occ-row']}>
        <div className={styles['occ-date']}>
          <div className={styles['occ-date-month']}>{block.month}</div>
          <div className={styles['occ-date-day']}>{block.day}</div>
          <div className={styles['occ-date-dow']}>{block.dow}</div>
        </div>
        <div className={styles['occ-body']}>
          <div className={styles['occ-body-title']}>
            {labels.patient} · {labels.type}
          </div>
          <div className={styles['occ-body-meta']}>
            {labels.doctor} · {labels.branch}
          </div>
        </div>
        <span className={styles['occ-ok']}>✓ Created</span>
      </div>
    );
  };

  const renderSkipped = (o: RecurringSkippedAtConfirm): ReactNode => {
    const block = dateBlock(o.local_date);
    return (
      <div key={`s-${o.occurrence_index}`} className={styles['occ-row']}>
        <div className={styles['occ-date']}>
          <div className={styles['occ-date-month']}>{block.month}</div>
          <div className={styles['occ-date-day']}>{block.day}</div>
          <div className={styles['occ-date-dow']}>{block.dow}</div>
        </div>
        <div className={styles['occ-body']}>
          <div className={styles['occ-body-title']}>
            {labels.patient} · {labels.type}
          </div>
          <div className={styles['occ-body-meta']}>
            {labels.doctor} · {labels.branch}
          </div>
        </div>
        <span className={styles['occ-reason']}>{humanizeReason(o.reason)}</span>
      </div>
    );
  };

  const body = (
    <div className={styles['page']}>
        <header className={styles['page-header']}>
          <div className={styles.crumb}>Recurring → Confirm</div>
          <h1>Recurring series ready</h1>
          <p className={styles.sub}>
            {requested} occurrences requested · {labels.pattern} ·{' '}
            {labels.doctor}
          </p>
        </header>

        {error !== null && (
          <div className={styles.audit} role="alert">
            {error}
          </div>
        )}

        <div className={styles.hero}>
          <div className={styles['hero-summary']}>
            <div className={styles['hero-stat']}>
              <div
                className={`${styles['hero-stat-num']} ${styles['hero-stat-num-created']}`}
              >
                {creates}
              </div>
              <div className={styles['hero-stat-lbl']}>Will be created</div>
            </div>
            <div className={styles['hero-stat']}>
              <div
                className={`${styles['hero-stat-num']} ${styles['hero-stat-num-skipped']}`}
              >
                {skips}
              </div>
              <div className={styles['hero-stat-lbl']}>Skipped</div>
            </div>
            <div className={styles['hero-stat']}>
              <div className={styles['hero-stat-num']}>{requested}</div>
              <div className={styles['hero-stat-lbl']}>Requested</div>
            </div>
          </div>
        </div>

        <div className={styles.tabs}>
          <button
            type="button"
            className={tab === 'create' ? styles['tabs-button-active'] : ''}
            onClick={() => setTab('create')}
          >
            To be created ({creates})
          </button>
          <button
            type="button"
            className={tab === 'skip' ? styles['tabs-button-active'] : ''}
            onClick={() => setTab('skip')}
          >
            Skipped ({skips})
          </button>
        </div>

        <div className={styles.list}>
          <div className={styles['list-head']}>
            <div className={styles['list-head-title']}>Scheduled occurrences</div>
            <div className={styles['list-head-count']}>
              {creates} of {requested} valid
            </div>
          </div>
          {tab === 'create' ? created.map(renderCreated) : skipped.map(renderSkipped)}
          {tab === 'create' && created.length === 0 && (
            <div className={styles['occ-row']}>
              <div className={styles['occ-body']}>
                <div className={styles['occ-body-meta']}>No occurrences created.</div>
              </div>
            </div>
          )}
          {tab === 'skip' && skipped.length === 0 && (
            <div className={styles['occ-row']}>
              <div className={styles['occ-body']}>
                <div className={styles['occ-body-meta']}>No occurrences skipped.</div>
              </div>
            </div>
          )}
        </div>

        <div className={styles['step-foot']}>
          <span className={styles.audit}>
            {creates} audit rows created · <code>recurring_created</code>
          </span>
          <div className={styles['btn-row']}>
            {onBackOut !== undefined && (
              <button
                type="button"
                className={styles['btn-ghost']}
                onClick={onBackOut}
                disabled={busy}
              >
                Back out
              </button>
            )}
            <button
              type="button"
              className={styles['btn-ghost']}
              onClick={onEditSchedule}
              disabled={busy}
            >
              Edit schedule
            </button>
            <button
              type="button"
              className={styles['btn-primary']}
              onClick={onDone}
              disabled={busy}
            >
              {busy ? 'Creating…' : `Create ${creates} appointments`}
            </button>
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
