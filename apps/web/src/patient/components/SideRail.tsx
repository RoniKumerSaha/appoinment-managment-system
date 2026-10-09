/**
 * SideRail — right-rail companion card for the booking flow steps.
 *
 * Mockups 02/03/04/34/35/41 all place a small "Your selection" / "What's
 * next" / "Good to know" / "Quick facts" panel beside the main column.
 * This component is that panel, with a flexible title + body slot.
 *
 * Used by PatientBooking.tsx step 1 / 2 / 3 rails.
 */
import type { ReactNode } from 'react';
import styles from './SideRail.module.css';

interface Props {
  /** Short heading (e.g. "Your selection"). Rendered as a small caption. */
  title: string;
  /** Optional eyebrow text shown above the title (e.g. "STEP 1"). */
  eyebrow?: string;
  /** Optional icon-as-text glyph rendered next to the title. */
  icon?: string;
  /** Body content. The component doesn't impose a layout. */
  children: ReactNode;
  /** Visual emphasis. 'default' = subtle white card; 'tinted' = teal
   *  background for the "Good to know" callouts (mock 34/35). */
  variant?: 'default' | 'tinted' | 'muted';
}

export function SideRail({
  title,
  eyebrow,
  icon,
  children,
  variant = 'default',
}: Props): JSX.Element {
  const variantClass =
    variant === 'tinted'
      ? styles['side-rail--tinted']
      : variant === 'muted'
        ? styles['side-rail--muted']
        : '';
  return (
    <aside
      className={`${styles['side-rail']} ${variantClass}`}
      role="complementary"
    >
      {eyebrow && (
        <div className={styles['side-rail__eyebrow']}>{eyebrow}</div>
      )}
      <div className={styles['side-rail__head']}>
        {icon && <span className={styles['side-rail__icon']}>{icon}</span>}
        <h3 className={styles['side-rail__title']}>{title}</h3>
      </div>
      <div className={styles['side-rail__body']}>{children}</div>
    </aside>
  );
}

interface RowProps {
  /** Label, e.g. "Doctor". */
  label: string;
  /** Value, e.g. "Dr. East Lead". Rendered as a span; pass JSX for inline
   *  formatting. */
  children: ReactNode;
}

export function SideRailRow({ label, children }: RowProps): JSX.Element {
  return (
    <div className={styles['side-rail__row']}>
      <div className={styles['side-rail__row-label']}>{label}</div>
      <div className={styles['side-rail__row-value']}>{children}</div>
    </div>
  );
}

interface BulletProps {
  children: ReactNode;
}

export function SideRailBullet({ children }: BulletProps): JSX.Element {
  return (
    <li className={styles['side-rail__bullet']}>
      <span className={styles['side-rail__bullet-glyph']} aria-hidden="true">
        •
      </span>
      <span>{children}</span>
    </li>
  );
}
