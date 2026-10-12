/**
 * Staff doctor move — `POST /doctor/affected/:id/move`.
 *
 * Per spec-6-2 (E6-S2) + F-09 + BR-054…058 + FR-011:
 * A doctor moves an affected Scheduled appointment to a new
 * slot. This is a **doctor-initiated conflict move** — distinct
 * from the patient reschedule (E4-S3) and the receptionist cancel
 * (E5-S3). The doctor is the only actor that "moves" an
 * appointment.
 *
 * Move semantics:
 *   - The appointment type is LOCKED (BR-058) — the body schema
 *     never accepts `new_appointment_type_id`. The type is read
 *     from the source row.
 *   - The branch may change to any branch the doctor works at
 *     (BR-057) — the body's `new_branch_id` is consulted and
 *     must be in `claim.branch_ids` AND have a `doctor_branch`
 *     row for `claim.doctor_id`.
 *   - The doctor is server-trusted. The body's schema does NOT
 *     accept `new_doctor_id`; the doctor is `claim.doctor_id`.
 *     (The appointment row's `doctor_id` is updated to the same
 *     value — no-op semantically; the row stays bound to the
 *     doctor.)
 *   - The destination slot must pass the FR-046 pipeline (E6-S1
 *     helper): branch hours, doctor schedule, blocks, existing
 *     overlaps, FR-027, FR-029, FR-018 (30-day window), FR-019
 *     (same-day exclusion).
 *   - The old slot is released by the GIST exclusion (scoped on
 *     status='Scheduled'); the UPDATE moves the row's tstzrange
 *     to the new (start, end) atomically.
 *
 * Atomic + GIST-protected:
 *   - pool.connect() + BEGIN.
 *   - SELECT FOR UPDATE on the source appointment row.
 *   - Doctor scope gate (doubly-bound: doctor_id AND source
 *     branch_id must match claim).
 *   - Status gate: only Scheduled rows are movable. Terminal
 *     states → 422 already_in_terminal_state.
 *   - Time gate (FR-019 / FR-018): past rows → 422
 *     appointment_in_past.
 *   - Branch / doctor-at-branch check on the destination.
 *   - No-op detection: if the new (branch, start, end) tuple
 *     matches the source row exactly → 422 no_op_move. A real
 *     conflict resolution always changes SOMETHING.
 *   - In-txn FR-046 recheck on the destination slot.
 *   - UPDATE appointment SET branch_id, start_datetime,
 *     end_datetime. doctor_id and appointment_type_id are NOT
 *     changed.
 *   - INSERT appointment_audit (actor_role='doctor',
 *     actor_id='staff:<sub>', event='moved_by_doctor',
 *     payload={reason: 'conflict_resolution', from, to,
 *     branch_change, type_change}).
 *   - COMMIT.
 *
 * Auth: claim.role === 'doctor' only. Patient / admin /
 * receptionist → 403 forbidden_role. Anonymous → 401.
 */
import { Router, type Request, type Response } from 'express';
import type { PoolClient } from 'pg';
import { getPool } from '../db/pool.js';
import { getLogger } from '../middleware/log.js';
import {
  isValidUuid,
  isValidIsoDateTime,
} from './bookings-helpers.js';
import { validateOccurrenceInTxn, formatLocalDate, type SkipReason } from './recurring-helpers.js';

const ALLOWED_POST_KEYS = new Set([
  'new_branch_id',
  'new_start_datetime',
  'new_end_datetime',
]);

const SELECT_APPOINTMENT_FOR_UPDATE_SQL = `
  SELECT id::text AS id, patient_phone, status, branch_id::text AS branch_id,
         doctor_id::text AS doctor_id, appointment_type_id::text AS appointment_type_id,
         start_datetime, end_datetime
    FROM appointment
   WHERE id = $1::uuid
     FOR UPDATE;
`;

const SELECT_CLINIC_ID_SQL = `SELECT id FROM clinic LIMIT 1`;

const SELECT_DOCTOR_AT_BRANCH_SQL = `
  SELECT 1 FROM doctor_branch
   WHERE doctor_id = $1::uuid AND branch_id = $2::uuid
   LIMIT 1;
`;

const SELECT_BRANCH_SQL = `
  SELECT id::text AS id, tz, active FROM branch WHERE id = $1::uuid;
`;

const UPDATE_APPOINTMENT_SQL = `
  UPDATE appointment
     SET branch_id = $2::uuid,
         start_datetime = $3::timestamptz,
         end_datetime = $4::timestamptz
   WHERE id = $1::uuid
   RETURNING id::text AS id, branch_id::text AS branch_id,
             doctor_id::text AS doctor_id,
             appointment_type_id::text AS appointment_type_id,
             start_datetime, end_datetime, status;
`;

const INSERT_AUDIT_SQL = `
  INSERT INTO appointment_audit
    (appointment_id, actor_role, actor_id, event, payload)
  VALUES ($1::uuid, 'doctor', $2, 'moved_by_doctor', $3::jsonb);
`;

