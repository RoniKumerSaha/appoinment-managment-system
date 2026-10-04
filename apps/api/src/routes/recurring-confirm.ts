/**
 * Recurring confirm — `POST /recurring/confirm`.
 *
 * Per spec-6-1 (E6-S1) + PRD F-11 + BR-047…053 + FR-044…050:
 * On confirm, valid occurrences are created atomically as
 * `Scheduled`; one audit row per created occurrence. Per-occurrence
 * independence (BR-052, FR-049) means each created row is an
 * independent appointment thereafter.
 *
 * Pipeline:
 *   1. Auth: claim.role ∈ {doctor, receptionist}. Patient / admin
 *      → 403 forbidden_role. Anonymous → 401.
 *   2. Body: `{preview_id}`. Unknown / expired → 404
 *      preview_not_found. The preview is server-stateful.
 *   3. Scope: same role-scope rules as the preview. The
 *      `claim.branch_ids` must still include the snapshot's branch,
 *      and (for doctors) `claim.doctor_id` must still match the
 *      snapshot's doctor.
 *   4. Atomic batch: BEGIN → SELECT FOR UPDATE on all conflicting
 *      existing Scheduled rows at (doctor, branch) that overlap
 *      ANY candidate occurrence. For each candidate occurrence, in
 *      order: re-run the FR-046 pipeline (race-safety net) →
 *      INSERT the appointment row with `recurring_series_id` →
 *      INSERT the audit row with `event='recurring_created'` and
 *      `payload={series_id, recurrence_kind,
 *      recurrence_interval_days, occurrence_index}`. COMMIT.
 *   5. On any race (a slot that was free at preview became taken
 *      between preview and confirm), the row is skipped; the
 *      partial-success semantics from preview hold (FR-047).
 *   6. On a DB-level error (e.g. GIST exclusion), the entire batch
 *      rolls back (BR-052 — "all or nothing" for the per-occurrence
 *      row insert; per-occurrence validation may skip rows, but
 *      the batch is atomic).
 *
 * The series_id is a fresh uuid generated server-side per confirm.
 * All occurrences of a single confirm share the same value.
 *
 * Auth: claim.role ∈ {doctor, receptionist} only. Patient / admin
 * → 403 forbidden_role. Anonymous → 401.
 */
import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../db/pool.js';
import { getLogger } from '../middleware/log.js';
import {
  validateOccurrenceInTxn,
  getPreview,
  formatLocalDate,
  type SkipReason,
} from './recurring-helpers.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SELECT_CLINIC_ID_SQL = `SELECT id FROM clinic LIMIT 1`;

// Lock the existing rows that could conflict with any candidate
// occurrence. Without the lock a parallel /bookings or /recurring
// could insert a conflicting Scheduled row between our SELECT and
// our INSERT. The GIST exclusion is the second line of defense
// (raising SQLSTATE 23P01 on overlap), but the lock makes the
// race-safety observable in the response (skipped, not failed).
const SELECT_FOR_UPDATE_OVERLAPS_SQL = `
  SELECT id::text AS id
    FROM appointment
   WHERE doctor_id = $1::uuid AND branch_id = $2::uuid
     AND status = 'Scheduled'
     AND tstzrange(start_datetime, end_datetime, '[)') &&
         ANY ($3::tstzrange[])
   FOR UPDATE;
`;

const INSERT_APPOINTMENT_SQL = `
  INSERT INTO appointment
    (clinic_id, branch_id, doctor_id, patient_phone, appointment_type_id,
     start_datetime, end_datetime, status, recurring_series_id, created_by)
  VALUES
    ($1, $2, $3, $4, $5,
     $6::timestamptz, $7::timestamptz, 'Scheduled', $8::uuid, $9)
  RETURNING id::text AS id, recurring_series_id::text AS recurring_series_id;
`;

const INSERT_AUDIT_SQL = `
  INSERT INTO appointment_audit
    (appointment_id, actor_role, actor_id, event, payload)
  VALUES ($1::uuid, $2, $3, $4, $5::jsonb);
`;

export const recurringConfirmRouter: Router = Router();

