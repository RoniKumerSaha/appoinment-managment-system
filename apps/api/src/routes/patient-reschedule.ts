/**
 * Patient self-service reschedule — `POST /patient/appointments/:id/reschedule`.
 *
 * Per spec-4-3 (E4-S3) + F-05 + BR-041…045 / FR-039…043, the verified
 * patient reschedules their own Scheduled appointment. The doctor is
 * locked (FR-040, BR-042 — the body schema never accepts a
 * `new_doctor_id`); the branch, appointment type, date, and time may
 * all change (FR-041).
 *
 * Atomic two-slot transaction (architecture §3.4 + FR-042):
 *   - BEGIN.
 *   - SELECT FOR UPDATE the existing appointment row. Verify row
 *     exists, `patient_phone = claim.sub`, and `status = 'Scheduled'`.
 *   - Slot re-check inside the txn for the new (branch_id,
 *     appointment_type_id, start_datetime, end_datetime) using the
 *     same E3-S1 pipeline as POST /bookings: branch hours, doctor
 *     schedule, doctor blocks, existing (doctor, branch) overlaps,
 *     FR-027 same-doctor future (excluding the current row), FR-029
 *     patient time-overlap.
 *   - UPDATE the appointment row with the new (branch_id,
 *     appointment_type_id, start_datetime, end_datetime). The 0008
 *     GIST exclusion constraint scoped on status='Scheduled' is the
 *     race-safety net — SQLSTATE 23P01 → 409 slot_raced.
 *   - INSERT appointment_audit (actor_role='patient',
 *     actor_id='patient:<phone>', event='rescheduled',
 *     payload={from, to, branch_change, type_change} per F-05).
 *   - COMMIT.
 *
 * Failure semantics (FR-043, Scenario 9): any failure during the
 * in-txn re-check or the UPDATE causes a ROLLBACK. The original
 * appointment row's branch_id / appointment_type_id / start_datetime
 * / end_datetime are unchanged. The patient sees
 * "That slot is no longer available. Your appointment is unchanged."
 *
 * Privacy (E7-S3): the existing appointment must match `claim.sub`.
 * Any other outcome (not found, wrong owner, wrong status) returns
 * 404 — NEVER 403 — so a patient cannot enumerate other patients'
 * appointments by id. The response is identical for "doesn't exist"
 * and "exists but you don't own it": `404 not_found`. Terminal
 * states return `404 not_found_appointment_in_terminal_state`.
 *
 * Auth: claim.role='patient' only. Doctor / admin / receptionist
 * have their own reschedule flows (E6-S2 / E6-S4).
 */
import { Router, type Request, type Response } from 'express';
import type { PoolClient } from 'pg';
import { getPool } from '../db/pool.js';
import { getLogger } from '../middleware/log.js';
import {
  isValidUuid,
  isValidIsoDateTime,
  isValidDurationMinutes,
  checkBookingWindow,
} from './bookings-helpers.js';
import {
  intersect,
  clampToDay,
} from '../availability/slots.js';
import {
  timeStringToMinutes,
  utcDayOfWeek,
} from '../availability/types.js';

const E164_PHONE_RE = /^\+[1-9]\d{6,14}$/;
const DURATION_MIN = 5;
const DURATION_MAX = 480;

// Allowed POST body keys (FR-040: `new_doctor_id` is NEVER accepted).
const ALLOWED_POST_KEYS = new Set([
  'new_branch_id',
  'new_appointment_type_id',
  'new_start_datetime',
  'new_end_datetime',
  'new_slot_duration_minutes',
  'new_patient_phone',
  'new_patient_name',
]);

const SELECT_APPOINTMENT_FOR_UPDATE_SQL = `
  SELECT id::text AS id, patient_phone, status, branch_id::text AS branch_id,
         doctor_id::text AS doctor_id, appointment_type_id::text AS appointment_type_id,
         start_datetime, end_datetime
    FROM appointment
   WHERE id = $1::uuid
     FOR UPDATE;
`;

