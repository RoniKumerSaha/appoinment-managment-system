/**
 * ReceptionistAvailability — read-only doctor availability browser (mock 16).
 *
 * Pixel-perfect port of mockup 16
 * (docs/design/mockups/v1/mockups/16-recep-availability.html).
 *
 * 4 step cards: filters · date range · day-groups with slot grids ·
 * summary + "Book this slot →" CTA. The CTA deep-links to the
 * receptionist create flow (mock 14) with the slot pre-filled.
 * Booked slots render first-name-initial only (FR-014).
 *
 * No tests in this pass (per user instruction).
 */
import type { ReactNode } from 'react';
import { ReceptionistFrame } from './ReceptionistFrame';
import styles from './ReceptionistAvailability.module.css';

interface Slot {
  t: string;
  a: string;
  state: 'open' | 'booked' | 'selected';
}

interface DayGroup {
  d: string;
  c: { open: number; booked: number };
  isToday?: boolean;
  isClosed?: boolean;
  slots: Slot[];
  closedNote?: string;
}

const DOCTORS = [
  { id: 'd1', name: 'Dr. Ahmed Al-Rashid (Cardiology)' },
  { id: 'd2', name: 'Dr. Khalid Al-Qahtani' },
  { id: 'd3', name: 'Dr. Mohammed Hassan' },
];

const TYPES = [
  { id: 't1', name: 'Cardiology cons. · 45 min' },
  { id: 't2', name: 'Follow-up · 20 min' },
  { id: 't3', name: 'ECG review · 15 min' },
];

