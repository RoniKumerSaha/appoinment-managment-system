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
 * These mirror the six items in the `doctor.md` Act 1 sidebar:
 * **Schedule editor, Today, Block time, Appointment types, Recurring
 * preview, Resolve affected**.
 *
 * `affected` and `series` were the only two that existed. The
 * other four are now real:
 *   - `today`  → the doctor's own day list (mock 12)
 *   - `schedule` → the doctor's weekly schedule editor (mock 09)
 *   - `blocks` → the doctor's block-time-off form (mock 10)
 *   - `types` → the doctor's read-only appointment catalogue (mock 11)
 *
 * The recurring-series flow's preview / confirm / back-out screens
 * are STEPS of that flow, not sections of their own, so they are
 * reached from the form rather than from the nav (the nav would let
 * a doctor jump straight into a preview with no series in hand).
 * `DOCTOR_NAV_ALIASES` maps them onto `series` so the nav still
 * highlights the right link while those screens are open.
 */
export const DOCTOR_NAV: StaffNavItem[] = [
  {
    key: 'today',
    label: 'Today',
    title: "Your appointments for the day",
  },
  {
    key: 'affected',
    label: 'Affected',
    title: 'Appointments that need your attention',
  },
  {
    key: 'schedule',
    label: 'Schedule',
    title: 'Set your weekly working hours',
  },
  {
    key: 'blocks',
    label: 'Block time',
    title: 'Mark dates when you cannot see patients',
  },
  {
    key: 'types',
    label: 'Appointment types',
    title: 'The consultations the clinic offers',
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
 *
 * `series` was added when the receptionist gained the recurring-series
 * flow. The API has ALWAYS accepted a receptionist on
 * `POST /recurring/preview` and `POST /recurring/confirm` — the scope
 * is branch-only (BR-004) and the preview verifies that the chosen
 * doctor actually works at that branch (`doctor_not_at_branch`). The
 * flow was simply never mounted on this surface, so the server was
 * more capable than the receptionist's own screens.
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
  {
    key: 'series',
    label: 'Recurring series',
    title: 'Book a recurring appointment series',
  },
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

/**
 * The receptionist's equivalents.
 *
 * The receptionist has no back-out screen: `RecurringBackOut` reads
 * the series through `GET /doctor/recurring/:seriesId`, which is
 * scoped to the doctor who owns the series, so a receptionist cannot
 * read a series they booked — and the screen is rendered in
 * `DoctorFrame` regardless. It is deliberately NOT aliased, so
 * `#/reception?page=backout` falls through to the default view
 * rather than rendering a doctor screen inside the receptionist's nav.
 */
export const RECEPTIONIST_NAV_ALIASES: Record<string, string> = {
  preview: 'series',
  confirm: 'series',
};
