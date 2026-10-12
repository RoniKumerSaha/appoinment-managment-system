/**
 * RecurringOccurrenceCancel — patient per-occurrence cancel (mock 33).
 *
 * Pixel-perfect port of mockup 33
 * (docs/design/mockups/v1/mockups/33-recurring-occurrence-cancel.html).
 *
 * Series context card (E6-S4 key affordance) sits at top, then a
 * target-occurrence section, a sibling list (past / target /
 * upcoming), an alt-card "Cancel the whole series →" link, and
 * section actions footer. The confirmation modal (per FR-049)
 * sits on top of the page.
 *
 * No tests in this pass (per user instruction).
 */
import type { ReactNode } from 'react';
import { PatientFrame } from './PatientFrame';
import { useAuth } from '../auth/store';
import styles from './RecurringOccurrenceCancel.module.css';

interface Sibling {
  ix: number;
  date: string;
  time: string;
  state: 'completed' | 'target' | 'scheduled';
}

const SIBLINGS: Sibling[] = [
  { ix: 1, date: 'Tue 22 Jul', time: '10:00–10:30', state: 'completed' },
  { ix: 2, date: 'Tue 29 Jul', time: '10:00–10:30', state: 'completed' },
  { ix: 3, date: 'Tue 12 Aug', time: '10:00–10:30', state: 'target' },
  { ix: 4, date: 'Tue 19 Aug', time: '10:00–10:30', state: 'scheduled' },
  { ix: 5, date: 'Tue 26 Aug', time: '10:00–10:30', state: 'scheduled' },
  { ix: 6, date: 'Tue 02 Sep', time: '10:00–10:30', state: 'scheduled' },
  { ix: 7, date: 'Tue 09 Sep', time: '10:00–10:30', state: 'scheduled' },
  { ix: 8, date: 'Tue 16 Sep', time: '10:00–10:30', state: 'scheduled' },
];

