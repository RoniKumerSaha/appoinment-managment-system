/**
 * E0-S5 — fixture loader.
 *
 * Typed path-based loader for the JSON fixtures under `apps/api/test/fixtures/`.
 * Tests reference fixtures by stable path (`loadDoctor('east.lead')`), never by
 * inline JSON. This is the only sanctioned way test code touches fixture data.
 *
 * The loader:
 *   1. Builds an absolute path under `apps/api/test/fixtures/` from the slug.
 *   2. Reads + JSON.parses the file.
 *   3. Validates the parsed shape against a per-role hand-rolled runtime
 *      check (no new dep — matches the existing test/db/withTestDb.ts
 *      pattern that uses `import.meta.url` + `fileURLToPath`).
 *
 * Errors throw a typed class (`FixtureNotFoundError`, `FixtureInvalidError`)
 * that callers can `instanceof`-discriminate. Tests fail fast — never
 * silently returns `null`.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = here;

// ===== Typed error classes =====
export class FixtureNotFoundError extends Error {
  public readonly path: string;
  public readonly code = 'fixture_not_found';
  constructor(path: string) {
    super(`fixture_not_found: ${path}`);
    this.name = 'FixtureNotFoundError';
    this.path = path;
  }
}

export class FixtureInvalidError extends Error {
  public readonly path: string;
  public readonly missingField: string;
  public readonly code = 'fixture_invalid';
  constructor(path: string, missingField: string) {
    super(`fixture_invalid: ${path} (missing field: ${missingField})`);
    this.name = 'FixtureInvalidError';
    this.path = path;
    this.missingField = missingField;
  }
}

// ===== Shape definitions =====
export interface ClinicFixture {
  id: string;
  name: string;
}

export interface BranchFixture {
  id: string;
  clinic_id: string;
  name: string;
  tz: string;
}

export interface DoctorFixture {
  id: string;
  full_name: string;
  branch_ids: string[];
  appointment_type_ids: string[];
}

export interface ReceptionistFixture {
  id: string;
  branch_id: string;
  full_name: string;
  email: string;
}

export interface AdminFixture {
  id: string;
  full_name: string;
  email: string;
}

export interface PatientFixture {
  phone_number: string;
  full_name: string;
  has_future_appointment: boolean;
}

// ===== Internal helpers =====
function loadJson(path: string): unknown {
  if (!existsSync(path)) {
    throw new FixtureNotFoundError(path);
  }
  const raw = readFileSync(path, 'utf8');
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    throw new FixtureInvalidError(path, `<parse error: ${(err as Error).message}>`);
  }
}

function requireString(obj: unknown, key: string, path: string): string {
  if (
    typeof obj !== 'object' ||
    obj === null ||
    !(key in obj) ||
    typeof (obj as Record<string, unknown>)[key] !== 'string'
  ) {
    throw new FixtureInvalidError(path, key);
  }
  return (obj as Record<string, unknown>)[key] as string;
}

function requireStringArray(
  obj: unknown,
  key: string,
  path: string,
): string[] {
  const val = (obj as Record<string, unknown>)[key];
  if (!Array.isArray(val) || val.some((v) => typeof v !== 'string')) {
    throw new FixtureInvalidError(path, key);
  }
  return val as string[];
}

function requireBoolean(obj: unknown, key: string, path: string): boolean {
  const val = (obj as Record<string, unknown>)[key];
  if (typeof val !== 'boolean') {
    throw new FixtureInvalidError(path, key);
  }
  return val;
}

function buildPath(slug: string, ...segments: string[]): string {
  const absolute = resolve(FIXTURES_DIR, slug, ...segments);
  if (!absolute.startsWith(FIXTURES_DIR)) {
    // Defensive: a `slug` containing '..' must not escape the fixtures dir.
    throw new FixtureNotFoundError(`${slug}/${segments.join('/')}`);
  }
  return absolute;
}

// ===== Typed loaders =====
/** Load the singleton clinic fixture. */
export function loadClinic(): ClinicFixture {
  const path = buildPath('clinic.json');
  const obj = loadJson(path);
  return {
    id: requireString(obj, 'id', path),
    name: requireString(obj, 'name', path),
  };
}

/** Load a branch fixture by slug (e.g. `'branches/east'`). */
export function loadBranch(slug: string): BranchFixture {
  if (slug.includes('..') || slug.startsWith('/')) {
    throw new FixtureNotFoundError(`branches/${slug}`);
  }
  const path = buildPath('branches', `${slug}.json`);
  const obj = loadJson(path);
  return {
    id: requireString(obj, 'id', path),
    clinic_id: requireString(obj, 'clinic_id', path),
    name: requireString(obj, 'name', path),
    tz: requireString(obj, 'tz', path),
  };
}

/** Load a doctor fixture by slug (e.g. `'east.lead'`). */
export function loadDoctor(slug: string): DoctorFixture {
  if (slug.includes('..') || slug.startsWith('/')) {
    throw new FixtureNotFoundError(`doctors/${slug}`);
  }
  const path = buildPath('doctors', `${slug}.json`);
  const obj = loadJson(path);
  return {
    id: requireString(obj, 'id', path),
    full_name: requireString(obj, 'full_name', path),
    branch_ids: requireStringArray(obj, 'branch_ids', path),
    appointment_type_ids: requireStringArray(obj, 'appointment_type_ids', path),
  };
}

/** Load a receptionist fixture by slug (e.g. `'east'`). */
export function loadReceptionist(slug: string): ReceptionistFixture {
  if (slug.includes('..') || slug.startsWith('/')) {
    throw new FixtureNotFoundError(`receptionists/${slug}`);
  }
  const path = buildPath('receptionists', `${slug}.json`);
  const obj = loadJson(path);
  return {
    id: requireString(obj, 'id', path),
    branch_id: requireString(obj, 'branch_id', path),
    full_name: requireString(obj, 'full_name', path),
    email: requireString(obj, 'email', path),
  };
}

/** Load an admin fixture by slug (e.g. `'main'`). */
export function loadAdmin(slug: string): AdminFixture {
  if (slug.includes('..') || slug.startsWith('/')) {
    throw new FixtureNotFoundError(`admins/${slug}`);
  }
  const path = buildPath('admins', `${slug}.json`);
  const obj = loadJson(path);
  return {
    id: requireString(obj, 'id', path),
    full_name: requireString(obj, 'full_name', path),
    email: requireString(obj, 'email', path),
  };
}

/** Load a patient fixture by slug (e.g. `'0001'`). */
export function loadPatient(slug: string): PatientFixture {
  if (slug.includes('..') || slug.startsWith('/')) {
    throw new FixtureNotFoundError(`patients/${slug}`);
  }
  const path = buildPath('patients', `${slug}.json`);
  const obj = loadJson(path);
  return {
    phone_number: requireString(obj, 'phone_number', path),
    full_name: requireString(obj, 'full_name', path),
    has_future_appointment: requireBoolean(obj, 'has_future_appointment', path),
  };
}
