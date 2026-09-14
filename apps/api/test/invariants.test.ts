/**
 * invariants.test.ts — DB-touching test exercising every Architecture §4
 * invariant in the I/O & Edge-Case Matrix.
 *
 * Covers AC-2 (exclusion), AC-3 (per-doctor uniqueness), AC-4 (cross-doctor
 * allowed), AC-5 (cancelled + rebook), AC-6 (concurrent insert race),
 * AC-7 (updated_at trigger), AC-8 (updated_at default), AC-10 (created_by
 * CHECK), AC-11 (NULL), AC-12 (enum), AC-13 (audit UPDATE rejected),
 * AC-14 (audit DELETE rejected).
 *
 * AC-9 (seed snapshot) lives in seed.test.ts.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { getTestDb, type TestDb } from './db/withTestDb.js';

let db: TestDb;

before(async () => {
  db = await getTestDb();
});

// No `after(async () => { await closeShared(); })` — the shared pool is
// closed by `process.on('beforeExit' | 'SIGTERM' | 'SIGINT')` (see
// `withTestDb.ts`). Per-file close would race with sibling test files
// in the same worker.

interface Fixture {
  clinicId: string;
  branchId: string;
  doctorId: string;
  doctor2Id: string;
  patientPhone: string;
}

async function makeFixture(db: TestDb, tag: string): Promise<Fixture> {
  // Post-migration 0013 (E1-S0a), the `clinic` table carries a partial
  // unique index `idx_clinic_singleton ON clinic((true))` that rejects
  // every second INSERT with SQLSTATE 23505. The migration runner spins
  // up a fresh DB per worker; whichever fixture call lands first (the
  // E0-S5 seed, seed.test.ts's call to seedWith, or this fixture maker)
  // claims the singleton row, and every subsequent fixture call reuses
  // it via the same SELECT-then-INSERT pattern the E0-S5 seed uses.
  // Tests that need a unique clinic FK to a fresh id continue to work
  // — they just share the singleton. The downstream FKs (branch,
  // doctor, etc.) are unaffected because the singleton carries the FK
  // target, not the dependent tables.
  const existing = await db.pool.query<{ id: string }>(
    `SELECT id FROM clinic LIMIT 1`,
  );
  let clinicId: string;
  if (existing.rows[0]) {
    clinicId = existing.rows[0].id;
  } else {
    const c = await db.pool.query<{ id: string }>(
      `INSERT INTO clinic (name) VALUES ($1) RETURNING id`,
      [`Inv Clinic Singleton ${tag}`],
    );
    clinicId = c.rows[0]!.id;
  }
  const b = await db.pool.query<{ id: string }>(
    `INSERT INTO branch (clinic_id, name, tz) VALUES ($1, 'InvBranch', 'UTC') RETURNING id`,
    [clinicId],
  );
  const branchId = b.rows[0]!.id;
  const d1 = await db.pool.query<{ id: string }>(
    `INSERT INTO doctor (full_name) VALUES ('Inv Doc ' || $1) RETURNING id`,
    [tag],
  );
  const doctorId = d1.rows[0]!.id;
  const d2 = await db.pool.query<{ id: string }>(
    `INSERT INTO doctor (full_name) VALUES ('Inv Doc2 ' || $1) RETURNING id`,
    [tag],
  );
  const doctor2Id = d2.rows[0]!.id;
  const patientPhone = `+1555${Date.now().toString().slice(-7)}${tag}`;
  return { clinicId, branchId, doctorId, doctor2Id, patientPhone };
}

test('AC-2: two Scheduled same doctor+branch+window → exclusion violation', async () => {
  const fx = await makeFixture(db, 'A2');
  await db.pool.query(
    `INSERT INTO appointment (clinic_id, branch_id, doctor_id, patient_phone, start_datetime, end_datetime, status, created_by)
     VALUES ($1, $2, $3, $4, '2099-02-01 10:00+00', '2099-02-01 10:30+00', 'Scheduled', $5)`,
    [fx.clinicId, fx.branchId, fx.doctorId, fx.patientPhone, `patient:${fx.patientPhone}`],
  );
  await assert.rejects(
    db.pool.query(
      `INSERT INTO appointment (clinic_id, branch_id, doctor_id, patient_phone, start_datetime, end_datetime, status, created_by)
       VALUES ($1, $2, $3, '+15559999000', '2099-02-01 10:00+00', '2099-02-01 10:30+00', 'Scheduled', 'patient:+15559999000')`,
      [fx.clinicId, fx.branchId, fx.doctorId],
    ),
    (err: NodeJS.ErrnoException) => err.code === '23P01',
    'SQLSTATE must be 23P01 (exclusion_violation)',
  );
});

test('AC-3: two Scheduled same patient+doctor → per-doctor uniqueness violation', async () => {
  const fx = await makeFixture(db, 'A3');
  await db.pool.query(
    `INSERT INTO appointment (clinic_id, branch_id, doctor_id, patient_phone, start_datetime, end_datetime, status, created_by)
     VALUES ($1, $2, $3, $4, '2099-02-02 10:00+00', '2099-02-02 10:30+00', 'Scheduled', $5)`,
    [fx.clinicId, fx.branchId, fx.doctorId, fx.patientPhone, `patient:${fx.patientPhone}`],
  );
  await assert.rejects(
    db.pool.query(
      `INSERT INTO appointment (clinic_id, branch_id, doctor_id, patient_phone, start_datetime, end_datetime, status, created_by)
       VALUES ($1, $2, $3, $4, '2099-02-03 10:00+00', '2099-02-03 10:30+00', 'Scheduled', $5)`,
      [fx.clinicId, fx.branchId, fx.doctorId, fx.patientPhone, `patient:${fx.patientPhone}`],
    ),
    (err: NodeJS.ErrnoException) => err.code === '23505',
    'SQLSTATE must be 23505 (unique_violation)',
  );
});

test('AC-4: same patient, two different doctors, both Scheduled → both succeed', async () => {
  const fx = await makeFixture(db, 'A4');
  const r1 = await db.pool.query(
    `INSERT INTO appointment (clinic_id, branch_id, doctor_id, patient_phone, start_datetime, end_datetime, status, created_by)
     VALUES ($1, $2, $3, $4, '2099-02-04 10:00+00', '2099-02-04 10:30+00', 'Scheduled', $5)`,
    [fx.clinicId, fx.branchId, fx.doctorId, fx.patientPhone, `patient:${fx.patientPhone}`],
  );
  const r2 = await db.pool.query(
    `INSERT INTO appointment (clinic_id, branch_id, doctor_id, patient_phone, start_datetime, end_datetime, status, created_by)
     VALUES ($1, $2, $3, $4, '2099-02-04 11:00+00', '2099-02-04 11:30+00', 'Scheduled', $5)`,
    [fx.clinicId, fx.branchId, fx.doctor2Id, fx.patientPhone, `patient:${fx.patientPhone}`],
  );
  assert.equal(r1.rowCount, 1);
  assert.equal(r2.rowCount, 1, 'cross-doctor Scheduled must be allowed (FR-028)');
});

test('AC-5: cancelled appointment frees the slot for rebook', async () => {
  const fx = await makeFixture(db, 'A5');
  const cancelled = await db.pool.query<{ id: string }>(
    `INSERT INTO appointment (clinic_id, branch_id, doctor_id, patient_phone, start_datetime, end_datetime, status, created_by)
     VALUES ($1, $2, $3, $4, '2099-02-05 10:00+00', '2099-02-05 10:30+00', 'Scheduled', $5)
     RETURNING id`,
    [fx.clinicId, fx.branchId, fx.doctorId, fx.patientPhone, `patient:${fx.patientPhone}`],
  );
  await db.pool.query(
    `UPDATE appointment SET status = 'Cancelled' WHERE id = $1`,
    [cancelled.rows[0]!.id],
  );
  const rebook = await db.pool.query(
    `INSERT INTO appointment (clinic_id, branch_id, doctor_id, patient_phone, start_datetime, end_datetime, status, created_by)
     VALUES ($1, $2, $3, '+15559999111', '2099-02-05 10:00+00', '2099-02-05 10:30+00', 'Scheduled', 'patient:+15559999111')`,
    [fx.clinicId, fx.branchId, fx.doctorId],
  );
  assert.equal(rebook.rowCount, 1, 'rebook of Cancelled slot must succeed');
});

test('AC-6: two parallel SERIALIZABLE inserts for same slot — exactly one succeeds', async () => {
  const fx = await makeFixture(db, 'A6');
  // Both clients try to insert the same (doctor, branch, time window) under
  // SERIALIZABLE isolation. Exactly one must commit; the other must reject
  // with `40001` (serialization_failure) or `23P01` (exclusion_violation).
  // We use separate client connections from the pool so each runs in its own
  // transaction (a single pool client cannot run two simultaneous transactions).
  const insertSameSlot = async (phone: string) => {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await client.query(
        `INSERT INTO appointment (clinic_id, branch_id, doctor_id, patient_phone, start_datetime, end_datetime, status, created_by)
         VALUES ($1, $2, $3, $4, '2099-02-09 10:00+00', '2099-02-09 10:30+00', 'Scheduled', $5)`,
        [fx.clinicId, fx.branchId, fx.doctorId, phone, `patient:${phone}`],
      );
      // Yield so both clients race for the constraint.
      await new Promise((r) => setImmediate(r));
      await client.query('COMMIT');
      return { ok: true as const };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      const code = (err as NodeJS.ErrnoException).code;
      return { ok: false as const, code };
    } finally {
      client.release();
    }
  };

  const [r1, r2] = await Promise.all([
    insertSameSlot('+15559999666'),
    insertSameSlot('+15559999777'),
  ]);
  const successes = [r1, r2].filter((r) => r.ok).length;
  const failures = [r1, r2].filter((r) => !r.ok);
  assert.equal(
    successes,
    1,
    `exactly one of the two concurrent inserts must succeed; got ${successes}`,
  );
  assert.equal(failures.length, 1, 'exactly one insert must fail');
  assert.ok(
    failures[0]!.code === '40001' || failures[0]!.code === '23P01',
    `loser must reject with 40001 (serialization_failure) or 23P01 (exclusion_violation); got ${failures[0]!.code}`,
  );
});

test('P19: receptionist_email_key UNIQUE rejects duplicate email (case-insensitive)', async () => {
  const fx = await makeFixture(db, 'P19-rec');
  // First insert succeeds.
  await db.pool.query(
    `INSERT INTO receptionist (branch_id, full_name, email)
     VALUES ($1, 'Rec One', 'rec-p19-1@clinic.local')`,
    [fx.branchId],
  );
  // Second insert with a case-varied email must reject — the column is `citext`
  // so 'REC-P19-1@clinic.local' is byte-distinct but citext-equal.
  await assert.rejects(
    db.pool.query(
      `INSERT INTO receptionist (branch_id, full_name, email)
       VALUES ($1, 'Rec Two', 'REC-P19-1@clinic.local')`,
      [fx.branchId],
    ),
    (err: NodeJS.ErrnoException) => err.code === '23505',
    'SQLSTATE must be 23505 (unique_violation) on duplicate citext email',
  );
});

test('P19: admin_user_email_key UNIQUE rejects duplicate email (case-insensitive)', async () => {
  // Post-migration 0013 (E1-S0a), admin_user.clinic_id is NOT NULL with
  // a FK to clinic(id). The test uses the singleton clinic id from
  // makeFixture's shared row; the SELECT-then-INSERT pattern in
  // makeFixture keeps this stable across re-runs.
  const fx = await makeFixture(db, 'P19-adm');
  await db.pool.query(
    `INSERT INTO admin_user (full_name, email, clinic_id) VALUES ('Adm One', 'adm-p19-1@clinic.local', $1)`,
    [fx.clinicId],
  );
  await assert.rejects(
    db.pool.query(
      `INSERT INTO admin_user (full_name, email, clinic_id) VALUES ('Adm Two', 'ADM-P19-1@clinic.local', $1)`,
      [fx.clinicId],
    ),
    (err: NodeJS.ErrnoException) => err.code === '23505',
    'SQLSTATE must be 23505 (unique_violation) on duplicate citext email',
  );
});

test('AC-10: created_by bad prefix → CHECK violation', async () => {
  const fx = await makeFixture(db, 'A10');
  await assert.rejects(
    db.pool.query(
      `INSERT INTO appointment (clinic_id, branch_id, doctor_id, patient_phone, start_datetime, end_datetime, status, created_by)
       VALUES ($1, $2, $3, '+15559999222', '2099-02-06 10:00+00', '2099-02-06 10:30+00', 'Scheduled', 'foo:bar')`,
      [fx.clinicId, fx.branchId, fx.doctorId],
    ),
    /violates check constraint/i,
  );
});

test('AC-11: created_by NULL → NOT NULL violation', async () => {
  const fx = await makeFixture(db, 'A11');
  await assert.rejects(
    db.pool.query(
      `INSERT INTO appointment (clinic_id, branch_id, doctor_id, patient_phone, start_datetime, end_datetime, status, created_by)
       VALUES ($1, $2, $3, '+15559999333', '2099-02-07 10:00+00', '2099-02-07 10:30+00', 'Scheduled', NULL)`,
      [fx.clinicId, fx.branchId, fx.doctorId],
    ),
    /null value in column "created_by"/i,
  );
});

test('AC-12: status outside enum → enum violation', async () => {
  const fx = await makeFixture(db, 'A12');
  await assert.rejects(
    db.pool.query(
      `INSERT INTO appointment (clinic_id, branch_id, doctor_id, patient_phone, start_datetime, end_datetime, status, created_by)
       VALUES ($1, $2, $3, '+15559999444', '2099-02-08 10:00+00', '2099-02-08 10:30+00', 'Rescheduled', 'patient:+15559999444')`,
      [fx.clinicId, fx.branchId, fx.doctorId],
    ),
    (err: NodeJS.ErrnoException) => err.code === '22P02',
    'SQLSTATE must be 22P02 (invalid_text_representation) for enum violation',
  );
});

test('AC-13: UPDATE on appointment_audit → trigger raises', async () => {
  await db.pool.query(
    `INSERT INTO appointment_audit (actor_role, actor_id, event, payload)
     VALUES ('system', 'test', 'test_event', '{}'::jsonb)`,
  );
  await assert.rejects(
    db.pool.query(`UPDATE appointment_audit SET event = 'tampered' WHERE event = 'test_event'`),
    /appointment_audit_is_append_only/,
  );
});

test('AC-14: DELETE on appointment_audit → trigger raises', async () => {
  await assert.rejects(
    db.pool.query(`DELETE FROM appointment_audit WHERE event = 'test_event'`),
    /appointment_audit_is_append_only/,
  );
});

test('AC-7: updated_at trigger fires on UPDATE', async () => {
  const fx = await makeFixture(db, 'A7');
  const before = await db.pool.query<{ updated_at: Date }>(
    `UPDATE clinic SET name = 'Updated ' || gen_random_uuid()::text
     WHERE id = $1 RETURNING updated_at`,
    [fx.clinicId],
  );
  // Sleep 50ms then update again to guarantee clock granularity.
  await new Promise((r) => setTimeout(r, 50));
  const after = await db.pool.query<{ updated_at: Date }>(
    `UPDATE clinic SET name = 'Updated2 ' || gen_random_uuid()::text
     WHERE id = $1 RETURNING updated_at`,
    [fx.clinicId],
  );
  const beforeTs = new Date(before.rows[0]!.updated_at).getTime();
  const afterTs = new Date(after.rows[0]!.updated_at).getTime();
  assert.ok(
    afterTs > beforeTs,
    `updated_at must advance on UPDATE; before=${beforeTs} after=${afterTs}`,
  );
});

// Spec AC-7 / P18: every mutable entity must have trg_<table>_set_updated_at
// attached. Asserting membership in pg_trigger pins the contract for all 11
// tables so a future refactor that drops a trigger on any non-clinic table
// fails this test loudly.
const TRIGGERED_TABLES = [
  'clinic',
  'branch',
  'doctor',
  'doctor_branch',
  'receptionist',
  'admin_user',
  'patient',
  'appointment_type',
  'doctor_schedule',
  'doctor_block',
  'appointment',
] as const;

test('P18: every mutable entity has trg_<table>_set_updated_at trigger attached', async () => {
  const expected = TRIGGERED_TABLES.map((t) => `trg_${t}_set_updated_at`).sort();
  const { rows } = await db.pool.query<{ tgname: string }>(
    `SELECT tgname FROM pg_trigger
     WHERE tgname LIKE 'trg_%_set_updated_at'
       AND NOT tgisinternal`,
  );
  const actual = rows.map((r) => r.tgname).sort();
  assert.deepEqual(
    actual,
    expected,
    `expected triggers [${expected.join(', ')}]; got [${actual.join(', ')}]`,
  );
});

test('AC-8: updated_at defaulted on INSERT equals created_at', async () => {
  // Post-migration 0013 (E1-S0a), `clinic` carries a partial unique
  // singleton index that rejects every second INSERT. The original
  // AC-8 test inserted a fresh clinic row to verify the
  // `updated_at = created_at` default at INSERT time; under the
  // singleton invariant that insert is now illegal. Verify the
  // same property at the schema layer instead: the column default
  // expression must be `app_now()` and the BEFORE UPDATE trigger
  // (already pinned by P18) is the only writer of `updated_at` post-
  // insert. Together these two assertions cover what AC-8 originally
  // tested: at INSERT time, `updated_at = created_at`, both populated
  // from the same `app_now()` call.
  const { rows } = await db.pool.query<{
    column_default: string | null;
  }>(
    `SELECT column_default
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'clinic'
       AND column_name = 'updated_at'`,
  );
  assert.equal(rows.length, 1, 'clinic.updated_at column must exist');
  const def = rows[0]!.column_default;
  assert.ok(
    def !== null,
    'clinic.updated_at must have a DEFAULT expression',
  );
  assert.match(
    def,
    /app_now\(\)/i,
    `clinic.updated_at default must be app_now(); got: ${def}`,
  );
  // created_at must also default to app_now() so the two columns are
  // populated from the same clock source at INSERT time.
  const { rows: createdRows } = await db.pool.query<{ column_default: string | null }>(
    `SELECT column_default
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'clinic'
       AND column_name = 'created_at'`,
  );
  assert.match(
    createdRows[0]!.column_default ?? '',
    /app_now\(\)|now\(\)/i,
    `clinic.created_at default must be app_now() or now(); got: ${createdRows[0]!.column_default ?? '<null>'}`,
  );
});
