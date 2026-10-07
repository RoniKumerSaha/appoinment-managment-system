/**
 * RecurringBackOut — doctor back-out after partial creation (mock 40).
 *
 * Pixel-perfect port of mockup 40
 * (docs/design/mockups/v1/mockups/40-recurring-back-out.html).
 *
 * 760px stacked flow. Amber hero ("there is no undo"), list of
 * 9 already-created occurrences with one skip row, 4-card action
 * grid (cancel individual / leave / contact patient / reschedule
 * hours), audit log block, and a green principle note citing
 * BR-052 / BRD §4.6 / PRD §18.
 *
 * No tests in this pass (per user instruction).
 */
import type { ReactNode } from 'react';
import { DoctorFrame } from './DoctorFrame';
import styles from './RecurringBackOut.module.css';

interface Booked {
  month: string;
  day: number;
  dow: string;
  title: string;
  meta: string;
  state: 'booked' | 'skip';
}

const BOOKED: Booked[] = [
  { month: 'AUG', day: 25, dow: 'Sat', title: '11:15 – 12:00 · Riyadh Olaya', meta: 'Appt #10234 · Booked for Fatima A. Al-Sayed', state: 'booked' },
  { month: 'SEP', day: 1, dow: 'Sat', title: '11:15 – 12:00 · Riyadh Olaya', meta: 'Appt #10241 · Booked for Fatima A. Al-Sayed', state: 'booked' },
  { month: 'SEP', day: 8, dow: 'Sat', title: '11:15 – 12:00 · Riyadh Olaya', meta: 'Appt #10248 · Booked for Fatima A. Al-Sayed', state: 'booked' },
  { month: 'SEP', day: 15, dow: 'Sat', title: '11:15 – 12:00 · Riyadh Olaya', meta: 'Appt #10255 · Booked for Fatima A. Al-Sayed', state: 'booked' },
  { month: 'SEP', day: 22, dow: 'Sat', title: '11:15 – 12:00 · Riyadh Olaya', meta: 'Appt #10262 · Booked for Fatima A. Al-Sayed', state: 'booked' },
  { month: 'SEP', day: 29, dow: 'Sat', title: '11:15 – 12:00 · Riyadh Olaya', meta: 'Skipped at creation · doctor unavailable', state: 'skip' },
];

function StepNum({
  n,
  state,
}: {
  n: number;
  state: 'done' | 'current' | 'todo';
}): ReactNode {
  const cls =
    state === 'done'
      ? `${styles['step-num']} ${styles['step-num-done']}`
      : state === 'current'
        ? `${styles['step-num']} ${styles['step-num-current']}`
        : styles['step-num'];
  return <div className={cls}>{n}</div>;
}