const DAYS: DayGroup[] = [
  {
    d: 'Thu, Aug 20',
    isToday: true,
    c: { open: 5, booked: 3 },
    slots: [
      { t: '09:00', a: 'F.A.', state: 'booked' },
      { t: '10:00', a: 'Open', state: 'selected' },
      { t: '11:00', a: 'M.H.', state: 'booked' },
      { t: '13:00', a: 'Open', state: 'open' },
      { t: '14:00', a: 'Open', state: 'open' },
      { t: '15:30', a: 'Open', state: 'open' },
      { t: '16:00', a: 'Open', state: 'open' },
      { t: '16:45', a: 'Open', state: 'open' },
    ],
  },
  {
    d: 'Fri, Aug 21',
    c: { open: 6, booked: 2 },
    slots: [
      { t: '09:00', a: 'Open', state: 'open' },
      { t: '10:00', a: 'K.O.', state: 'booked' },
      { t: '11:30', a: 'Open', state: 'open' },
      { t: '13:00', a: 'Open', state: 'open' },
      { t: '14:00', a: 'L.I.', state: 'booked' },
      { t: '15:00', a: 'Open', state: 'open' },
      { t: '16:00', a: 'Open', state: 'open' },
      { t: '16:45', a: 'Open', state: 'open' },
    ],
  },
  {
    d: 'Sat, Aug 22',
    c: { open: 5, booked: 3 },
    slots: [
      { t: '09:00', a: 'A.Y.', state: 'booked' },
      { t: '10:00', a: 'N.G.', state: 'booked' },
      { t: '11:30', a: 'Open', state: 'open' },
      { t: '13:00', a: 'Open', state: 'open' },
      { t: '14:00', a: 'H.S.', state: 'booked' },
      { t: '15:00', a: 'Open', state: 'open' },
      { t: '16:30', a: 'Open', state: 'open' },
      { t: '17:00', a: 'Open', state: 'open' },
    ],
  },
  {
    d: 'Sun, Aug 23',
    isClosed: true,
    c: { open: 0, booked: 0 },
    slots: [],
    closedNote: 'Sundays are not working days at this branch.',
  },
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

export function ReceptionistAvailability(): ReactNode {
  return (
    <ReceptionistFrame>
      <div className={styles['page']}>
        <header className={styles['page-header']}>
          <div className={styles.crumb}>Today → Doctor availability</div>
          <h1>Doctor availability · read-only</h1>
          <p className={styles.sub}>
            Browse open slots, then jump into F-13 to book one.
          </p>
        </header>

        {/* Step 1 — filters */}
        <div className={styles.step}>
          <div className={styles['step-head']}>
            <StepNum n={1} state="done" />
            <div className={styles['step-title']}>Filters</div>
            <div className={styles['step-hint']}>Branch locked · 30-day window</div>
          </div>
          <div className={styles['row-2']}>
            <div className={styles['form-group']} style={{ marginBottom: 0 }}>
              <label>Doctor (your branch only)</label>
              <select defaultValue={DOCTORS[0]!.id}>
                {DOCTORS.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
              <div className={styles.hint}>Only doctors assigned to Riyadh Olaya.</div>
            </div>
            <div className={styles['form-group']} style={{ marginBottom: 0 }}>
              <label>Appointment type</label>
              <select defaultValue={TYPES[0]!.id}>
                {TYPES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Step 2 — pick a date */}
        <div className={styles.step}>
          <div className={styles['step-head']}>
            <StepNum n={2} state="done" />
            <div className={styles['step-title']}>Pick a date</div>
            <div className={styles['step-hint']}>Aug 20 — Sep 19</div>
          </div>
          <div className={styles['form-group']} style={{ marginBottom: 0 }}>
            <label>Date range (within 30 days)</label>
            <div className={styles['date-range']}>
              <input type="date" defaultValue="2026-08-20" />
              <input type="date" defaultValue="2026-08-26" />
            </div>
            <div className={styles.hint}>Max range: 30 days (BR-013). Same-day not allowed.</div>
          </div>
        </div>

        {/* Step 3 — slots grouped by day */}
        <div className={styles.step}>
          <div className={styles['step-head']}>
            <StepNum n={3} state="current" />
            <div className={styles['step-title']}>Open slots · Dr. Al-Rashid</div>
            <div className={styles['step-hint']}>23 open · 12 booked</div>
          </div>

          {DAYS.map((day) => (
            <div
              key={day.d}
              className={
                day.isClosed
                  ? `${styles['day-group']} ${styles['day-group-closed']}`
                  : styles['day-group']
              }
            >
              <div className={styles['day-group-head']}>
                <div className={styles['day-group-d']}>
                  {day.d}
                  {day.isToday && <span className={styles['today-tag']}>TODAY</span>}
                </div>
                {day.isClosed ? (
                  <div className={styles['day-group-c']}>Branch closed</div>
                ) : (
                  <div className={styles['day-group-c']}>
                    <strong>{day.c.open}</strong> open · {day.c.booked} booked
                  </div>
                )}
              </div>
              {day.isClosed ? (
                <div className={styles['day-group-closed-note']}>{day.closedNote}</div>
              ) : (
                <div className={styles.slots}>
                  {day.slots.map((s) => (
                    <div
                      key={`${day.d}-${s.t}`}
                      className={
                        s.state === 'booked'
                          ? `${styles.slot} ${styles['slot-booked']}`
                          : s.state === 'selected'
                            ? `${styles.slot} ${styles['slot-selected']}`
                            : styles.slot
                      }
                    >
                      <div className={styles['slot-t']}>{s.t}</div>
                      <div className={styles['slot-a']}>{s.a}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}

          <div className={styles['privacy-note']}>
            🔒 Booked slots show first-name initial only (FR-014). Receptionist cannot
            modify the schedule (BR-004).
          </div>
        </div>

        {/* Step 4 — pick slot + book */}
        <div className={styles.step}>
          <div className={styles['step-head']}>
            <StepNum n={4} state="todo" />
            <div className={styles['step-title']}>Selected slot → Book</div>
            <div className={styles['step-hint']}>One click to F-13</div>
          </div>

          <div className={styles['summary-box']}>
            <div className={styles['summary-row']}>
              <span className={styles['summary-k']}>Doctor</span>
              <span className={styles['summary-v']}>Dr. Al-Rashid (Cardiology)</span>
            </div>
            <div className={styles['summary-row']}>
              <span className={styles['summary-k']}>Type</span>
              <span className={styles['summary-v']}>Cardiology cons. · 45 min</span>
            </div>
            <div className={styles['summary-row']}>
              <span className={styles['summary-k']}>When</span>
              <span className={styles['summary-v']}>Thu, Aug 20 · 10:00 — 10:45</span>
            </div>
            <div className={styles['summary-row']}>
              <span className={styles['summary-k']}>Branch</span>
              <span className={styles['summary-v']}>Riyadh Olaya</span>
            </div>
          </div>

          <div className={styles['step-foot']}>
            <div className={styles.audit}>
              Read-only: <code>Availability.read</code> · prefill for{' '}
              <code>F-13.create</code>
            </div>
            <button type="button" className={styles['btn-primary']}>
              + Book this slot →
            </button>
          </div>
        </div>
      </div>
    </ReceptionistFrame>
  );
}