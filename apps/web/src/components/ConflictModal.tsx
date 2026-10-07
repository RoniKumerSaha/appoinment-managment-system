/**
 * ConflictModal — universal three-part pattern (mockup 29).
 *
 * Shape: icon · what · why · rule · actions. Used wherever a booking or
 * configuration action can't proceed and we need to show *what* happened,
 * *why* (with a rule citation), and at least one path forward.
 *
 * Two icon tones:
 *   - `warn`    (#fef3c7/#b45309) — soft, recoverable (slot held, scope
 *               overlap, rebooking forbidden)
 *   - `danger`  (#fecaca/#991b1b) — hard, blocks an action (branch
 *               deactivation with future appointments)
 *
 * The "what" line accepts a `ReactNode` so callers can embed formatted
 * timestamps / doctor names. The "rule" line uses a monospace token so
 * `BR-024 · atomic_slot_hold_timeout` is visually distinct from prose.
 *
 * Backdrop click and `Escape` key both call `onClose` (treat as a
 * ghost-cancel — same as clicking the first non-primary action).
 */
import { useCallback, useEffect } from 'react';
import styles from './ConflictModal.module.css';

export type ConflictTone = 'warn' | 'danger';

export interface ConflictAction {
  label: string;
  onClick: () => void;
  /** Visual weight; `primary` defaults to teal, `danger` to red. */
  variant?: 'ghost' | 'primary' | 'danger';
}

export interface ConflictModalProps {
  tone: ConflictTone;
  title: string;
  /** "what happened" line. Inline `<strong>` is allowed. */
  what: React.ReactNode;
  /** "why this is blocked" line. Inline `<strong>` is allowed. */
  why: React.ReactNode;
  /** Rule citation, e.g. `BR-024 · atomic_slot_hold_timeout`. */
  rule: string;
  actions: ConflictAction[];
  onClose?: () => void;
  /**
   * Optional flow tag shown above the title (e.g. "F-01 · Patient
   * booking"). Mirrors the `<span class="flow">` chip in mockup 29.
   */
  flow?: string;
}

export function ConflictModal({
  tone,
  title,
  what,
  why,
  rule,
  actions,
  onClose,
  flow,
}: ConflictModalProps) {
  // Escape dismisses the modal. onClose is treated as the same intent as
  // clicking the first ghost action — never a dead end.
  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const onBackdropClick = useCallback((): void => {
    if (onClose) onClose();
  }, [onClose]);

  const iconChar = tone === 'danger' ? '⊘' : '!';
  const iconClass =
    tone === 'danger'
      ? `${styles['icon']} ${styles['icon--danger']}`
      : `${styles['icon']} ${styles['icon--warn']}`;

  return (
    <div
      className={styles['backdrop']}
      role="presentation"
      onClick={onBackdropClick}
    >
      <div
        className={styles['modal']}
        role="dialog"
        aria-modal="true"
        aria-labelledby="conflict-modal-title"
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        <div className={iconClass} aria-hidden="true">
          {iconChar}
        </div>
        {flow && <div className={styles['flow']}>{flow}</div>}
        <h3 id="conflict-modal-title" className={styles['title']}>
          {title}
        </h3>
        <div className={styles['what']}>{what}</div>
        <div className={styles['why']}>
          <strong>Why:</strong> {why}
        </div>
        <div className={styles['rule']}>rule: {rule}</div>
        <div className={styles['actions']}>
          {actions.map((a) => {
            const variant = a.variant ?? 'primary';
            const cls =
              variant === 'danger'
                ? styles['action-danger']
                : variant === 'ghost'
                  ? styles['action-ghost']
                  : styles['action-primary'];
            return (
              <button
                key={a.label}
                type="button"
                className={cls}
                onClick={a.onClick}
              >
                {a.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}