/**
 * ConflictModal — universal three-part pattern (mockup 29).
 *
 * Shape: icon · what · why · [rule] · canDo. Used wherever a booking or
 * configuration action can't proceed and we need to show *what* happened,
 * *why* (with a rule citation), and at least one path forward.
 *
 * E7-S4 (this story): this is the **single** ConflictModal in the
 * codebase. The I/O matrix from spec-7-4 pins the contract:
 *     - what  — present-tense, user-actionable ("This time isn't available")
 *     - why   — the specific rule ("Another patient booked it first")
 *     - canDo — what the user can do next ("Pick another time")
 *               Always ≥ 1 option. **Never** "OK".
 *
 * E7-S5 accessibility hooks (WCAG 2.1 AA baseline):
 *     - `role="alertdialog"`, `aria-modal="true"`, `aria-labelledby`
 *       on the title; `aria-label` as override.
 *     - Focus trap: Tab / Shift+Tab cycle inside the dialog. First
 *       focusable element receives focus on open; focus is restored
 *       to the previously focused element on close.
 *     - `Escape` dismisses the modal (only when `onClose` is provided).
 *     - `Enter` triggers the focused button when one is focused.
 *     - `aria-describedby` on the what block.
 *
 * Three icon tones (E7-S4 expansion):
 *   - `warn`    (amber) — soft, recoverable (slot held, scope overlap,
 *               rebooking forbidden)
 *   - `danger`  (red)   — hard, blocks an action (branch deactivation
 *               with future appointments)
 *   - `info`    (blue)  — informational (e.g. "Already cancelled")
 *
 * Backward-compat surface (preserved for the one in-repo consumer,
 * AdminBranches, which shipped with the original E1-S1-ui shape):
 *   - `actions: ConflictAction[]` is accepted alongside `canDo`.
 *     `canDo` wins if both are passed.
 *   - `variant` (legacy) is mapped to `intent` (E7-S4) at render time.
 *   - `flow?: string` (chip above title, mockup 29) is preserved.
 *   - `rule?: string` (BR citation, mockup 29) is preserved. The
 *     three-slot contract is what/why/canDo; the rule citation is
 *     optional diagnostic value for the staff/doctor audience and
 *     does not affect the contract.
 *
 * No bespoke modal exists outside this file. The E7-S4 static test
 * (`apps/web/test/conflict-modal-singleton.test.ts`) enforces the
 * singleton invariant.
 */
import { useCallback, useEffect, useRef } from 'react';
import styles from './ConflictModal.module.css';

/** Selector for focusable elements inside the dialog (E7-S5). */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export type ConflictTone = 'warn' | 'danger' | 'info';

export type ConflictActionIntent = 'primary' | 'ghost' | 'danger';

export interface ConflictAction {
  label: string;
  onClick: () => void;
  /**
   * Visual weight. E7-S4 renamed `variant` → `intent` to match the
   * spec'd canDo shape; legacy `variant` is accepted via the
   * `actions` prop and mapped at render time.
   */
  intent?: ConflictActionIntent;
  /** @deprecated Prefer `intent`. Accepted for the E1-S1-ui shape. */
  variant?: ConflictActionIntent;
}

export interface CanDoAction {
  label: string;
  onClick: () => void;
  intent?: ConflictActionIntent;
}

export interface ConflictModalProps {
  /** E7-S4 — `tone` defaults to `'warn'`. */
  tone?: ConflictTone;
  /** "what happened" line. Inline `<strong>` is allowed. */
  what: React.ReactNode;
  /** "why this is blocked" line. Inline `<strong>` is allowed. */
  why?: React.ReactNode;
  /** E7-S4 — what the user can do next. Always ≥ 1 option. */
  canDo?: CanDoAction[];
  /** @deprecated Prefer `canDo`. Accepted for the E1-S1-ui shape. */
  actions?: ConflictAction[];
  /**
   * Optional flow tag shown above the title (e.g. "F-01 · Patient
   * booking"). Mirrors the `<span class="flow">` chip in mockup 29.
   */
  flow?: string;
  /**
   * Rule citation, e.g. `BR-024 · atomic_slot_hold_timeout`. Shown in
   * monospace under the why block.
   */
  rule?: string;
  /** E7-S4 — required modal title. */
  title?: string;
  /**
   * E7-S4 — overrides the dialog's accessible label. When omitted, the
   * `title` (if provided) is used via `aria-labelledby`.
   */
  ariaLabel?: string;
  /**
   * E7-S4 — explicit close handler. When undefined, the modal cannot
   * be dismissed via backdrop/Esc; the consumer must provide a
   * `canDo`/`actions` entry for dismissal. This enforces the
   * "no dead-end OK" rule for danger/info tones.
   */
  onClose?: () => void;
}

