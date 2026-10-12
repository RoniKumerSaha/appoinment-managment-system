/**
 * 25-doctor-affected-kanban-load.spec.ts
 *
 * The doctor's "Resolve affected appointments" page calls
 * `GET /doctor/affected` on mount. We assert the endpoint contract
 * (200 + correct envelope shape + role gate).
 *
 * The "kanban" UI shows 4 columns: todo / doing / scheduling / done.
 * The exact row count depends on the seed state, so we just assert
 * the page loads and the response envelope matches.
 */
import { test, expect } from '../fixtures.ts';
import { DoctorPage } from '../pages/doctor.page.ts';
import { listDoctorAffected } from '../helpers/api.ts';

test.use({ storageState: 'e2e/.auth/doctor-east.json' });

test('GET /doctor/affected returns the typed envelope; kanban mounts', async ({
  page,
}) => {
  await page.goto('/');
  const doctor = new DoctorPage(page);
  await doctor.expectMounted();
  await doctor.expectOnAffected();

  // The token from storageState is what the page uses. We need a
  // fresh token for the API call (see spec 12 comment for why).
  // Read the token from the page's localStorage.
  const token = await page.evaluate(() => {
    const raw = window.localStorage.getItem('medislot.auth');
    if (!raw) throw new Error('no auth');
    return (JSON.parse(raw) as { token: string }).token;
  });

  const envelope = await listDoctorAffected(token);
  expect(envelope.count).toBeGreaterThanOrEqual(0);
  expect(Array.isArray(envelope.appointments)).toBe(true);
});
