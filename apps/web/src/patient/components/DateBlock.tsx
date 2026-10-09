/**
 * DateBlock — vertical stack showing month / day / day-of-week.
 *
 * Shared across the patient surfaces (MyAppointments, ReschedulePage,
 * RecurringOccurrenceCancel). Rendered as a small tile on the left edge
 * of an appointment row, picking up the mockup brand tint via the
 * `tone` prop.
 *
 * The date math is UTC-based to match the API's working plane
 * (see booking-utils.ts). The branch.tz field is shown as a hint
 * elsewhere, not used for math here.
 */
import styles from './DateBlock.module.css';

interface Props {
  /** ISO-8601 timestamp or YYYY-MM-DD string. The UTC parts are used. */
  iso: string;
  /** 'brand' (teal-on-white) for "this upcoming / selected" look,
   *  'muted' (gray-on-light) for a softer tile. Default 'brand'. */
  tone?: 'brand' | 'muted';
}

function parseUtcDate(iso: string): Date {
  // Be tolerant: a YYYY-MM-DD is treated as a UTC midnight.
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    return new Date(`${iso}T00:00:00Z`);
  }
  return new Date(iso);
}

function formatParts(iso: string): { month: string; day: string; dow: string } {
  const d = parseUtcDate(iso);
  const month = d.toLocaleDateString('en-US', {
    month: 'short',
    timeZone: 'UTC',
  });
  const day = String(d.getUTCDate());
  const weekday = d.toLocaleDateString('en-US', {
    weekday: 'short',
    timeZone: 'UTC',
  });
  return { month, day, dow: weekday };
}

export function DateBlock({ iso, tone = 'brand' }: Props): JSX.Element {
  const { month, day, dow } = formatParts(iso);
  return (
    <div
      className={`${styles['date-block']} ${
        tone === 'muted' ? styles['date-block--muted'] : ''
      }`}
      aria-hidden={tone === 'muted' ? 'true' : undefined}
    >
      <div className={styles['date-block__month']}>{month}</div>
      <div className={styles['date-block__day']}>{day}</div>
      <div className={styles['date-block__dow']}>{dow}</div>
    </div>
  );
}