export function RecurringBackOut(): ReactNode {
  return (
    <DoctorFrame>
      <div className={styles['page']}>
        <header className={styles['page-header']}>
          <div className={styles.crumb}>Recurring → Back-out</div>
          <h1>9 appointments already exist.</h1>
          <p className={styles.sub}>
            They were created at{' '}
            <strong style={{ color: 'var(--text-heading)' }}>Aug 18, 14:35</strong> when
            you clicked "Create 9 appointments". The series is no longer pending.
          </p>
        </header>

        <div className={styles.hero}>
          <div className={styles['hero-icon']}>⏪</div>
          <div className={styles['hero-body']}>
            <h2>There is no undo for a recurring series.</h2>
            <p>
              You've changed your mind, and that's fine — but the 9 appointments below
              already exist as <strong>independent appointments</strong> under{' '}
              <code>BR-052</code>. Each one has its own slot, its own patient, and its
              own audit row. Cancelling them here would be a{' '}
              <strong>silent invalidation</strong> (BRD §4.6 / PRD §18): the patient
              would receive a cancellation SMS with no explanation.
            </p>
          </div>
        </div>

        {/* Step 1 — What's on the books */}
        <div className={styles.step}>
          <div className={styles['step-head']}>
            <StepNum n={1} state="done" />
            <div className={styles['step-title']}>What's on the books</div>
            <div className={styles['step-hint']}>9 created · 3 skipped · 0 cancelled</div>
          </div>
          <div className={styles.list}>
            <div className={styles['list-head']}>
              <div className={styles['list-head-title']}>
                Recurring series · Fatima A. Al-Sayed · weekly Sat 11:15
              </div>
              <div className={styles['list-head-count']}>9 of 12 valid</div>
            </div>
            {BOOKED.map((o) => (
              <div
                key={`${o.month}-${o.day}`}
                className={
                  o.state === 'skip'
                    ? `${styles['occ-row']} ${styles['occ-row-skip']}`
                    : styles['occ-row']
                }
              >
                <div className={styles['occ-date']}>
                  <div className={styles['occ-date-month']}>{o.month}</div>
                  <div className={styles['occ-date-day']}>{o.day}</div>
                  <div className={styles['occ-date-dow']}>{o.dow}</div>
                </div>
                <div className={styles['occ-body']}>
                  <div
                    className={
                      o.state === 'skip'
                        ? `${styles['occ-body-title']} ${styles['occ-body-title-strike']}`
                        : styles['occ-body-title']
                    }
                  >
                    {o.title}
                  </div>
                  <div className={styles['occ-body-meta']}>{o.meta}</div>
                </div>
                {o.state === 'booked' ? (
                  <span className={styles['occ-ok']}>✓ Booked</span>
                ) : (
                  <span className={styles['occ-skip']}>Skipped</span>
                )}
              </div>
            ))}
          </div>
          <div className={styles['list-tail']}>
            <a>See all 9 in today's queue →</a>
          </div>
        </div>

        {/* Step 2 — Choose your next move */}
        <div className={styles.step}>
          <div className={styles['step-head']}>
            <StepNum n={2} state="current" />
            <div className={styles['step-title']}>Choose your next move</div>
            <div className={styles['step-hint']}>You decide, not the system</div>
          </div>
          <div className={styles['action-grid']}>
            <div className={styles['action-card']}>
              <div className={styles['action-card-ic']}>1</div>
              <div className={styles['action-card-head']}>
                Cancel individual occurrences
              </div>
              <div className={styles['action-card-body']}>
                Open the affected queue. Cancel each appointment you no longer want —
                each one sends the patient a cancellation reason that you write. Audit
                row per cancellation.
              </div>
            </div>
            <div className={styles['action-card']}>
              <div className={styles['action-card-ic']}>2</div>
              <div className={styles['action-card-head']}>Leave them on the schedule</div>
              <div className={styles['action-card-body']}>
                Keep all 9 as booked. The patient remains committed. If the plan changes
                later, you can cancel one at a time from today's queue or the resolve
                queue.
              </div>
            </div>
            <div className={styles['action-card']}>
              <div className={styles['action-card-ic']}>3</div>
              <div className={styles['action-card-head']}>Contact the patient first</div>
              <div className={styles['action-card-body']}>
                Phone or message Fatima to discuss the change before deciding what to
                cancel. The patient context card has the phone number and notes from
                prior visits.
              </div>
            </div>
            <div className={styles['action-card']}>
              <div className={styles['action-card-ic']}>4</div>
              <div className={styles['action-card-head']}>
                Reschedule the doctor's hours instead
              </div>
              <div className={styles['action-card-body']}>
                If the issue is that the Sat 11:15 slot is now inconvenient, move the
                slot. Existing appointments stay — only the time block changes, and
                patients are notified.
              </div>
            </div>
          </div>
          <div className={styles['step-foot']}>
            <button type="button" className={styles['btn-ghost']}>
              ← Back to schedule
            </button>
            <button type="button" className={styles['btn-primary']}>
              Open today's queue
            </button>
          </div>
        </div>

        {/* Audit log block */}
        <div className={styles['audit-block']}>
          <div className={styles['audit-head']}>
            <span className={styles['audit-head-label']}>
              Audit log · for this session
            </span>
          </div>
          <div className={styles['audit-row']}>
            <span className={styles['audit-row-actor']}>Dr. Ahmed Al-Rashid</span> ·
            recurring_created · 9 appointments · Aug 18, 14:35
          </div>
          <div className={styles['audit-row']}>
            <span className={styles['audit-row-actor']}>Dr. Ahmed Al-Rashid</span> ·
            recurring_skipped · 3 occurrences · Aug 18, 14:35
          </div>
          <div className={`${styles['audit-row']} ${styles['audit-row-quiet']}`}>
            No further events yet — your next action will write its own row.
          </div>
        </div>

        <div className={styles['principle-note']}>
          <span className={styles.ic}>🛡</span>
          <div>
            <strong>Why no "undo"?</strong> Because "undo" would mean cancelling 9
            appointments the patient already committed to. The system doesn't decide
            that for you — you do, one at a time, with an audit trail and a reason you
            write. That's <code>BR-052</code> (per-occurrence independence),{' '}
            <code>BRD §4.6</code> (never silently invalidate), and{' '}
            <code>PRD §18</code> (audit every change). Three rules, one principle:{' '}
            <strong>act, don't un-act</strong>.
          </div>
        </div>
      </div>
    </DoctorFrame>
  );
}