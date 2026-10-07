/**
 * ConfirmationReceipt — patient post-booking success page (mock 36).
 *
 * Pixel-perfect port of mockup 36
 * (docs/design/mockups/v1/mockups/36-confirmation-receipt.html).
 *
 * 520px-wide centered layout with a success hero (checkmark in
 * brand ring), a 2px-bordered receipt card (tag, doctor, spec,
 * when-block, two-col field grids, dashed divider, booking-ref
 * block), OTP hint banner, primary + secondary action buttons,
 * and a phone-fallback section.
 *
 * No tests in this pass (per user instruction).
 */
import type { ReactNode } from 'react';
import { PatientFrame } from './PatientFrame';
import styles from './ConfirmationReceipt.module.css';

export function ConfirmationReceipt(): ReactNode {
  return (
    <PatientFrame>
      <div className={styles['page']}>
        <div className={styles['success-head']}>
          <div className={styles['success-icon']}>✓</div>
          <h1>You're booked, Fatima.</h1>
          <div className={styles.sub}>Your appointment is real. It's yours.</div>
        </div>

        <div className={styles.receipt}>
          <div className={styles['receipt-tag']}>Appointment confirmed</div>
          <div className={styles['receipt-doctor']}>Dr. Ahmed Al-Rashid</div>
          <div className={styles['receipt-spec']}>Cardiology</div>

          <div className={styles['receipt-when']}>
            <div className={styles['receipt-when-date']}>Tue, Aug 19</div>
            <div className={styles['receipt-when-time']}>
              15:30 <span className={styles['receipt-when-end']}>— 16:15</span>
            </div>
          </div>

          <div className={styles['receipt-grid']}>
            <div className={styles['receipt-field']}>
              <div className={styles['receipt-field-label']}>Branch</div>
              <div className={styles['receipt-field-value']}>Riyadh Olaya</div>
            </div>
            <div className={styles['receipt-field']}>
              <div className={styles['receipt-field-label']}>Type</div>
              <div className={styles['receipt-field-value']}>45-min consultation</div>
            </div>
          </div>

          <div className={styles['receipt-divider']} />

          <div className={styles['receipt-grid']}>
            <div className={styles['receipt-field']}>
              <div className={styles['receipt-field-label']}>Address</div>
              <div
                className={`${styles['receipt-field-value']} ${styles['receipt-field-address']}`}
              >
                King Fahd Rd, Tower 2, Floor 4
              </div>
            </div>
            <div className={styles['receipt-field']}>
              <div className={styles['receipt-field-label']}>Phone</div>
              <div className={styles['receipt-field-value']}>+966 5XX XXX 5555</div>
            </div>
          </div>

          <div className={styles['receipt-ref']}>
            <div className={styles['receipt-ref-label']}>Booking reference</div>
            <div className={styles['receipt-ref-num']}>A-2026-08-19-1530</div>
          </div>
        </div>

        <div className={styles['otp-hint']}>
          <div className={styles.icon}>🔒</div>
          <div>
            We sent a code to{' '}
            <strong>+966 5XX XXX 5555</strong>. Use it any time to view or cancel this
            appointment.
          </div>
        </div>

        <div className={styles.actions}>
          <button type="button" className={`${styles['btn-primary']} ${styles.primary}`}>
            View my appointments →
          </button>
          <div className={styles['secondary-row']}>
            <button type="button" className={styles['btn-secondary']}>
              📅 Add to calendar
            </button>
            <button type="button" className={styles['btn-secondary']}>
              📷 Screenshot this
            </button>
          </div>
        </div>

        <div className={styles['phone-fallback']}>
          Need to change something?{' '}
          <strong>Call the clinic: +966 11 XXX 8900</strong>
          <br />
          No account needed — phone + booking ref is enough.
        </div>
      </div>
    </PatientFrame>
  );
}