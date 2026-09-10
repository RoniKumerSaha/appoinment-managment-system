/**
 * Loader smoke test (one-off) — verifies all fixture loaders resolve and
 * throw the typed errors for invalid paths. Run via:
 *   pnpm --filter @clinic/api exec tsx test/fixtures/loader.smoke.ts
 *
 * This file is NOT part of the node:test suite (it uses console.assert
 * rather than node:test); it is a developer-only sanity check.
 */
import {
  loadClinic,
  loadBranch,
  loadDoctor,
  loadReceptionist,
  loadAdmin,
  loadPatient,
  FixtureNotFoundError,
  FixtureInvalidError,
} from './loader.js';

function assertEq(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    process.exitCode = 1;
  } else {
    console.log(`OK ${label}`);
  }
}

assertEq(loadClinic(), { id: 'clinic-main', name: 'Test Clinic' }, 'loadClinic');
assertEq(loadBranch('east'), { id: 'branch-east', clinic_id: 'clinic-main', name: 'East Branch', tz: 'America/New_York' }, 'loadBranch east');
assertEq(loadBranch('west'), { id: 'branch-west', clinic_id: 'clinic-main', name: 'West Branch', tz: 'America/Los_Angeles' }, 'loadBranch west');
assertEq(loadDoctor('east.lead'), { id: 'doctor-east-lead', full_name: 'Dr. East Lead', branch_ids: ['branch-east'], appointment_type_ids: ['appointment-type-general', 'appointment-type-followup'] }, 'loadDoctor east.lead');
assertEq(loadReceptionist('east'), { id: 'receptionist-east', branch_id: 'branch-east', full_name: 'Receptionist East', email: 'receptionist-east@clinic.local' }, 'loadReceptionist east');
assertEq(loadAdmin('main'), { id: 'admin-main', full_name: 'Admin Main', email: 'admin-main@clinic.local' }, 'loadAdmin');
assertEq(loadPatient('0001'), { phone_number: '+15550000001', full_name: 'Patient One', has_future_appointment: true }, 'loadPatient 0001');

// Error path: not found
try {
  loadBranch('does/not/exist');
  console.error('FAIL loadBranch(not-exist) should throw');
  process.exitCode = 1;
} catch (e) {
  if (e instanceof FixtureNotFoundError) {
    console.log(`OK loadBranch not_found path=${e.path}`);
  } else {
    console.error(`FAIL loadBranch wrong error type: ${e}`);
    process.exitCode = 1;
  }
}

// Error path: directory traversal
try {
  loadDoctor('../oops');
  console.error('FAIL loadDoctor(..) should throw');
  process.exitCode = 1;
} catch (e) {
  if (e instanceof FixtureNotFoundError) {
    console.log(`OK loadDoctor traversal-blocked path=${e.path}`);
  } else {
    console.error(`FAIL loadDoctor wrong error type: ${e}`);
    process.exitCode = 1;
  }
}

console.log(process.exitCode ? 'loader smoke: FAILED' : 'loader smoke: ALL OK');
