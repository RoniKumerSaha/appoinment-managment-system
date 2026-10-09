/**
 * SummaryRow — single label/value row used inside SummaryCard.
 *
 * `highlight` is used for the row that should pull the eye (e.g. the
 * "when" row that combines date + time on the confirm step).
 */
import type { ReactNode } from 'react';
import styles from './SummaryRow.module.css';

interface Props {
  label: string;
  children: ReactNode;
  highlight?: boolean;
  /** Optional helper text rendered under the value. */
  hint?: string;
}

export function SummaryRow({
  label,
  children,
  highlight = false,
  hint,
}: Props): JSX.Element {
  return (
    <div
      className={`${styles['summary-row']} ${
        highlight ? styles['summary-row--highlight'] : ''
      }`}
    >
      <div className={styles['summary-row__label']}>{label}</div>
      <div className={styles['summary-row__value']}>{children}</div>
      {hint && <div className={styles['summary-row__hint']}>{hint}</div>}
    </div>
  );
}