export function RecurringOccurrenceCancel(): ReactNode {
  const { stored } = useAuth();
  const userName = stored?.profile?.full_name ?? undefined;
  const past = SIBLINGS.filter((s) => s.state === 'completed');
  const upcoming = SIBLINGS.filter((s) => s.state !== 'completed');

  return (
    <PatientFrame userName={userName}>
      <div className={styles['page']}>
        {/* Crumb */}
        <nav className={styles.crumb}>
          <a>My appointments</a>
          <span className={styles['crumb-sep']}>›</span>
          <span className={styles['crumb-here']}>Cancel one occurrence</span>
        </nav>

        {/* Page header */}
        <header className={styles['page-header']}>
          <h1>Cancel one occurrence</h1>
          <div className={styles.sub}>
            You're cancelling a single visit from a recurring series. Other visits in the
            series will not be affected.
          </div>
        </header>

        {/* Series context card (E6-S4 key affordance) */}
        <div className={styles['series-card']}>
          <div className={styles['series-icon']}>↻</div>
          <div className={styles['series-body']}>
            <div className={styles['series-label']}>Recurring series</div>
            <div className={styles['series-title']}>
              Weekly follow-up with Dr. Layla Karim
            </div>
            <div className={styles['series-meta']}>
              Branch A · Consultation (30 min) · Started Tue 22 Jul · repeats every Tuesday
            </div>
          </div>
          <div className={styles['series-counter']}>
            Occurrence <span className={styles['series-counter-num']}>3</span> of 8
          </div>
        </div>

        {/* Target occurrence section */}
        <section className={styles.section}>
          <header className={styles['section-head']}>
            <div className={styles['section-title']}>
              This occurrence will be cancelled
            </div>
            <div className={styles['section-sub']}>Slot will be released.</div>
          </header>
          <div className={styles['section-body']}>
            <div className={styles['target-card']}>
              <div className={styles['target-card-radio']} aria-label="selected" />
              <div className={styles['target-date-block']}>
                <div className={styles['target-date-month']}>Aug</div>
                <div className={styles['target-date-day']}>12</div>
                <div className={styles['target-date-dow']}>Tue</div>
              </div>
              <div className={styles['target-body']}>
                <div className={styles['target-row1']}>Dr. Layla Karim · Branch A</div>
                <div className={styles['target-row2']}>
                  Tue 12 Aug · 10:00–10:30 · +966 5XX XXX 5555
                </div>
              </div>
              <div className={styles['target-pill']}>This one</div>
            </div>
          </div>
        </section>

        {/* Sibling list (other occurrences — left alone) */}
        <section className={styles.section}>
          <header className={styles['section-head']}>
            <div className={styles['section-title']}>
              Other occurrences in this series
            </div>
            <div className={styles['section-sub']}>
              7 still scheduled · unaffected
            </div>
          </header>
          <div className={styles['section-body']}>
            <div className={styles['sibling-list']}>
              {past.map((s) => (
                <div
                  key={s.ix}
                  className={`${styles.sibling} ${styles['sibling-past']}`}
                >
                  <div className={styles['sibling-ix']}>{s.ix}</div>
                  <div className={styles['sibling-date']}>{s.date}</div>
                  <div className={styles['sibling-time']}>{s.time}</div>
                  <div
                    className={`${styles['sibling-status']} ${styles['sibling-status-completed']}`}
                  >
                    Completed
                  </div>
                </div>
              ))}
            </div>

            <div className={styles['sibling-divider']}>— upcoming —</div>

            <div className={styles['sibling-list']}>
              {upcoming.map((s) => {
                if (s.state === 'target') {
                  return (
                    <div
                      key={s.ix}
                      className={`${styles.sibling} ${styles['sibling-target']}`}
                    >
                      <div className={styles['sibling-ix']}>{s.ix}</div>
                      <div className={styles['sibling-date']}>{s.date}</div>
                      <div className={styles['sibling-time']}>{s.time}</div>
                      <div
                        className={`${styles['sibling-status']} ${styles['sibling-status-target']}`}
                      >
                        Cancelling…
                      </div>
                    </div>
                  );
                }
                return (
                  <div key={s.ix} className={styles.sibling}>
                    <div className={styles['sibling-ix']}>{s.ix}</div>
                    <div className={styles['sibling-date']}>{s.date}</div>
                    <div className={styles['sibling-time']}>{s.time}</div>
                    <div
                      className={`${styles['sibling-status']} ${styles['sibling-status-scheduled']}`}
                    >
                      Scheduled
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Footnote: explain independence */}
            <div className={styles['sibling-foot']}>
              <span className={styles.ic}>i</span>
              <div>
                <strong>Each occurrence is independent</strong> after creation (per
                BR-052 / FR-049). Cancelling this one only releases Tue 12 Aug · 10:00.
                The other 5 upcoming visits stay Scheduled and can be cancelled or
                rescheduled individually.
              </div>
            </div>

            {/* Alt: cancel the whole series */}
            <div className={styles['alt-card']}>
              <div className={styles['alt-icon']}>↻</div>
              <div className={styles['alt-body']}>
                <div className={styles['alt-t']}>Want to stop the whole series?</div>
                <div className={styles['alt-s']}>
                  You can also cancel every upcoming occurrence at once.
                </div>
              </div>
              <span className={styles['alt-link']}>Cancel series →</span>
            </div>
          </div>
        </section>

        {/* Footer actions */}
        <section className={styles.section}>
          <div className={styles['section-actions']}>
            <button type="button" className={styles['btn-ghost']}>
              Back
            </button>
            <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
              <button type="button" className={styles['btn-secondary']}>
                Reschedule this one instead
              </button>
              <button type="button" className={styles['btn-danger']}>
                Cancel this occurrence
              </button>
            </div>
          </div>
        </section>
      </div>

      {/* Confirmation modal (sits on top of the page) */}
      <div className={styles['modal-backdrop']}>
        <div className={styles.modal}>
          <div className={styles['modal-head']}>
            <div className={styles['modal-icon']}>!</div>
            <div className={styles['modal-title-block']}>
              <div className={styles['modal-title']}>Cancel Tue 12 Aug at 10:00?</div>
              <div className={styles['modal-sub']}>
                You're cancelling one visit, not the whole series.
              </div>
            </div>
            <button type="button" className={styles['modal-x']}>
              ×
            </button>
          </div>
          <div className={styles['modal-body']}>
            <div className={styles['modal-target-strip']}>
              <strong>Occurrence 3 of 8</strong> · Tue 12 Aug · 10:00–10:30 · Dr. Layla
              Karim
            </div>
            <div className={styles['modal-lead']}>
              No reason needed. The 10:00 slot will be released and may be booked by
              another patient. The 5 other upcoming visits in this series remain
              Scheduled.
            </div>
            <div className={styles['modal-rule']}>
              Per FR-049, each occurrence is independent after creation — only this one
              is affected.
            </div>
          </div>
          <div className={styles['modal-foot']}>
            <button type="button" className={styles['btn-ghost']}>
              Keep appointment
            </button>
            <button type="button" className={styles['btn-danger']}>
              Cancel this occurrence
            </button>
          </div>
        </div>
      </div>
    </PatientFrame>
  );
}