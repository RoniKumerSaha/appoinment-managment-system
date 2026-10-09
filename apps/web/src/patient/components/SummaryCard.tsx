/**
 * SummaryCard — vertical k/v panel used in the right rail of the
 * booking flow and the reschedule flow. Wraps SummaryRow(s) with an
 * optional title and a small icon.
 *
 * Used by PatientBooking step 4 rail and ReschedulePage step 1.
 */
import type { ReactNode } from 'react';
import { SummaryRow } from './SummaryRow';
import styles from './SummaryCard.module.css';

interface Props {
  title?: string;
  icon?: string;
  children: ReactNode;
}

export function SummaryCard({ title, icon, children }: Props): JSX.Element {
  return (
    <div className={styles['summary-card']}>
      {(title || icon) && (
        <div className={styles['summary-card__head']}>
          {icon && <span className={styles['summary-card__icon']}>{icon}</span>}
          {title && <h4 className={styles['summary-card__title']}>{title}</h4>}
        </div>
      )}
      <div className={styles['summary-card__body']}>{children}</div>
    </div>
  );
}

SummaryCard.Row = SummaryRow;
