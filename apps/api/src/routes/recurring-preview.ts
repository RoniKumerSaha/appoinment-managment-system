/**
 * Recurring preview — `POST /recurring/preview`.
 *
 * Per spec-6-1 (E6-S1) + PRD F-11 + BR-047…053 + FR-044…050:
 * A doctor or receptionist previews a recurring series (Weekly /
 * Every 2 weeks / Custom). The route is READ-ONLY: it validates
 * every occurrence in isolation and returns `{will_create,
 * skipped_with_reason}`. No state is mutated.
 *
 * Pipeline:
 *   1. Auth: claim.role ∈ {doctor, receptionist}. Patient / admin
 *      → 403 forbidden_role. Anonymous → 401.
 *   2. Body shape: validateRecurringBody (the same shape used by
 *      /recurring/confirm via the preview_id handle).
 *   3. Series-shape validation (single-shot):
 *      - doctor_id must equal claim.doctor_id (doctor scope;
 *        doubly-bound). Receptionist scope is branch-only — the
 *        body doctor_id must be a doctor at one of claim.branch_ids.
 *      - branch_id must be in claim.branch_ids (both roles).
 *      - patient_phone must exist in the patient table — 400
 *        patient_not_found if not.
 *   4. Occurrence expansion: derive the list of candidate
 *      (startMs, endMs, localDate) slots from the recurrence shape.
 *   5. Per-occurrence FR-046 validation in a single transaction.
 *      Each candidate is bucketed into `will_create` or
 *      `skipped_with_reason`. The validator runs the full
 *      E3-S1 / E3-S2 pipeline (branch hours, doctor schedule,
 *      blocks, existing overlaps, FR-027, FR-029) plus the
 *      30-day window (FR-018) and same-day exclusion (FR-019).
 *   6. The preview's snapshot (body + branch tz + occurrence list)
 *      is persisted server-side under a fresh uuid (`preview_id`).
 *      /recurring/confirm looks up the snapshot by id.
 *
 * Auth: claim.role ∈ {doctor, receptionist} only. Patient / admin
 * → 403 forbidden_role. Anonymous → 401.
 */
import { Router, type Request, type Response } from 'express';
import type { PoolClient } from 'pg';
import { getPool } from '../db/pool.js';
import { getLogger } from '../middleware/log.js';
import {
  validateRecurringBody,
  expandOccurrences,
  validateOccurrenceInTxn,
  savePreview,
  formatLocalDate,
  type RecurringValidationError,
  type SkipReason,
} from './recurring-helpers.js';

const VALIDATION_ERROR_MAP: Record<RecurringValidationError, string> = {
  unknown_field: 'unknown_field',
  invalid_doctor_id: 'invalid_doctor_id',
  invalid_branch_id: 'invalid_branch_id',
  invalid_appointment_type_id: 'invalid_appointment_type_id',
  invalid_patient_phone: 'invalid_patient_phone',
  invalid_patient_first_name: 'invalid_patient_first_name',
  invalid_recurrence_kind: 'invalid_recurrence_kind',
  invalid_recurrence_interval_days: 'invalid_recurrence_interval_days',
  invalid_start_date: 'invalid_start_date',
  invalid_time_of_day: 'invalid_time_of_day',
  invalid_duration_minutes: 'invalid_duration_minutes',
  invalid_occurrences_or_until_date: 'invalid_occurrences_or_until_date',
};

const SELECT_CLINIC_ID_SQL = `SELECT id FROM clinic LIMIT 1`;
const SELECT_BRANCH_SQL = `
  SELECT id::text AS id, tz, active FROM branch WHERE id = $1::uuid;
`;
const SELECT_DOCTOR_AT_BRANCH_SQL = `
  SELECT 1 FROM doctor_branch
   WHERE doctor_id = $1::uuid AND branch_id = $2::uuid
   LIMIT 1;
`;
const SELECT_PATIENT_BY_PHONE_SQL = `
  SELECT id::text AS id FROM patient WHERE phone_number = $1;
`;

export const recurringPreviewRouter: Router = Router();