// Doctor + branch + branch_hours + tz lookup. Mirrors the combined
// query in bookings.ts (P0-1 / P1-4 from E3-S2 review-loop-1).
const SELECT_DOCTOR_BRANCH_HOURS_SQL = `
  SELECT d.active AS doctor_active,
         b.tz, b.active AS branch_active,
         bw.open_time, bw.close_time, bw.is_closed
    FROM doctor d
    JOIN doctor_branch db ON db.doctor_id = d.id AND db.branch_id = $2
    JOIN branch b ON b.id = db.branch_id
    LEFT JOIN branch_weekly_hours bw
      ON bw.branch_id = b.id AND bw.day_of_week = $4
   WHERE d.id = $1 AND d.clinic_id = $3;
`;

const SELECT_DOCTOR_SQL = `
  SELECT id FROM doctor WHERE id = $1 AND clinic_id = $2;
`;

const SELECT_BRANCH_SQL = `
  SELECT id FROM branch WHERE id = $1 AND clinic_id = $2;
`;

const SELECT_APPOINTMENT_TYPE_SQL = `
  SELECT id, duration_minutes, is_active
    FROM appointment_type
   WHERE id = $1 AND clinic_id = $2;
`;

// Any Scheduled rows for this doctor + new branch overlapping the new
// slot's tstzrange. Excludes the current row (`$5 = appointment.id`)
// so the row we're moving doesn't collide with itself.
const SELECT_EXISTING_APPOINTMENTS_SQL = `
  SELECT 1 FROM appointment
   WHERE doctor_id = $1 AND branch_id = $2
     AND status = 'Scheduled'
     AND id <> $5::uuid
     AND tstzrange(start_datetime, end_datetime, '[)') &&
         tstzrange($3::timestamptz, $4::timestamptz, '[)')
   LIMIT 1;
`;

// Block rows for this doctor + new branch overlapping the new slot.
const SELECT_DOCTOR_BLOCKS_SQL = `
  SELECT 1 FROM doctor_block
   WHERE doctor_id = $1 AND branch_id = $2
     AND tstzrange(start_datetime, end_datetime, '[)') &&
         tstzrange($3::timestamptz, $4::timestamptz, '[)')
   LIMIT 1;
`;

// Doctor schedule rows for (doctor, new branch, DOW) effective on the new slot's date.
const SELECT_DOCTOR_SCHEDULE_SQL = `
  SELECT start_time, end_time
    FROM doctor_schedule
   WHERE doctor_id = $1 AND branch_id = $2
     AND day_of_week = $3
     AND effective_from <= ($4::date)
     AND (effective_to IS NULL OR effective_to >= ($4::date));
`;

// FR-027: any future Scheduled row for (patient, doctor) OTHER than the
// current row? The current row is itself a future Scheduled row for
// this patient+doctor — without the `id <> $3` exclusion the route
// would always reject its own reschedule.
const SELECT_PATIENT_DOCTOR_FUTURE_SQL = `
  SELECT 1 FROM appointment
   WHERE patient_phone = $1 AND doctor_id = $2
     AND status = 'Scheduled' AND start_datetime > now()
     AND id <> $3::uuid
   LIMIT 1;
`;

// FR-029: any Scheduled row for patient overlapping the new slot's
// tstzrange OTHER than the current row?
const SELECT_PATIENT_TIME_OVERLAP_SQL = `
  SELECT 1 FROM appointment
   WHERE patient_phone = $1
     AND status = 'Scheduled'
     AND id <> $4::uuid
     AND tstzrange(start_datetime, end_datetime, '[)') &&
         tstzrange($2::timestamptz, $3::timestamptz, '[)')
   LIMIT 1;
`;

const UPDATE_APPOINTMENT_SQL = `
  UPDATE appointment
     SET branch_id = $2::uuid,
         appointment_type_id = $3::uuid,
         start_datetime = $4::timestamptz,
         end_datetime = $5::timestamptz
   WHERE id = $1::uuid
   RETURNING id::text AS id, branch_id::text AS branch_id,
             doctor_id::text AS doctor_id,
             appointment_type_id::text AS appointment_type_id,
             start_datetime, end_datetime, status;
`;

const INSERT_AUDIT_SQL = `
  INSERT INTO appointment_audit
    (appointment_id, actor_role, actor_id, event, payload)
  VALUES ($1::uuid, $2, $3, $4, $5::jsonb);
`;

const SELECT_CLINIC_ID_SQL = `SELECT id FROM clinic LIMIT 1`;

