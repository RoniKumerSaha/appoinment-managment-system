/**
 * ReceptionistCreate — E5 receptionist walk-in booking flow (mock 14).
 *
 * Pixel-perfect port of mockup 14
 * (docs/design/mockups/v1/mockups/14-recep-create.html).
 *
 * 5-step stepped form rendered as numbered section cards + a top
 * stepper. Branch is locked (single-branch per BR-004). Calendar
 * picker and 4-column slot grid reuse the same component style as
 * the patient booking flow (mock 03 / 04). On confirm, writes
 * `audit.creator_role = "receptionist"`.
 *
 * No tests in this pass (per user instruction).
 */
import { useCallback, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { ReceptionistFrame } from './ReceptionistFrame';
import styles from './ReceptionistCreate.module.css';

interface TypeOption {
  id: string;
  name: string;
  dur: string;
  desc: string;
}

const TYPES: TypeOption[] = [
  { id: 'card-consult', name: 'Cardiology consultation', dur: '45 min', desc: 'Initial assessment for new patients.' },
  { id: 'follow-up', name: 'Follow-up', dur: '20 min', desc: 'Returning patient brief check.' },
  { id: 'ecg', name: 'ECG review', dur: '15 min', desc: 'Reading + interpretation.' },
  { id: 'preop', name: 'Pre-op assessment', dur: '30 min', desc: 'Pre-surgical clearance.' },
];

const DOCTORS = [
  { id: 'd1', name: 'Dr. Ahmed Al-Rashid (Cardiology)' },
  { id: 'd2', name: 'Dr. Khalid Al-Qahtani' },
  { id: 'd3', name: 'Dr. Mohammed Hassan' },
];

const SLOTS = [
  { time: '09:00', disabled: false },
  { time: '10:00', disabled: false, selected: true },
  { time: '11:30', disabled: false },
  { time: '13:00', disabled: true },
  { time: '14:00', disabled: false },
  { time: '15:30', disabled: false },
  { time: '16:00', disabled: false },
  { time: '16:30', disabled: false },
];

interface DayCell {
  n: number;
  state: 'disabled' | 'today' | 'selected' | 'has-slots';
  avail?: string;
}

const CAL_DAYS: DayCell[] = [
  // row 1 (Jul 28 – Aug 3 — all disabled / past)
  ...[28, 30, 31].map((n) => ({ n, state: 'disabled' as const })),
  { n: 1, state: 'disabled' },
  { n: 2, state: 'disabled' },
  { n: 3, state: 'disabled' },
  { n: 29, state: 'disabled' },
  // row 2 (Aug 4–10)
  ...[4, 5, 6, 7, 8, 9, 10].map((n) => ({ n, state: 'disabled' as const })),
  // row 3 (Aug 11–17)
  ...[11, 12, 13, 14, 15, 16, 17].map((n) => ({ n, state: 'disabled' as const })),
  // row 4 (Aug 18–24)
  { n: 18, state: 'disabled' },
  { n: 19, state: 'today', avail: 'today' },
  { n: 20, state: 'selected', avail: '6 slots' },
  { n: 21, state: 'has-slots', avail: '7 slots' },
  { n: 22, state: 'has-slots', avail: '4 slots' },
  { n: 23, state: 'has-slots', avail: '8 slots' },
  { n: 24, state: 'disabled' },
  // row 5 (Aug 25–31)
  { n: 25, state: 'has-slots', avail: '5 slots' },
  { n: 26, state: 'has-slots', avail: '6 slots' },
  { n: 27, state: 'has-slots', avail: '3 slots' },
  { n: 28, state: 'has-slots', avail: '7 slots' },
  { n: 29, state: 'has-slots', avail: '5 slots' },
  { n: 30, state: 'has-slots', avail: '8 slots' },
  { n: 31, state: 'disabled' },
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

export function ReceptionistCreate(): ReactNode {
  const firstType: TypeOption = TYPES[0] as TypeOption;
  const [typeId, setTypeId] = useState<string>(firstType.id);
  const selectedType: TypeOption = useMemo(
    () => TYPES.find((t) => t.id === typeId) ?? firstType,
    [typeId, firstType],
  );

  const onSubmit = useCallback(
    (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      // No backend wiring in this pass; ack.
    },
    [],
  );

  return (
    <ReceptionistFrame>
      <div className={styles['page']}>
        <header className={styles['page-header']}>
          <div className={styles.crumb}>Today → + New appointment</div>
          <h1>Book on behalf of patient</h1>
          <p className={styles.sub}>
            For walk-ins or phone bookings. Same conflict checks as patient flow (FR-027/029).
          </p>
        </header>

        {/* Stepper */}
        <div className={styles.stepper}>
          <div className={`${styles['stepper-seg']} ${styles['stepper-seg-done']}`}>
            <span className={styles.n}>✓</span>Branch
          </div>
          <div className={`${styles['stepper-seg']} ${styles['stepper-seg-done']}`}>
            <span className={styles.n}>✓</span>Doctor + Type
          </div>
          <div className={`${styles['stepper-seg']} ${styles['stepper-seg-done']}`}>
            <span className={styles.n}>✓</span>Date + Slot
          </div>
          <div className={`${styles['stepper-seg']} ${styles['stepper-seg-current']}`}>
            <span className={styles.n}>4</span>Patient
          </div>
          <div className={styles['stepper-seg']}>
            <span className={styles.n}>5</span>Confirm
          </div>
        </div>

        {/* Step 1 — Branch (locked) */}
        <div className={styles.step}>
          <div className={styles['step-head']}>
            <StepNum n={1} state="done" />
            <div className={styles['step-title']}>Branch (locked to you)</div>
            <div className={styles['step-hint']}>BR-004</div>
          </div>
          <div className={styles['branch-card']}>
            <div className={styles['branch-icon']}>📍</div>
            <div className={styles['branch-body']}>
              <div className={styles['branch-name']}>Riyadh Olaya Branch</div>
              <div className={styles['branch-meta']}>King Fahd Rd · 3 doctors available</div>
            </div>
            <span className={styles['branch-lock']}>🔒 Single-branch</span>
          </div>
        </div>

        {/* Step 2 — Doctor + Type */}
        <div className={styles.step}>
          <div className={styles['step-head']}>
            <StepNum n={2} state="done" />
            <div className={styles['step-title']}>Doctor + appointment type</div>
            <div className={styles['step-hint']}>3 active types at this branch</div>
          </div>
          <div className={styles['form-group']}>
            <label>Doctor</label>
            <select defaultValue={DOCTORS[0]!.id}>
              {DOCTORS.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
          <div className={styles['form-group']} style={{ marginBottom: 0 }}>
            <label>Type</label>
            <div className={styles.types}>
              {TYPES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={
                    t.id === typeId
                        ? `${styles['type-opt']} ${styles['type-opt-selected']}`
                        : styles['type-opt']
                    }
                  onClick={() => setTypeId(t.id)}
                >
                  <div className={styles['type-opt-name']}>{t.name}</div>
                  <div className={styles['type-opt-dur']}>{t.dur}</div>
                  <div className={styles['type-opt-desc']}>{t.desc}</div>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Step 3 — Date + slot */}
        <div className={styles.step}>
          <div className={styles['step-head']}>
            <StepNum n={3} state="done" />
            <div className={styles['step-title']}>Date + slot</div>
            <div className={styles['step-hint']}>Wed, Aug 21 · 6 slots</div>
          </div>
          <div className={styles.cal} style={{ marginBottom: 'var(--space-7)' }}>
            <div className={styles['cal-head']}>
              <button type="button" className={styles.nav} aria-label="prev">
                ‹
              </button>
              <span>August 2026</span>
              <button type="button" className={styles.nav} aria-label="next">
                ›
              </button>
            </div>
            <div className={styles['cal-grid']}>
              {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
                <div key={`h-${i}`} className={styles['cal-grid-day-h']}>
                  {d}
                </div>
              ))}
              {CAL_DAYS.map((d, i) => {
                const base =
                  d.state === 'disabled'
                    ? `${styles['cal-day']} ${styles['cal-day-disabled']}`
                    : d.state === 'today'
                      ? `${styles['cal-day']} ${styles['cal-day-today']}`
                      : d.state === 'selected'
                        ? `${styles['cal-day']} ${styles['cal-day-selected']}`
                        : `${styles['cal-day']} ${styles['cal-day-has-slots']}`;
                return (
                  <div key={`d-${i}`} className={base}>
                    {d.n}
                    {d.avail && <div className={styles['cal-day-avail']}>{d.avail}</div>}
                  </div>
                );
              })}
            </div>
          </div>
          <div className={styles['form-group']} style={{ marginBottom: 0 }}>
            <label>Available slots · Wed, Aug 20</label>
            <div className={styles.slots}>
              {SLOTS.map((s) => (
                <div
                  key={s.time}
                  className={
                    s.disabled
                      ? `${styles.slot} ${styles['slot-disabled']}`
                      : s.selected
                        ? `${styles.slot} ${styles['slot-selected']}`
                        : styles.slot
                  }
                >
                  {s.time}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Step 4 — Patient details */}
        <div className={styles.step}>
          <div className={styles['step-head']}>
            <StepNum n={4} state="current" />
            <div className={styles['step-title']}>Patient details</div>
            <div className={styles['step-hint']}>Existing or new patient</div>
          </div>
          <div className={styles['form-group']}>
            <label>
              Patient phone <span className={styles.req}>*</span>
            </label>
            <input type="tel" defaultValue="+966 5XX XXX 1234" />
            <div className={styles.hint}>
              Existing patients prefill from F-02 (BR-016). New patients: enter phone + name.
            </div>
          </div>
          <div className={styles['patient-match']}>
            <div className={styles['patient-match-avatar']}>FS</div>
            <div className={styles['patient-match-body']}>
              <div className={styles['patient-match-name']}>
                Fatima Al-Sayed{' '}
                <span className={styles['patient-match-name-muted']}>(known patient)</span>
              </div>
              <div className={styles['patient-match-meta']}>
                3 prior appointments · last visit 2 months ago
              </div>
            </div>
            <span className={styles['patient-match-badge']}>✓ MATCHED</span>
          </div>
          <div className={styles['form-group']} style={{ marginTop: 'var(--space-7)' }}>
            <label>
              Patient name <span className={styles.req}>*</span>
            </label>
            <input type="text" defaultValue="Fatima Al-Sayed" />
          </div>
          <div className={styles['form-group']} style={{ marginBottom: 0 }}>
            <label>Notes for the doctor (optional)</label>
            <textarea
              rows={3}
              placeholder="e.g. patient prefers afternoon calls, has mobility issues…"
            />
          </div>
        </div>

        {/* Step 5 — Confirm */}
        <form className={styles.step} onSubmit={onSubmit}>
          <div className={styles['step-head']}>
            <StepNum n={5} state="todo" />
            <div className={styles['step-title']}>Confirm booking</div>
            <div className={styles['step-hint']}>Review + create</div>
          </div>

          <div className={styles['confirm-box']}>
            <div className={styles['confirm-grid']}>
              <div>
                <span className={styles.k}>Branch:</span> <strong>Riyadh Olaya</strong>
              </div>
              <div>
                <span className={styles.k}>Doctor:</span> <strong>Dr. Al-Rashid</strong>
              </div>
              <div>
                <span className={styles.k}>Type:</span>{' '}
                <strong>{selectedType.name}</strong> · {selectedType.dur}
              </div>
              <div>
                <span className={styles.k}>When:</span> <strong>Wed, Aug 20 · 10:00</strong>
              </div>
              <div className={styles['confirm-grid-row-full']}>
                <span className={styles.k}>Patient:</span>{' '}
                <strong>Fatima Al-Sayed</strong> · +966 5XX XXX 1234
              </div>
            </div>
          </div>

          <div className={styles['info-note']}>
            ℹ️ This booking will be marked as{' '}
            <strong>created on behalf of patient</strong>. audit.creator_role = "receptionist".
          </div>

          <div className={styles['step-foot']}>
            <div className={styles.audit}>
              Atomic: <code>Appointment.create</code> · audit:{' '}
              <code>appointment.created</code>
            </div>
            <div className={styles['btn-row']}>
              <button type="button" className={styles['btn-ghost']}>
                Back
              </button>
              <button type="submit" className={styles['btn-primary']}>
                Confirm booking
              </button>
            </div>
          </div>
        </form>
      </div>
    </ReceptionistFrame>
  );
}