recurringPreviewRouter.post(
  '/recurring/preview',
  async (req: Request, res: Response): Promise<void> => {
    const claim = req.auth?.claim ?? null;
    if (!claim) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    if (claim.role !== 'doctor' && claim.role !== 'receptionist') {
      // FR-045: no patient-initiated recurring booking.
      // Admin never touches individual appointments (PRD §2.4).
      res.status(403).json({ error: 'forbidden_role' });
      return;
    }

    const validated = validateRecurringBody(req.body);
    if (!validated.ok) {
      res.status(400).json({ error: VALIDATION_ERROR_MAP[validated.error] });
      return;
    }
    const body = validated.value;

    // Doctor scope: doubly-bound — doctor_id must equal claim.doctor_id
    // AND branch_id must be in claim.branch_ids. Receptionist scope:
    // branch-only (BR-004) — branch_id must be in claim.branch_ids.
    if (claim.role === 'doctor') {
      if (claim.doctor_id === undefined || claim.doctor_id !== body.doctor_id) {
        res.status(403).json({ error: 'outside_branch_scope' });
        return;
      }
    }
    if (!claim.branch_ids.includes(body.branch_id)) {
      res.status(403).json({ error: 'outside_branch_scope' });
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
        'recurring_preview_connect_failed',
      );
      throw err;
    }
    try {
      // Series-shape lookups (single round-trip per entity).
      const { rows: clinicRows } = await client.query<{ id: string }>(
        SELECT_CLINIC_ID_SQL,
      );
      if (clinicRows.length === 0) {
        res.status(500).json({ error: 'internal_error' });
        return;
      }
      const clinicId = clinicRows[0]!.id;

      const { rows: branchRows } = await client.query<{
        id: string;
        tz: string;
        active: boolean;
      }>(SELECT_BRANCH_SQL, [body.branch_id]);
      if (branchRows.length === 0) {
        res.status(404).json({ error: 'branch_not_found' });
        return;
      }
      const branch = branchRows[0]!;
      if (!branch.active) {
        res.status(400).json({ error: 'branch_inactive' });
        return;
      }

      // Doctor-at-branch check. For doctors this is implicit (the
      // body doctor_id matched claim.doctor_id and we already
      // checked the branch — defense in depth). For receptionists
      // we must verify the doctor is actually at this branch.
      const { rows: docBranchRows } = await client.query<{ exists: number }>(
        SELECT_DOCTOR_AT_BRANCH_SQL,
        [body.doctor_id, body.branch_id],
      );
      if (docBranchRows.length === 0) {
        res.status(400).json({ error: 'doctor_not_at_branch' });
        return;
      }

      // Patient row existence. The receptionist / doctor books on
      // behalf of a patient (F-13 / F-15); an unknown phone
      // returns 400 patient_not_found so the receptionist can use
      // the patient-profile route (E3-S3) to confirm the row first.
      const { rows: patRows } = await client.query<{ id: string }>(
        SELECT_PATIENT_BY_PHONE_SQL,
        [body.patient_phone],
      );
      if (patRows.length === 0) {
        res.status(400).json({ error: 'patient_not_found' });
        return;
      }

      // Occurrence expansion (pure) + per-occurrence FR-046 check.
      const occurrences = expandOccurrences(body, { branchTz: branch.tz });
      const todayLocal = formatLocalDate(new Date(nowMs), branch.tz);

      // Single transaction for the per-occurrence checks. No state
      // is mutated; the txn just gives a stable read snapshot.
      await client.query('BEGIN');

      const willCreate: Array<{
        index: number;
        start_datetime: string;
        end_datetime: string;
        local_date: string;
      }> = [];
      const skipped: Array<{
        index: number;
        start_datetime: string;
        end_datetime: string;
        local_date: string;
        reason: SkipReason;
      }> = [];

      for (const occ of occurrences) {
        const result = await validateOccurrenceInTxn(client, {
          clinicId,
          doctorId: body.doctor_id,
          branchId: body.branch_id,
          appointmentTypeId: body.appointment_type_id,
          patientPhone: body.patient_phone,
          startMs: occ.startMs,
          endMs: occ.endMs,
          submittedDuration: body.duration_minutes,
          branchLocalDate: occ.localDate,
          todayLocalDate: todayLocal,
        });
        const startIso = new Date(occ.startMs).toISOString();
        const endIso = new Date(occ.endMs).toISOString();
        if (result.ok) {
          willCreate.push({
            index: occ.index,
            start_datetime: startIso,
            end_datetime: endIso,
            local_date: occ.localDate,
          });
        } else {
          skipped.push({
            index: occ.index,
            start_datetime: startIso,
            end_datetime: endIso,
            local_date: occ.localDate,
            reason: result.reason,
          });
        }
      }

      await client.query('COMMIT');

      // Persist the preview snapshot. The confirm route looks it up
      // by id; the snapshot carries the body + branch tz + the
      // expanded occurrence list (re-validated at confirm time).
      const previewId = savePreview({
        body,
        branchTz: branch.tz,
        occurrences,
        createdAtMs: nowMs,
      });

      res.status(200).json({
        preview_id: previewId,
        branch: {
          id: branch.id,
          tz: branch.tz,
        },
        recurrence: {
          kind: body.recurrence_kind,
          interval_days: body.recurrence_interval_days,
          start_date: body.start_date,
          time_of_day: body.time_of_day,
          duration_minutes: body.duration_minutes,
        },
        will_create: willCreate,
        skipped_with_reason: skipped,
      });
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback failure
      }
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'recurring_preview_failed',
      );
      throw err;
    } finally {
      client.release();
    }
  },
);