// ConflictModal envelope for slot_raced. Same shape as E3-S2 / E4-S2.
const SLOT_RACED_ENVELOPE = {
  error: 'slot_raced',
  code: 'SLOT_RACED',
  what: 'That slot was just booked.',
  why: 'A concurrent booking completed first. Please refresh and pick another slot.',
  can_do: [
    { label: 'Refresh availability', action: 'refresh_availability' },
  ],
} as const;

export const patientRescheduleRouter: Router = Router();

type RecheckFailureCode =
  | 'doctor_inactive'
  | 'branch_inactive'
  | 'outside_branch_hours'
  | 'doctor_unavailable'
  | 'inside_doctor_block'
  | 'slot_raced'
  | 'patient_has_future_with_doctor'
  | 'patient_time_conflict';

type RecheckOutcome =
  | { ok: true }
  | { ok: false; code: RecheckFailureCode };

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

interface DoctorBranchRow {
  doctor_active: boolean;
  tz: string;
  branch_active: boolean;
  open_time: string | null;
  close_time: string | null;
  is_closed: boolean | null;
}

/** Run the in-txn slot re-check for the new (branch, doctor, type,
 *  start, end). Mirrors `recheckSlotInTxn` in bookings.ts but adds
 *  the `$5 = appointment.id` exclusion on the existing-appointments
 *  and patient-overlap queries so the row being moved doesn't
 *  collide with itself. SC2 documents the deliberate duplication. */
async function recheckNewSlotInTxn(
  client: PoolClient,
  args: {
    appointmentId: string;
    doctorId: string;
    branchId: string;
    startMs: number;
    endMs: number;
    patientPhone: string;
    branchHours: {
      open_time: string | null;
      close_time: string | null;
      is_closed: boolean | null;
    };
  },
): Promise<RecheckOutcome> {
  const startDate = new Date(args.startMs);
  const endDate = new Date(args.endMs);
  const dow = utcDayOfWeek(startDate);

  // 1. Branch-hours disambiguation (P0-3 fix from E3-S2 review-loop-1).
  const h = args.branchHours;
  if (h.is_closed === true) {
    return { ok: false, code: 'outside_branch_hours' };
  }
  const openMin =
    h.open_time !== null ? timeStringToMinutes(h.open_time) : null;
  const closeMin =
    h.close_time !== null ? timeStringToMinutes(h.close_time) : null;
  if (openMin === null || closeMin === null || closeMin <= openMin) {
    return { ok: false, code: 'outside_branch_hours' };
  }

  // 2. Slot's minutes-of-day.
  const dayStartMs = Date.UTC(
    startDate.getUTCFullYear(),
    startDate.getUTCMonth(),
    startDate.getUTCDate(),
  );
  const startMin = Math.floor((args.startMs - dayStartMs) / 60000);
  const endMin = Math.floor((args.endMs - dayStartMs) / 60000);

  // 3. Branch interval = [openMin, closeMin).
  const branchIntervals = [{ startMin: openMin, endMin: closeMin }];

  // 4. Doctor schedule intervals.
  const { rows: scheduleRows } = await client.query<{
    start_time: string;
    end_time: string;
  }>(
    SELECT_DOCTOR_SCHEDULE_SQL,
    [args.doctorId, args.branchId, dow, startDate],
  );
  if (scheduleRows.length === 0) {
    return { ok: false, code: 'doctor_unavailable' };
  }
  const doctorIntervals: Array<{ startMin: number; endMin: number }> = [];
  for (const r of scheduleRows) {
    const s = timeStringToMinutes(r.start_time);
    const e = timeStringToMinutes(r.end_time);
    if (s === null || e === null || e <= s) continue;
    doctorIntervals.push({ startMin: s, endMin: e });
  }
  if (doctorIntervals.length === 0) {
    return { ok: false, code: 'doctor_unavailable' };
  }

  // 5. Intersect branch ∩ doctor; the slot must fit inside the result.
  const working = intersect(branchIntervals, doctorIntervals);
  if (working.length === 0) {
    return { ok: false, code: 'doctor_unavailable' };
  }

  // 6. Doctor blocks.
  const { rows: blockRows } = await client.query<{ exists: boolean }>(
    SELECT_DOCTOR_BLOCKS_SQL,
    [args.doctorId, args.branchId, startDate, endDate],
  );
  if (blockRows.length > 0) {
    return { ok: false, code: 'inside_doctor_block' };
  }

  // 7. Existing Scheduled appointments at (doctor, new branch) overlapping
  //    the new slot, EXCLUDING the current row (it's being moved).
  const { rows: existingRows } = await client.query<{ exists: boolean }>(
    SELECT_EXISTING_APPOINTMENTS_SQL,
    [args.doctorId, args.branchId, startDate, endDate, args.appointmentId],
  );
  if (existingRows.length > 0) {
    return { ok: false, code: 'slot_raced' };
  }

  // 8. Slot's minutes-of-day must fit inside the working interval set.
  const slotIv = clampToDay(startMin, endMin);
  if (slotIv === null) {
    return { ok: false, code: 'outside_branch_hours' };
  }
  const fits = intersect(working, [slotIv]);
  if (fits.length === 0) {
    return { ok: false, code: 'outside_branch_hours' };
  }

  // 9. FR-027: any future Scheduled row for (patient, doctor) OTHER than
  //    the current row?
  const { rows: pdRows } = await client.query<{ exists: boolean }>(
    SELECT_PATIENT_DOCTOR_FUTURE_SQL,
    [args.patientPhone, args.doctorId, args.appointmentId],
  );
  if (pdRows.length > 0) {
    return { ok: false, code: 'patient_has_future_with_doctor' };
  }

  // 10. FR-029: any Scheduled row for patient overlapping the new slot
  //     OTHER than the current row?
  const { rows: poRows } = await client.query<{ exists: boolean }>(
    SELECT_PATIENT_TIME_OVERLAP_SQL,
    [args.patientPhone, startDate, endDate, args.appointmentId],
  );
  if (poRows.length > 0) {
    return { ok: false, code: 'patient_time_conflict' };
  }

  return { ok: true };
}

