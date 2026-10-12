/**
 * e2e/helpers/booking-fixture.ts — discover live IDs for booking specs.
 *
 * Doctor / branch / type IDs are UUIDs in the seed, not the friendly
 * `doctor-east-lead` slugs. To keep specs independent of seed order
 * and stable across re-seeds, each booking spec queries the live API
 * for the catalog and builds a fresh "booking context" with one
 * doctor / one branch / one type / one future slot.
 *
 * The token used for catalog reads is the one stored in the
 * browser's localStorage under `medislot.auth` (planted by
 * auth.setup.ts). We extract it from the page on demand. If a spec
 * needs to call the API before the page has loaded (e.g. cleanup),
 * it can pass a `token` argument explicitly.
 *
 * The helper avoids `process.env` reads so it works in both Node and
 * the browser.
 */
import { expect, type Page } from '@playwright/test';
import {
  listPublicDoctors,
  listPublicBranches,
  listPublicAppointmentTypes,
  type PublicDoctor,
  type PublicBranch,
  type PublicAppointmentType,
} from './api.ts';

const API_BASE = process.env['E2E_API_BASE'] ?? 'http://localhost:3001';

interface AvailabilityResponse {
  slots: Array<{ start_datetime: string; end_datetime: string }>;
  reason?: string | null;
}

async function getAvailability(
  token: string,
  query: {
    doctor_id: string;
    branch_id: string;
    date: string;
    appointment_type_id: string;
  },
): Promise<AvailabilityResponse> {
  const params = new URLSearchParams({
    doctor_id: query.doctor_id,
    branch_id: query.branch_id,
    date: query.date,
    appointment_type_id: query.appointment_type_id,
  });
  // Use the live API endpoint via the dev server's proxy.
  // We can't reach /availability without auth (patient claim or staff),
  // and the storageState token is for the patient sub.
  const res = await fetch(
    `${API_BASE}/availability?${params.toString()}`,
    {
      headers: { authorization: `Bearer ${token}` },
    },
  );
  if (!res.ok) {
    throw new Error(
      `availability ${res.status}: ${await res.text().catch(() => '<empty>')}`,
    );
  }
  return (await res.json()) as AvailabilityResponse;
}

export interface BookingFixture {
  doctor: PublicDoctor;
  branch: PublicBranch;
  type: PublicAppointmentType;
  /** YYYY-MM-DD, in branch-local date. */
  date: string;
  /** ISO datetime of the first available slot. */
  startDatetime: string;
  endDatetime: string;
  slotDurationMinutes: number;
}

export async function readTokenFromStorage(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const raw = window.localStorage.getItem('medislot.auth');
    if (!raw) throw new Error('no auth in localStorage');
    const parsed = JSON.parse(raw) as { token?: string };
    if (!parsed.token) throw new Error('no token in auth blob');
    return parsed.token;
  });
}

export async function getAuthToken(page: Page): Promise<string> {
  return readTokenFromStorage(page);
}

/**
 * Pick a future date that has slots. Walks from `daysAhead` to
 * `daysAhead + windowDays` (default 7) and returns the first date
 * with at least one slot.
 *
 * Returns a mid-day slot (not the first one) so the slot is safely
 * inside branch hours. The availability API returns slots in UTC; for
 * a 09:00-17:00 America/New_York branch, the first slot lands at
 * 09:00 UTC = 05:00 EDT (outside hours), so we skip the morning
 * wing and pick around 14:00-15:00 UTC which corresponds to mid-morning
 * Eastern or late-morning Pacific depending on the branch tz.
 */
async function pickFirstAvailableSlot(
  token: string,
  doctorId: string,
  branchId: string,
  typeId: string,
  daysAhead = 2,
  windowDays = 7,
): Promise<{ date: string; startDatetime: string; endDatetime: string }> {
  for (let i = 0; i < windowDays; i += 1) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + daysAhead + i);
    const date = d.toISOString().slice(0, 10);
    const res = await getAvailability(token, {
      doctor_id: doctorId,
      branch_id: branchId,
      date,
      appointment_type_id: typeId,
    });
    if (res.slots.length > 0) {
      // Pick a mid-day slot to avoid the UTC-vs-local-tz edge case
      // where the first slot lands before branch open in local time.
      const idx = Math.min(20, res.slots.length - 1);
      const slot = res.slots[idx]!;
      return {
        date,
        startDatetime: slot.start_datetime,
        endDatetime: slot.end_datetime,
      };
    }
  }
  throw new Error(
    `no availability in ${daysAhead}..${daysAhead + windowDays} days for doctor=${doctorId} branch=${branchId} type=${typeId}`,
  );
}

export interface BuildBookingFixtureOptions {
  /** Patient phone used to drive the patient UI. */
  patientPhone: string;
  /** Pick a specific doctor by `full_name` substring (e.g. 'East Lead'). */
  doctorNameIncludes?: string;
  /** Pick a specific branch by `name` substring (e.g. 'East'). */
  branchNameIncludes?: string;
  /** Pick a specific appointment type by `name` substring (e.g. 'General'). */
  typeNameIncludes?: string;
  /** Days from today for the first availability attempt. Default 2. */
  daysAhead?: number;
  /** Window to search. Default 7. */
  windowDays?: number;
}

export async function buildBookingFixture(
  page: Page,
  opts: BuildBookingFixtureOptions,
): Promise<BookingFixture> {
  const token = await getAuthToken(page);
  const { doctors } = await listPublicDoctors(token);
  expect(doctors.length, 'at least one public doctor').toBeGreaterThan(0);
  const doctor = opts.doctorNameIncludes
    ? doctors.find((d) => d.full_name.includes(opts.doctorNameIncludes!)) ?? doctors[0]!
    : doctors[0]!;
  const { branches } = await listPublicBranches(token, doctor.id);
  expect(branches.length, `${doctor.full_name} has at least one branch`).toBeGreaterThan(0);
  const branch = opts.branchNameIncludes
    ? branches.find((b) => b.name.includes(opts.branchNameIncludes!)) ?? branches[0]!
    : branches[0]!;
  const { appointment_types: types } = await listPublicAppointmentTypes(token);
  expect(types.length, 'at least one appointment type').toBeGreaterThan(0);
  const type = opts.typeNameIncludes
    ? types.find((t) => t.name.includes(opts.typeNameIncludes!)) ?? types[0]!
    : types[0]!;
  const { date, startDatetime, endDatetime } = await pickFirstAvailableSlot(
    token,
    doctor.id,
    branch.id,
    type.id,
    opts.daysAhead ?? 2,
    opts.windowDays ?? 7,
  );
  return {
    doctor,
    branch,
    type,
    date,
    startDatetime,
    endDatetime,
    slotDurationMinutes: type.duration_minutes,
  };
}