/**
 * StepFooter — bottom row for a multi-step form.
 *
 * Three slots:
 *   - left   : "Back" / "Cancel" link
 *   - middle : optional 1-line summary (e.g. "Dr. East Lead · Cardiology")
 *   - right  : primary action button
 *
 * The `back` slot is rendered as a ghost button so the visual weight
 * stacks toward the primary action on the right (matches mock 02/03/04).
 */
import type { ReactNode } from 'react';
import { Button } from './Button';
import styles from './StepFooter.module.css';

interface Props {
  /** Back handler. Omit to hide the back link. */
  onBack?: () => void;
  backLabel?: string;
  /** Primary action label. Omit to hide the primary action. */
  primaryLabel?: string;
  onPrimary?: () => void;
  primaryDisabled?: boolean;
  primaryAriaLabel?: string;
  /** Optional small summary text rendered between back and primary. */
  middle?: ReactNode;
  /** Optional extra slot rendered to the right of the primary action. */
  extra?: ReactNode;
}

export function StepFooter({
  onBack,
  backLabel = 'Back',
  primaryLabel,
  onPrimary,
  primaryDisabled = false,
  primaryAriaLabel,
  middle,
  extra,
}: Props): JSX.Element {
  return (
    <div className={styles['step-footer']}>
      <div className={styles['step-footer__left']}>
        {onBack && (
          <Button variant="ghost" onClick={onBack} aria-label={backLabel}>
            ← {backLabel}
          </Button>
        )}
      </div>
      {middle && (
        <div className={styles['step-footer__middle']}>{middle}</div>
      )}
      <div className={styles['step-footer__right']}>
        {extra}
        {primaryLabel && onPrimary && (
          <Button
            variant="primary"
            size="lg"
            onClick={onPrimary}
            disabled={primaryDisabled}
            aria-label={primaryAriaLabel ?? primaryLabel}
          >
            {primaryLabel}
          </Button>
        )}
      </div>
    </div>
  );
}
