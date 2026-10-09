/**
 * StepCard — numbered (or "done" / "current") card used to gate each
 * sub-form within a multi-step flow.
 *
 * Three states:
 *   - "current"  : teal-bordered card, the active sub-step.
 *   - "done"     : soft-tinted collapsed card, used on the confirm step
 *                  to summarize a completed sub-step with an "Edit" link.
 *   - "upcoming" : muted card, used for steps the user can't access yet.
 *
 * The body content is a free slot. The header is fixed: a number badge
 * + title + (optional) meta tag.
 */
import type { ReactNode } from 'react';
import styles from './StepCard.module.css';

type State = 'current' | 'done' | 'upcoming';

interface Props {
  number: number;
  title: string;
  meta?: string;
  state?: State;
  /** Optional right-aligned element (e.g. an "Edit" link). Rendered
   *  in the head row. */
  aside?: ReactNode;
  children: ReactNode;
}

export function StepCard({
  number,
  title,
  meta,
  state = 'current',
  aside,
  children,
}: Props): JSX.Element {
  const stateClass =
    state === 'done'
      ? styles['step-card--done']
      : state === 'upcoming'
        ? styles['step-card--upcoming']
        : styles['step-card--current'];
  return (
    <section
      className={`${styles['step-card']} ${stateClass}`}
      aria-current={state === 'current' ? 'step' : undefined}
    >
      <div className={styles['step-card__head']}>
        <div
          className={
            state === 'done'
              ? styles['step-card__badge--done']
              : styles['step-card__badge']
          }
        >
          {state === 'done' ? '✓' : number}
        </div>
        <div className={styles['step-card__head-body']}>
          <div className={styles['step-card__title']}>{title}</div>
          {meta && <div className={styles['step-card__meta']}>{meta}</div>}
        </div>
        {aside && <div className={styles['step-card__aside']}>{aside}</div>}
      </div>
      <div className={styles['step-card__body']}>{children}</div>
    </section>
  );
}