interface RescheduleBody {
  new_branch_id: string;
  new_appointment_type_id: string;
  new_start_datetime: string;
  new_end_datetime: string;
  new_slot_duration_minutes: number;
}

type RescheduleValidationError =
  | 'unknown_field'
  | 'invalid_branch_id'
  | 'invalid_appointment_type_id'
  | 'invalid_start_datetime'
  | 'invalid_end_datetime'
  | 'invalid_slot_duration_minutes'
  | 'invalid_patient_phone'
  | 'invalid_patient_name';

const VALIDATION_ERROR_MAP: Record<RescheduleValidationError, string> = {
  unknown_field: 'unknown_field',
  invalid_branch_id: 'invalid_branch_id',
  invalid_appointment_type_id: 'invalid_appointment_type_id',
  invalid_start_datetime: 'invalid_start_datetime',
  invalid_end_datetime: 'invalid_end_datetime',
  invalid_slot_duration_minutes: 'invalid_slot_duration_minutes',
  invalid_patient_phone: 'invalid_patient_phone',
  invalid_patient_name: 'invalid_patient_name',
};

function validateRescheduleBody(
  body: unknown,
):
  | { ok: true; value: RescheduleBody }
  | { ok: false; error: RescheduleValidationError } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'unknown_field' };
  }
  const b = body as Record<string, unknown>;

  // FR-040 / BR-042: `new_doctor_id` is NEVER accepted. Unknown-field
  // check catches it (plus any other unknown key).
  for (const k of Object.keys(b)) {
    if (!ALLOWED_POST_KEYS.has(k)) return { ok: false, error: 'unknown_field' };
  }
  if (typeof b['new_branch_id'] !== 'string' || !isValidUuid(b['new_branch_id'])) {
    return { ok: false, error: 'invalid_branch_id' };
  }
  if (
    typeof b['new_appointment_type_id'] !== 'string' ||
    !isValidUuid(b['new_appointment_type_id'])
  ) {
    return { ok: false, error: 'invalid_appointment_type_id' };
  }
  if (
    typeof b['new_start_datetime'] !== 'string' ||
    isValidIsoDateTime(b['new_start_datetime']) === null
  ) {
    return { ok: false, error: 'invalid_start_datetime' };
  }
  if (
    typeof b['new_end_datetime'] !== 'string' ||
    isValidIsoDateTime(b['new_end_datetime']) === null
  ) {
    return { ok: false, error: 'invalid_end_datetime' };
  }
  const duration = isValidDurationMinutes(b['new_slot_duration_minutes']);
  if (
    duration === null ||
    duration < DURATION_MIN ||
    duration > DURATION_MAX
  ) {
    return { ok: false, error: 'invalid_slot_duration_minutes' };
  }
  // Surface `new_patient_phone` / `new_patient_name` as `invalid_*`
  // envelopes rather than `unknown_field` — matches E4-S2 / E3-S2
  // semantics for patient-keyed updates. The route ignores these
  // values (patient is bound from the JWT) but if the client sends
  // them in the wrong shape we surface the typed envelope.
  if (
    'new_patient_phone' in b &&
    (typeof b['new_patient_phone'] !== 'string' ||
      !E164_PHONE_RE.test(b['new_patient_phone']))
  ) {
    return { ok: false, error: 'invalid_patient_phone' };
  }
  if (
    'new_patient_name' in b &&
    typeof b['new_patient_name'] !== 'string'
  ) {
    return { ok: false, error: 'invalid_patient_name' };
  }
  return {
    ok: true,
    value: {
      new_branch_id: b['new_branch_id'] as string,
      new_appointment_type_id: b['new_appointment_type_id'] as string,
      new_start_datetime: b['new_start_datetime'] as string,
      new_end_datetime: b['new_end_datetime'] as string,
      new_slot_duration_minutes: duration,
    },
  };
}