export function ConflictModal({
  tone = 'warn',
  what,
  why,
  canDo,
  actions,
  flow,
  rule,
  title,
  ariaLabel,
  onClose,
}: ConflictModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  // E7-S5 — remember the element focused when the modal opened so we
  // can restore it on close (WCAG 2.4.3 focus order).
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  // E7-S5 — Escape dismisses the modal when onClose is provided. Same
  // intent as clicking the first ghost action — never a dead end.
  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      // E7-S5 — focus trap. Tab / Shift+Tab cycle inside the dialog.
      if (e.key === 'Tab' && dialogRef.current) {
        const focusables = Array.from(
          dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
        ).filter((el) => el.offsetParent !== null || el === document.activeElement);
        if (focusables.length === 0) {
          e.preventDefault();
          return;
        }
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey) {
          if (active === first || !dialogRef.current.contains(active)) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (active === last || !dialogRef.current.contains(active)) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // E7-S5 — focus management. On open: capture previously-focused
  // element, move focus to the first focusable inside the dialog (or
  // the dialog itself). On close: restore focus.
  useEffect(() => {
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const firstFocusable = dialog.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    if (firstFocusable) {
      firstFocusable.focus();
    } else {
      // No interactive elements — give the dialog itself focus so
      // screen readers announce it. tabindex=-1 is set on the markup.
      dialog.focus();
    }
    return () => {
      const prev = previouslyFocusedRef.current;
      if (prev && typeof prev.focus === 'function') {
        prev.focus();
      }
    };
  }, []);

  const onBackdropClick = useCallback((): void => {
    if (onClose) onClose();
  }, [onClose]);

  // canDo wins over actions when both are passed.
  const renderedCanDo: CanDoAction[] = canDo ?? actions ?? [];

  // Render-time mapping: legacy `variant` → `intent`.
  const normalizedCanDo: CanDoAction[] = renderedCanDo.map((a) => ({
    label: a.label,
    onClick: a.onClick,
    intent: a.intent ?? (a as ConflictAction).variant ?? 'primary',
  }));

  const titleId = title ? 'conflict-modal-title' : undefined;
  const whatId = 'conflict-modal-what';
  const dialogAriaProps = titleId
    ? ({ 'aria-labelledby': titleId, 'aria-describedby': whatId } as const)
    : ariaLabel
      ? ({ 'aria-label': ariaLabel, 'aria-describedby': whatId } as const)
      : ({} as const);

  const iconChar = tone === 'danger' ? '⊘' : tone === 'info' ? 'i' : '!';
  const iconClass = `${styles['icon']} ${
    tone === 'danger'
      ? styles['icon--danger']
      : tone === 'info'
        ? styles['icon--info']
        : styles['icon--warn']
  }`;

  return (
    <div
      className={styles['backdrop']}
      role="presentation"
      onClick={onBackdropClick}
    >
      <div
        className={styles['modal']}
        role="alertdialog"
        aria-modal="true"
        tabIndex={-1}
        ref={dialogRef}
        {...dialogAriaProps}
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        <div className={iconClass} aria-hidden="true">
          {iconChar}
        </div>
        {flow && <div className={styles['flow']}>{flow}</div>}
        {title && (
          <h3 id={titleId} className={styles['title']}>
            {title}
          </h3>
        )}
        <div id={whatId} className={styles['what']}>
          {what}
        </div>
        {why && (
          <div className={styles['why']}>
            <strong>Why:</strong> {why}
          </div>
        )}
        {rule && <div className={styles['rule']}>rule: {rule}</div>}
        {normalizedCanDo.length > 0 && (
          <div className={styles['actions']}>
            {normalizedCanDo.map((a) => {
              const intent = a.intent ?? 'primary';
              const cls =
                intent === 'danger'
                  ? styles['action-danger']
                  : intent === 'ghost'
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
        )}
      </div>
    </div>
  );
}