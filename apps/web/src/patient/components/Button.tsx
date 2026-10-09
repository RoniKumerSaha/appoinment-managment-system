/**
 * Button — shared button component for patient surfaces.
 *
 * Variants:
 *   - primary:  brand-tinted background, white text. The "Continue" CTA.
 *   - secondary: outlined, brand-colored text + border. The "Back" CTA.
 *   - ghost:    borderless text button. Inline "Edit" / "Cancel" links.
 *   - danger:   red CTA. Reserved for cancellation paths.
 *
 * Sizes:
 *   - md (default): 14px / 14px padding. Most uses.
 *   - lg: 16px / 18px padding. CTAs that want extra weight.
 *   - sm: 12px / 8px padding. Inline links styled as buttons.
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import styles from './Button.module.css';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  fullWidth?: boolean;
  children: ReactNode;
}

function classes(variant: Variant, size: Size, fullWidth: boolean): string {
  const v =
    variant === 'primary'
      ? styles['btn--primary']
      : variant === 'secondary'
        ? styles['btn--secondary']
        : variant === 'ghost'
          ? styles['btn--ghost']
          : styles['btn--danger'];
  const s =
    size === 'sm'
      ? styles['btn--sm']
      : size === 'lg'
        ? styles['btn--lg']
        : styles['btn--md'];
  const w = fullWidth ? styles['btn--full'] : '';
  return `${styles['btn']} ${v} ${s} ${w}`.trim();
}

export function Button({
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  children,
  className,
  type = 'button',
  ...rest
}: Props): JSX.Element {
  return (
    <button
      type={type}
      className={`${classes(variant, size, fullWidth)}${
        className ? ` ${className}` : ''
      }`}
      {...rest}
    >
      {children}
    </button>
  );
}
