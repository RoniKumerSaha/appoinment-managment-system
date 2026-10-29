/**
 * The section lists for the doctor + receptionist navs.
 *
 * Kept in one place so the nav, the router, and the E2E specs all
 * agree on the `?page=` keys. The keys are the same strings the
 * router's `toDoctorView` / `toRecepView` already parse.
 */
import type { StaffNavItem } from './StaffNav';

/**
 * The doctor's sections.
 *
 * `affected` is the default view — the kanban the doctor sees on
 * every login. `series` is the recurring-series form; the preview /
 * confirm / back-out screens are STEPS of that flow, not separate
 * sections, so they are reached from the form rather than from the
 * nav (the nav would let a doctor jump straight into a preview with
 * no series in hand).
 */
export const DOCTOR_NAV: StaffNavItem[] = [
  {
    key: 'affected',
    label: 'Affected',
    title: 'Appointments that need your attention',
  },
  {
    key: 'series',
    label: 'Recurring series',
    title: 'Book a recurring appointment series',
  },
];

/**
 * The receptionist's sections.
 *
 * `today` is the default view. `cancel` is a section because it has
 * its own screen (mock 15) with a preselected appointment; it is
 * reachable from Today per-row AND directly from the nav.
 */
export const RECEPTIONIST_NAV: StaffNavItem[] = [
  { key: 'today', label: 'Today', title: "Today's appointments" },
  { key: 'create', label: 'Book walk-in', title: 'Book on behalf of a patient' },
  {
    key: 'availability',
    label: 'Availability',
    title: 'Browse the doctor’s open slots',
  },
  { key: 'cancel', label: 'Cancel', title: 'Cancel an appointment' },
];

/**
 * Pages that are steps of a section rather than sections of their
 * own. The doctor flow's preview / confirm / back-out screens belong
 * to the recurring-series section — a nav that highlighted nothing
 * on those screens would read as broken.
 */
export const DOCTOR_NAV_ALIASES: Record<string, string> = {
  preview: 'series',
  confirm: 'series',
  backout: 'series',
};