interface AppointmentRow {
  id: string;
  patient_phone: string;
  status: string;
  branch_id: string;
  doctor_id: string;
  appointment_type_id: string;
  start_datetime: Date;
  end_datetime: Date;
}

export const staffDoctorMoveRouter: Router = Router();

staffDoctorMoveRouter.post(
  '/doctor/affected/:id/move',
  async (req: Request, res: Response): Promise<void> => {
    const claim = req.auth?.claim ?? null;
    if (!claim) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    if (claim.role !== 'doctor') {
      // E4-S3 handles patient reschedule; E5-S3 handles
      // receptionist cancel. Admin never touches individual
      // appointments (PRD §2.4).
      res.status(403).json({ error: 'forbidden_role' });
      return;
    }
    if (claim.doctor_id === undefined) {
      res.status(403).json({ error: 'outside_branch_scope' });
      return;
    }
    const idRaw = req.params['id'];
    const id = typeof idRaw === 'string' ? idRaw : '';
    if (!isValidUuid(id)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    // Body shape: { new_branch_id, new_start_datetime, new_end_datetime }.
    // BR-058: never accept new_appointment_type_id. FR-040: never
    // accept new_doctor_id. Both fall through the unknown_field check.
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({ error: 'unknown_field' });
      return;
    }
    const b = body as Record<string, unknown>;
    for (const k of Object.keys(b)) {
      if (!ALLOWED_POST_KEYS.has(k)) {
        res.status(400).json({ error: 'unknown_field' });
        return;
      }
    }
    if (typeof b['new_branch_id'] !== 'string' || !isValidUuid(b['new_branch_id'])) {
      res.status(400).json({ error: 'invalid_branch_id' });
      return;
    }
    if (
      typeof b['new_start_datetime'] !== 'string' ||
      isValidIsoDateTime(b['new_start_datetime']) === null
    ) {
      res.status(400).json({ error: 'invalid_start_datetime' });
      return;
    }
    if (
      typeof b['new_end_datetime'] !== 'string' ||
      isValidIsoDateTime(b['new_end_datetime']) === null
    ) {
      res.status(400).json({ error: 'invalid_end_datetime' });
      return;
    }
    const newBranchId = b['new_branch_id'] as string;
    const startMs = Date.parse(b['new_start_datetime'] as string);
    const endMs = Date.parse(b['new_end_datetime'] as string);
    if (
      !Number.isFinite(startMs) ||
      !Number.isFinite(endMs) ||
      endMs <= startMs
    ) {
      res.status(400).json({ error: 'invalid_time_range' });
      return;
    }

    const nowMs = Date.now();
    const pool = await getPool();
    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'staff_doctor_move_connect_failed',
      );
      throw err;
    }
    try {
      await client.query('BEGIN');

      // 1. Lock the source row.
      const { rows } = await client.query<AppointmentRow>(
        SELECT_APPOINTMENT_FOR_UPDATE_SQL,
        [id],
      );
      if (rows.length === 0) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const appt = rows[0]!;

      // 2. Doctor scope gate (doubly-bound on the SOURCE row).
      const doctorMatch = appt.doctor_id === claim.doctor_id;
      const sourceBranchMatch = claim.branch_ids.includes(appt.branch_id);
      if (!doctorMatch || !sourceBranchMatch) {
        await client.query('ROLLBACK');
        res.status(403).json({ error: 'outside_branch_scope' });
        return;
      }

      // 3. Status gate.
      if (appt.status !== 'Scheduled') {
        await client.query('ROLLBACK');
        res.status(422).json({ error: 'already_in_terminal_state' });
        return;
      }

      // 4. Time gate (FR-019 / FR-018 — the source must be a future
      //    Scheduled row; past rows are not movable).
      if (appt.start_datetime.getTime() <= nowMs) {
        await client.query('ROLLBACK');
        res.status(422).json({ error: 'appointment_in_past' });
        return;
      }

      // 5. No-op detection. A real conflict resolution always
      //    changes SOMETHING. If the new (branch, start, end)
      //    matches the source row, surface 422 no_op_move so the
      //    client doesn't accidentally write a redundant audit row.
      const sameBranch = appt.branch_id === newBranchId;
      const sameStart = appt.start_datetime.getTime() === startMs;
      const sameEnd = appt.end_datetime.getTime() === endMs;
      if (sameBranch && sameStart && sameEnd) {
        await client.query('ROLLBACK');
        res.status(422).json({ error: 'no_op_move' });
        return;
      }

      // 6. Destination branch scope gate (BR-057).
      if (!claim.branch_ids.includes(newBranchId)) {
        await client.query('ROLLBACK');
        res.status(403).json({ error: 'outside_branch_scope' });
        return;
      }
      const { rows: branchRows } = await client.query<{
        id: string;
        tz: string;
        active: boolean;
      }>(SELECT_BRANCH_SQL, [newBranchId]);
      if (branchRows.length === 0) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'branch_not_found' });
        return;
      }
      const newBranch = branchRows[0]!;
      if (!newBranch.active) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: 'branch_inactive' });
        return;
      }

      // 7. Doctor-at-branch check on the destination.
      const { rows: docBranchRows } = await client.query<{ exists: number }>(
        SELECT_DOCTOR_AT_BRANCH_SQL,
        [claim.doctor_id, newBranchId],
      );
      if (docBranchRows.length === 0) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: 'doctor_not_at_branch' });
        return;
      }

      const { rows: clinicRows } = await client.query<{ id: string }>(
        SELECT_CLINIC_ID_SQL,
      );
      if (clinicRows.length === 0) {
        await client.query('ROLLBACK');
        throw new Error('clinic_row_missing');
      }
      const clinicId = clinicRows[0]!.id;

      // 8. Duration check — the new (end - start) must equal the
      //    existing row's (end - start). The type is locked (BR-058),
      //    so the duration is read from the source row.
      const sourceDurationMs = appt.end_datetime.getTime() - appt.start_datetime.getTime();
      if (endMs - startMs !== sourceDurationMs) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: 'duration_mismatch' });
        return;
      }

      // 9. In-txn FR-046 recheck on the destination slot. The
      //    appointment_type_id is taken from the source row.
      //    Exclude the moving row from FR-027/FR-029 so it does
      //    not count itself as its own sibling (otherwise the
      //    only-future-with-this-doctor case always 409s).
      const branchLocalDate = formatLocalDate(new Date(startMs), newBranch.tz);
      const todayLocal = formatLocalDate(new Date(nowMs), newBranch.tz);
      const recheck = await validateOccurrenceInTxn(client, {
        clinicId,
        doctorId: claim.doctor_id,
        branchId: newBranchId,
        appointmentTypeId: appt.appointment_type_id,
        patientPhone: appt.patient_phone,
        startMs,
        endMs,
        submittedDuration: Math.round(sourceDurationMs / 60_000),
        branchLocalDate,
        todayLocalDate: todayLocal,
        excludeAppointmentId: appt.id,
        // E7-S6 partial: thread the destination branch's tz so
        // the validator compares the new slot against the
        // branch's local working window in branch-local time
        // (e.g. 14:00 ET on East Branch fits 09:00-17:00 ET).
        branchTz: newBranch.tz,
      });
      if (!recheck.ok) {
        await client.query('ROLLBACK');
        res.status(409).json({ error: recheck.reason });
        return;
      }

      // 10. UPDATE the appointment row. The GIST exclusion is the
      //     race-safety net — SQLSTATE 23P01 → 409 slot_raced.
      //     On any failure the txn rolls back; the source row is
      //     untouched (FR-043 atomicity).
      let updatedRow: {
        id: string;
        branch_id: string;
        doctor_id: string;
        appointment_type_id: string;
        start_datetime: Date;
        end_datetime: Date;
        status: string;
      };
      try {
        const result = await client.query(UPDATE_APPOINTMENT_SQL, [
          appt.id,
          newBranchId,
          new Date(startMs).toISOString(),
          new Date(endMs).toISOString(),
        ]);
        updatedRow = result.rows[0]!;
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === '23P01' || code === '23505') {
          await client.query('ROLLBACK');
          res.status(409).json({ error: 'slot_raced' });
          return;
        }
        throw err;
      }

      // 11. Audit row. F-09: action='moved_by_doctor', metadata
      //     includes reason='conflict_resolution' so E7-S2 can
      //     surface the audit drawer.
      const branchChange = appt.branch_id !== newBranchId;
      // BR-058: type is locked. type_change is always false on
      // this route (the body schema never accepts a type change).
      const typeChange = false;
      const auditPayload = JSON.stringify({
        reason: 'conflict_resolution',
        from: {
          branch_id: appt.branch_id,
          start_datetime: appt.start_datetime.toISOString(),
          end_datetime: appt.end_datetime.toISOString(),
        },
        to: {
          branch_id: newBranchId,
          start_datetime: new Date(startMs).toISOString(),
          end_datetime: new Date(endMs).toISOString(),
        },
        branch_change: branchChange,
        type_change: typeChange,
      });
      await client.query(INSERT_AUDIT_SQL, [
        appt.id,
        `staff:${claim.sub}`,
        auditPayload,
      ]);

      await client.query('COMMIT');

      res.status(200).json({
        appointment: {
          id: updatedRow.id,
          branch_id: updatedRow.branch_id,
          doctor_id: updatedRow.doctor_id,
          appointment_type_id: updatedRow.appointment_type_id,
          start_datetime: updatedRow.start_datetime.toISOString(),
          end_datetime: updatedRow.end_datetime.toISOString(),
          status: updatedRow.status,
        },
      });
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback failure
      }
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'staff_doctor_move_failed',
      );
      throw err;
    } finally {
      client.release();
    }
  },
);

// Re-exported for the test suite.
export type { SkipReason };