patientRescheduleRouter.post(
  '/patient/appointments/:id/reschedule',
  async (req: Request, res: Response): Promise<void> => {
    const claim = req.auth?.claim ?? null;
    if (!claim) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    if (claim.role !== 'patient') {
      res.status(403).json({ error: 'forbidden_role' });
      return;
    }
    const idRaw = req.params['id'];
    const id = typeof idRaw === 'string' ? idRaw : '';
    // E7-S3 privacy: malformed UUID gets the same envelope as unknown id.
    if (!isValidUuid(id)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const validated = validateRescheduleBody(req.body);
    if (!validated.ok) {
      res.status(400).json({ error: VALIDATION_ERROR_MAP[validated.error] });
      return;
    }
    const body = validated.value;
    const nowMs = Date.now();
    const startMs = Date.parse(body.new_start_datetime);
    const endMs = Date.parse(body.new_end_datetime);
    // P1-3: end_datetime MUST equal start_datetime + slot_duration_minutes.
    if (
      !Number.isFinite(startMs) ||
      !Number.isFinite(endMs) ||
      endMs - startMs !== body.new_slot_duration_minutes * 60_000
    ) {
      res.status(400).json({ error: 'invalid_time_range' });
      return;
    }
    // Window check (FR-018, FR-019): 30-day window + same-day exclusion.
    const windowCheck = checkBookingWindow(startMs, nowMs);
    if (!windowCheck.ok) {
      res.status(409).json({ error: windowCheck.code });
      return;
    }

    const pool = await getPool();
    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'patient_reschedule_connect_failed',
      );
      throw err;
    }
    try {
      await client.query('BEGIN');

      // 1. Lock the existing appointment row.
      const { rows } = await client.query<AppointmentRow>(
        SELECT_APPOINTMENT_FOR_UPDATE_SQL,
        [id],
      );
      // E7-S3 privacy: identical envelope for "doesn't exist" and
      // "exists but not yours".
      if (rows.length === 0 || rows[0]!.patient_phone !== claim.sub) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const appt = rows[0]!;
      if (appt.status !== 'Scheduled') {
        await client.query('ROLLBACK');
        res.status(404).json({
          error: 'not_found_appointment_in_terminal_state',
        });
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

      // 2. Doctor + branch + branch_hours + tz lookup. The doctor is
      //    LOCKED — appt.doctor_id is the only source. The branch can
      //    change (FR-041).
      const dow = utcDayOfWeek(new Date(startMs));
      const { rows: docRows } = await client.query<DoctorBranchRow>(
        SELECT_DOCTOR_BRANCH_HOURS_SQL,
        [appt.doctor_id, body.new_branch_id, clinicId, dow],
      );
      if (docRows.length === 0) {
        // Disambiguate doctor_not_found / branch_not_found / doctor_not_at_branch.
        const { rows: docOnly } = await client.query<{ id: string }>(
          SELECT_DOCTOR_SQL,
          [appt.doctor_id, clinicId],
        );
        await client.query('ROLLBACK');
        if (docOnly.length === 0) {
          res.status(404).json({ error: 'doctor_not_found' });
          return;
        }
        const { rows: branchOnly } = await client.query<{ id: string }>(
          SELECT_BRANCH_SQL,
          [body.new_branch_id, clinicId],
        );
        if (branchOnly.length === 0) {
          res.status(404).json({ error: 'branch_not_found' });
          return;
        }
        res.status(400).json({ error: 'doctor_not_at_branch' });
        return;
      }
      const docInfo = docRows[0]!;
      if (!docInfo.doctor_active) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: 'doctor_inactive' });
        return;
      }
      if (!docInfo.branch_active) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: 'branch_inactive' });
        return;
      }

      // 3. New appointment_type lookup. Active only.
      const { rows: typeRows } = await client.query<{
        id: string;
        duration_minutes: number;
        is_active: boolean;
      }>(
        SELECT_APPOINTMENT_TYPE_SQL,
        [body.new_appointment_type_id, clinicId],
      );
      if (typeRows.length === 0 || !typeRows[0]!.is_active) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'appointment_type_not_found' });
        return;
      }
      const apptType = typeRows[0]!;

      // Duration mismatch — caught BEFORE the in-txn recheck.
      if (apptType.duration_minutes !== body.new_slot_duration_minutes) {
        await client.query('ROLLBACK');
        res.status(409).json({ error: 'duration_mismatch' });
        return;
      }

      // 4. Slot re-check for the new (doctor, branch, type, start, end).
      const recheck = await recheckNewSlotInTxn(client, {
        appointmentId: appt.id,
        doctorId: appt.doctor_id,
        branchId: body.new_branch_id,
        startMs,
        endMs,
        patientPhone: appt.patient_phone,
        branchHours: {
          open_time: docInfo.open_time,
          close_time: docInfo.close_time,
          is_closed: docInfo.is_closed,
        },
      });
      if (!recheck.ok) {
        await client.query('ROLLBACK');
        if (recheck.code === 'slot_raced') {
          res.status(409).json(SLOT_RACED_ENVELOPE);
          return;
        }
        res.status(409).json({ error: recheck.code });
        return;
      }

      // 5. UPDATE the appointment row. The GIST exclusion constraint on
      //    (branch_id, tstzrange, status='Scheduled') is the race-safety
      //    net — SQLSTATE 23P01 → 409 slot_raced. On any UPDATE
      //    failure the txn rolls back; the original row is untouched.
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
          body.new_branch_id,
          body.new_appointment_type_id,
          new Date(startMs).toISOString(),
          new Date(endMs).toISOString(),
        ]);
        updatedRow = result.rows[0]!;
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === '23P01') {
          await client.query('ROLLBACK');
          res.status(409).json(SLOT_RACED_ENVELOPE);
          return;
        }
        throw err;
      }

      // 6. Audit row. Payload mirrors F-05's
      //    `metadata = {from, to, branch_change, type_change}` so E7-S2
      //    can surface WHAT changed in the audit drawer.
      const branchChange = appt.branch_id !== body.new_branch_id;
      const typeChange = appt.appointment_type_id !== body.new_appointment_type_id;
      const auditPayload = JSON.stringify({
        from: {
          branch_id: appt.branch_id,
          appointment_type_id: appt.appointment_type_id,
          start_datetime: appt.start_datetime.toISOString(),
          end_datetime: appt.end_datetime.toISOString(),
        },
        to: {
          branch_id: body.new_branch_id,
          appointment_type_id: body.new_appointment_type_id,
          start_datetime: new Date(startMs).toISOString(),
          end_datetime: new Date(endMs).toISOString(),
        },
        branch_change: branchChange,
        type_change: typeChange,
      });
      await client.query(INSERT_AUDIT_SQL, [
        appt.id,
        'patient',
        `patient:${claim.sub}`,
        'rescheduled',
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
        'patient_reschedule_failed',
      );
      throw err;
    } finally {
      client.release();
    }
  },
);