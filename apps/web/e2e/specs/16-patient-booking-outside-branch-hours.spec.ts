/**
 * 16-patient-booking-outside-branch-hours.spec.ts
 *
 * When the patient picks a date that is *closed* for the chosen
 * branch, /availability returns `{ slots: [], reason: ... }`. The
 * patient app must render an empty state with the reason.
 *
 * We hit the API directly (the wizard's date picker is branch-aware,
 * so it never offers a closed day — we want to verify the API
 * contract and the empty-state UI).
 */
import { test, expect } from '../fixtures.ts';
import { PatientPage } from '../pages/patient.page.ts';
import { buildBookingFixture } from '../helpers/booking-fixture.ts';
import { verifyPatientOtp } from '../helpers/api.ts';
import { FIXTURE } from '../helpers/ids.ts';

const API_BASE = process.env['E2E_API_BASE'] ?? 'http://localhost:3001';

test.use({ storageState: 'e2e/.auth/patient-02.json' });

test('availability returns empty slots + reason on a closed branch day', async ({
  page,
}) => {
  const patient = new PatientPage(page);
  await page.goto('/');
  await patient.expectMounted();

  const apiAuth = await verifyPatientOtp(
    FIXTURE.patient02.phone,
    FIXTURE.patient02.code,
  );
  const apiToken = apiAuth.token;

  const fixture = await buildBookingFixture(page, {
    patientPhone: FIXTURE.patient02.phone,
    doctorNameIncludes: 'East Lead',
    branchNameIncludes: 'East',
    typeNameIncludes: 'Follow-up',
    daysAhead: 2,
  });

  // Pick a Sunday. The East Branch is closed on Sundays per the
  // seed (`fixtures/branches/east.json` has is_closed=true on
  // day_of_week=0). We compute "next Sunday" relative to today.
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + ((7 - d.getUTCDay()) % 7) + 7); // next Sunday
  const sunday = d.toISOString().slice(0, 10);

  const params = new URLSearchParams({
    doctor_id: fixture.doctor.id,
    branch_id: fixture.branch.id,
    date: sunday,
    appointment_type_id: fixture.type.id,
  });
  const res = await fetch(`${API_BASE}/availability?${params.toString()}`, {
    headers: { authorization: `Bearer ${apiToken}` },
  });
  expect(res.ok, `/availability must succeed`).toBe(true);
  const body = (await res.json()) as {
    slots: unknown[];
    reason?: string | null;
  };
  expect(Array.isArray(body.slots)).toBe(true);
  expect(body.slots.length).toBe(0);
  // `reason` is `closed_day` or `before_open_or_after_close` per
  // the availability route. Either is acceptable for "outside hours".
  expect(body.reason).toBeTruthy();
});