recurringConfirmRouter.post(
  '/recurring/confirm',
  async (req: Request, res: Response): Promise<void> => {
    const claim = req.auth?.claim ?? null;
    if (!claim) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    if (claim.role !== 'doctor' && claim.role !== 'receptionist') {
      res.status(403).json({ error: 'forbidden_role' });
      return;
    }

    // Body: { preview_id }. 404 fallthrough if the id isn't a uuid
    // (don't reveal whether the path itself is valid).
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({ error: 'invalid_preview_id' });
      return;
    }
    const b = body as Record<string, unknown>;
    if (typeof b['preview_id'] !== 'string' || !UUID_RE.test(b['preview_id'])) {
      res.status(404).json({ error: 'preview_not_found' });
      return;
    }
    const previewId = b['preview_id'] as string;

    const snapshot = getPreview(previewId);
    if (snapshot === null) {
      res.status(404).json({ error: 'preview_not_found' });
      return;
    }

    // Scope re-check at confirm time. The JWT may have rotated,
    // or the user may have been downgraded — we re-validate the
    // claim against the snapshot's doctor + branch.
    if (claim.role === 'doctor') {
      if (claim.doctor_id === undefined || claim.doctor_id !== snapshot.body.doctor_id) {
        res.status(403).json({ error: 'outside_branch_scope' });
        return;
      }
    }
    if (!claim.branch_ids.includes(snapshot.body.branch_id)) {
      res.status(403).json({ error: 'outside_branch_scope' });
      return;
    }

    const seriesId = randomUUID();
    const nowMs = Date.now();
    const actorSub = claim.sub;
    const isReceptionist = claim.role === 'receptionist';
    const createdBy = isReceptionist
      ? `staff:${actorSub}`
      : `patient:${snapshot.body.patient_phone}`;

    const pool = await getPool();
    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'recurring_confirm_connect_failed',
      );
      throw err;
    }
    try {
      const { rows: clinicRows } = await client.query<{ id: string }>(
        SELECT_CLINIC_ID_SQL,
      );
      if (clinicRows.length === 0) {
        res.status(500).json({ error: 'internal_error' });
        return;
      }
      const clinicId = clinicRows[0]!.id;

      await client.query('BEGIN');

      // Pre-lock: SELECT FOR UPDATE on all Scheduled rows at
      // (doctor, branch) that overlap any candidate occurrence.
      // The lock holds until COMMIT, so any parallel /bookings or
      // /recurring that wants to insert a conflicting row blocks
      // here. Combined with the in-txn re-validation below, this
      // gives a deterministic partial-success envelope.
      const candidateRanges = snapshot.occurrences.map(
        (o) => `tstzrange('${new Date(o.startMs).toISOString()}'::timestamptz, '${new Date(o.endMs).toISOString()}'::timestamptz, '[)')`,
      );
      const rangesSql = `{${candidateRanges.join(',')}}`;
      const { rows: lockedRows } = await client.query<{ id: string }>(
        SELECT_FOR_UPDATE_OVERLAPS_SQL,
        [snapshot.body.doctor_id, snapshot.body.branch_id, rangesSql],
      );
      void lockedRows;

      // Per-occurrence re-validation + INSERT + audit. The
      // re-validation runs INSIDE the txn so a parallel winner
      // that took a slot between preview and confirm is detected
      // here and the row is skipped (FR-050 race-safety).
      const todayLocal = formatLocalDate(new Date(nowMs), snapshot.branchTz);
      const created: Array<{
        id: string;
        occurrence_index: number;
        start_datetime: string;
        end_datetime: string;
        local_date: string;
      }> = [];
      const skipped: Array<{
        occurrence_index: number;
        start_datetime: string;
        end_datetime: string;
        local_date: string;
        reason: SkipReason;
      }> = [];

      for (const occ of snapshot.occurrences) {
        const recheck = await validateOccurrenceInTxn(client, {
          clinicId,
          doctorId: snapshot.body.doctor_id,
          branchId: snapshot.body.branch_id,
          appointmentTypeId: snapshot.body.appointment_type_id,
          patientPhone: snapshot.body.patient_phone,
          startMs: occ.startMs,
          endMs: occ.endMs,
          submittedDuration: snapshot.body.duration_minutes,
          branchLocalDate: occ.localDate,
          todayLocalDate: todayLocal,
        });
        if (!recheck.ok) {
          skipped.push({
            occurrence_index: occ.index,
            start_datetime: new Date(occ.startMs).toISOString(),
            end_datetime: new Date(occ.endMs).toISOString(),
            local_date: occ.localDate,
            reason: recheck.reason,
          });
          continue;
        }

        let insertedId: string;
        try {
          const result = await client.query<{
            id: string;
            recurring_series_id: string;
          }>(INSERT_APPOINTMENT_SQL, [
            clinicId,
            snapshot.body.branch_id,
            snapshot.body.doctor_id,
            snapshot.body.patient_phone,
            snapshot.body.appointment_type_id,
            new Date(occ.startMs).toISOString(),
            new Date(occ.endMs).toISOString(),
            seriesId,
            createdBy,
          ]);
          insertedId = result.rows[0]!.id;
        } catch (err) {
          const code = (err as { code?: string }).code;
          if (code === '23P01' || code === '23505') {
            // GIST exclusion (23P01) or partial unique on
            // (patient, doctor) Scheduled (23505) — race-safety
            // caught a parallel winner.
            skipped.push({
              occurrence_index: occ.index,
              start_datetime: new Date(occ.startMs).toISOString(),
              end_datetime: new Date(occ.endMs).toISOString(),
              local_date: occ.localDate,
              reason: 'slot_raced',
            });
            continue;
          }
          // Any other error is a hard failure — the entire batch
          // rolls back (BR-052 — "all or nothing" for the insert;
          // per-occurrence validation may skip, but the batch is
          // atomic).
          throw err;
        }

        // One audit row per created occurrence. F-11: payload
        // carries {series_id, recurrence_kind,
        // recurrence_interval_days, occurrence_index}.
        const auditPayload = JSON.stringify({
          series_id: seriesId,
          recurrence_kind: snapshot.body.recurrence_kind,
          recurrence_interval_days: snapshot.body.recurrence_interval_days,
          occurrence_index: occ.index,
        });
        await client.query(INSERT_AUDIT_SQL, [
          insertedId,
          isReceptionist ? 'receptionist' : 'doctor',
          createdBy,
          'recurring_created',
          auditPayload,
        ]);

        created.push({
          id: insertedId,
          occurrence_index: occ.index,
          start_datetime: new Date(occ.startMs).toISOString(),
          end_datetime: new Date(occ.endMs).toISOString(),
          local_date: occ.localDate,
        });
      }

      await client.query('COMMIT');

      res.status(201).json({
        series_id: seriesId,
        created,
        skipped,
      });
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback failure
      }
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'recurring_confirm_failed',
      );
      throw err;
    } finally {
      client.release();
    }
  },
);