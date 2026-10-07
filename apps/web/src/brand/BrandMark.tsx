/**
 * BrandMark — the canonical MediSlot logo, inlined so SVG fills/strokes
 * inherit currentColor and can be tinted by parent CSS without an extra
 * fetch round-trip.
 *
 * Source of truth: docs/design/mockups/v1/imports/app/logo.svg
 * (calendar + medical cross monoline, brand teal #0f766e).
 */
import type { CSSProperties } from 'react';

export interface BrandMarkProps {
  size?: number;
  className?: string;
  style?: CSSProperties;
  title?: string;
}

export function BrandMark({
  size = 28,
  className,
  style,
  title = 'MediSlot',
}: BrandMarkProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 52 52"
      width={size}
      height={size}
      className={className}
      style={style}
      role="img"
      aria-label={title}
    >
      <title>{title}</title>
      <rect
        x="6"
        y="10"
        width="40"
        height="36"
        rx="7"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
      />
      <line x1="6" y1="20" x2="46" y2="20" stroke="currentColor" strokeWidth="2.4" />
      <line x1="18" y1="6" x2="18" y2="14" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      <line x1="34" y1="6" x2="34" y2="14" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="13" cy="25.5" r="1.4" fill="currentColor" />
      <circle cx="20" cy="25.5" r="1.4" fill="currentColor" />
      <circle cx="27" cy="25.5" r="1.4" fill="currentColor" />
      <circle cx="34" cy="25.5" r="1.4" fill="currentColor" />
      <circle cx="41" cy="25.5" r="1.4" fill="currentColor" />
      <circle cx="13" cy="33" r="2.4" fill="currentColor" />
      <rect x="32" y="29" width="10" height="3.2" rx="1.2" fill="currentColor" />
      <rect x="35.4" y="25.6" width="3.2" height="10" rx="1.2" fill="currentColor" />
      <circle cx="20" cy="40.5" r="1.4" fill="currentColor" />
      <circle cx="27" cy="40.5" r="1.4" fill="currentColor" />
    </svg>
  );
}