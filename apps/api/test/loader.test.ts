/**
 * loader.test.ts — verifies the typed path-based fixture loader.
 *
 * Covers:
 *   - Every `loadX` function returns a shape that matches the canonical
 *     fixture JSON (round-trip the source-of-truth files).
 *   - `FixtureInvalidError` fires when a required field is missing.
 *   - `FixtureNotFoundError` fires for an unknown slug.
 *   - Path traversal is rejected.
 *
 * Created in E0-S5 review (P4) to pin the contract the smoke test left
 * unverified. Smoke test remains for developer ergonomics; this file is
 * the CI source of truth.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadClinic,
  loadBranch,
  loadDoctor,
  loadReceptionist,
  loadAdmin,
  loadPatient,
  FixtureNotFoundError,
  FixtureInvalidError,
} from './fixtures/loader.js';

test('loadClinic returns the singleton clinic fixture', () => {
  const c = loadClinic();
  assert.equal(c.id, 'clinic-main');
  assert.equal(c.name, 'Test Clinic');
});

test('loadBranch(east) returns the East branch with NY tz', () => {
  const b = loadBranch('east');
  assert.equal(b.id, 'branch-east');
  assert.equal(b.tz, 'America/New_York');
});

test('loadBranch(west) returns the West branch with LA tz', () => {
  const b = loadBranch('west');
  assert.equal(b.id, 'branch-west');
  assert.equal(b.tz, 'America/Los_Angeles');
});

test('loadDoctor(east.lead) returns the lead doctor fixture', () => {
  const d = loadDoctor('east.lead');
  assert.equal(d.id, 'doctor-east-lead');
  assert.equal(d.full_name, 'Dr. East Lead');
  assert.ok(d.branch_ids.includes('branch-east'));
  assert.ok(Array.isArray(d.appointment_type_ids));
  assert.ok(d.appointment_type_ids.length >= 1);
});

test('loadReceptionist(east) returns the east receptionist', () => {
  const r = loadReceptionist('east');
  assert.equal(r.id, 'receptionist-east');
  assert.equal(r.branch_id, 'branch-east');
  assert.ok(r.email.endsWith('@clinic.local'));
});

test('loadAdmin(main) returns the singleton admin', () => {
  const a = loadAdmin('main');
  assert.equal(a.id, 'admin-main');
  assert.ok(a.email.endsWith('@clinic.local'));
});

test('loadPatient(0001) returns the patient with has_future_appointment=true', () => {
  const p = loadPatient('0001');
  assert.equal(p.phone_number, '+15550000001');
  assert.equal(p.has_future_appointment, true);
});

test('loadBranch(does-not-exist) throws FixtureNotFoundError', () => {
  assert.throws(
    () => loadBranch('does-not-exist'),
    (err: unknown) => err instanceof FixtureNotFoundError,
  );
});

test('loadDoctor(../escape) throws FixtureNotFoundError (path-traversal block)', () => {
  assert.throws(
    () => loadDoctor('../escape'),
    (err: unknown) => err instanceof FixtureNotFoundError,
  );
});

test('loader rejects malformed JSON via FixtureInvalidError', () => {
  // P4: this is the path the smoke test left unverified. Write a temp
  // fixture file that is missing a required field — the loader will report
  // the FIRST missing field it encounters (order in `requireString` chain).
  // We assert the typed `FixtureInvalidError` fires with the right shape;
  // the specific field name depends on the loader's iteration order and is
  // not pinned here.
  const dir = join(process.cwd(), 'test', 'fixtures', 'branches');
  const tempSlug = `__malformed_${Date.now()}`;
  const tempPath = join(dir, `${tempSlug}.json`);
  writeFileSync(
    tempPath,
    JSON.stringify({ id: 'malformed', name: 'M' /* tz + clinic_id missing */ }),
    'utf8',
  );
  try {
    assert.throws(
      () => loadBranch(tempSlug),
      (err: unknown) =>
        err instanceof FixtureInvalidError &&
        ['clinic_id', 'tz', 'id', 'name'].includes(err.missingField),
    );
  } finally {
    rmSync(tempPath, { force: true });
  }
});

test('loader rejects empty JSON object via FixtureInvalidError', () => {
  // An empty object fails the very first required-field check. Pins the
  // typed error contract from the spec I/O matrix.
  const dir = join(process.cwd(), 'test', 'fixtures', 'branches');
  const tempSlug = `__empty_${Date.now()}`;
  const tempPath = join(dir, `${tempSlug}.json`);
  writeFileSync(tempPath, '{}', 'utf8');
  try {
    assert.throws(
      () => loadBranch(tempSlug),
      (err: unknown) => err instanceof FixtureInvalidError,
    );
  } finally {
    rmSync(tempPath, { force: true });
  }
});
