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
 * No tests in this pass (per user instruction).
 */
import { useState, type ReactNode } from 'react';
import { DoctorFrame } from './DoctorFrame';
import styles from './RecurringConfirmPage.module.css';

type Tab = 'create' | 'skip';

interface Occurrence {
  month: string;
  day: number;
  dow: string;
  time: string;
  patient: string;
  meta?: string;
  state: 'ok' | 'skip';
  reason?: string;
}

const OCCURRENCES: Occurrence[] = [
  { month: 'AUG', day: 25, dow: 'Sat', time: '11:15 – 12:00 · Riyadh Olaya', patient: 'Fatima A. Al-Sayed · +966 5XX XXX 5555', state: 'ok' },
  { month: 'SEP', day: 1, dow: 'Sat', time: '11:15 – 12:00 · Riyadh Olaya', patient: 'Fatima A. Al-Sayed', state: 'ok' },
  { month: 'SEP', day: 8, dow: 'Sat', time: '11:15 – 12:00 · Riyadh Olaya', patient: 'Fatima A. Al-Sayed', state: 'ok' },
  { month: 'SEP', day: 15, dow: 'Sat', time: '11:15 – 12:00 · Riyadh Olaya', patient: 'Fatima A. Al-Sayed', state: 'ok' },
  { month: 'SEP', day: 22, dow: 'Sat', time: '11:15 – 12:00 · Riyadh Olaya', patient: 'Fatima A. Al-Sayed', state: 'ok' },
  { month: 'SEP', day: 29, dow: 'Sat', time: '11:15 – 12:00 · Riyadh Olaya', patient: 'Fatima A. Al-Sayed', state: 'ok' },
  { month: 'OCT', day: 6, dow: 'Sat', time: '11:15 – 12:00 · Riyadh Olaya', patient: 'Fatima A. Al-Sayed', state: 'ok' },
  { month: 'OCT', day: 13, dow: 'Sat', time: '11:15 – 12:00 · Riyadh Olaya', patient: 'Fatima A. Al-Sayed', state: 'ok' },
  { month: 'OCT', day: 20, dow: 'Sat', time: '11:15 – 12:00 · Riyadh Olaya', patient: 'Fatima A. Al-Sayed', state: 'ok' },
  { month: 'SEP', day: 8, dow: 'Sat', time: '11:15 – 12:00 · Riyadh Olaya', patient: 'Fatima A. Al-Sayed', state: 'skip', reason: 'Doctor blocked: cardiology conference' },
  { month: 'OCT', day: 27, dow: 'Sat', time: '11:15 – 12:00 · Riyadh Olaya', patient: 'Fatima A. Al-Sayed', state: 'skip', reason: 'Outside 30-day window' },
  { month: 'NOV', day: 17, dow: 'Sat', time: '11:15 – 12:00 · Riyadh Olaya', patient: 'Fatima A. Al-Sayed', state: 'skip', reason: 'Branch holiday' },
];

export function RecurringConfirmPage(): ReactNode {
  const [tab, setTab] = useState<Tab>('create');
  const visible = OCCURRENCES.filter((o) =>
    tab === 'create' ? o.state === 'ok' : o.state === 'skip',
  );
  const creates = OCCURRENCES.filter((o) => o.state === 'ok').length;
  const skips = OCCURRENCES.filter((o) => o.state === 'skip').length;

  return (
    <DoctorFrame>
      <div className={styles['page']}>
        <header className={styles['page-header']}>
          <div className={styles.crumb}>Recurring → Confirm</div>
          <h1>Recurring series ready</h1>
          <p className={styles.sub}>
            12 occurrences requested · weekly · Aug 25 – Nov 17 · 11:15 with Dr. Al-Rashid
          </p>
        </header>

        <div className={styles.hero}>
          <div className={styles['hero-summary']}>
            <div className={styles['hero-stat']}>
              <div className={`${styles['hero-stat-num']} ${styles['hero-stat-num-created']}`}>
                {creates}
              </div>
              <div className={styles['hero-stat-lbl']}>Will be created</div>
            </div>
            <div className={styles['hero-stat']}>
              <div className={`${styles['hero-stat-num']} ${styles['hero-stat-num-skipped']}`}>
                {skips}
              </div>
              <div className={styles['hero-stat-lbl']}>Skipped</div>
            </div>
            <div className={styles['hero-stat']}>
              <div className={styles['hero-stat-num']}>{OCCURRENCES.length}</div>
              <div className={styles['hero-stat-lbl']}>Requested</div>
            </div>
          </div>
        </div>

        <div className={styles.tabs}>
          <button
            type="button"
            className={
              tab === 'create' ? styles['tabs-button-active'] : ''
            }
            onClick={() => setTab('create')}
          >
            To be created ({creates})
          </button>
          <button
            type="button"
            className={
              tab === 'skip' ? styles['tabs-button-active'] : ''
            }
            onClick={() => setTab('skip')}
          >
            Skipped ({skips})
          </button>
        </div>

        <div className={styles.list}>
          <div className={styles['list-head']}>
            <div className={styles['list-head-title']}>Scheduled occurrences</div>
            <div className={styles['list-head-count']}>
              {creates} of {OCCURRENCES.length} valid
            </div>
          </div>
          {visible.map((o, i) => (
            <div key={`${o.month}-${o.day}-${i}`} className={styles['occ-row']}>
              <div className={styles['occ-date']}>
                <div className={styles['occ-date-month']}>{o.month}</div>
                <div className={styles['occ-date-day']}>{o.day}</div>
                <div className={styles['occ-date-dow']}>{o.dow}</div>
              </div>
              <div className={styles['occ-body']}>
                <div className={styles['occ-body-title']}>{o.time}</div>
                <div className={styles['occ-body-meta']}>{o.patient}</div>
              </div>
              {o.state === 'ok' ? (
                <span className={styles['occ-ok']}>✓ Valid</span>
              ) : (
                <span className={styles['occ-reason']}>{o.reason}</span>
              )}
            </div>
          ))}
        </div>

        <div className={styles['step-foot']}>
          <span className={styles.audit}>
            {creates} audit rows will be created · <code>recurring_created</code>
          </span>
          <div className={styles['btn-row']}>
            <button type="button" className={styles['btn-ghost']}>
              Edit schedule
            </button>
            <button type="button" className={styles['btn-primary']}>
              Create {creates} appointments
            </button>
          </div>
        </div>
      </div>
    </DoctorFrame>
  );
}