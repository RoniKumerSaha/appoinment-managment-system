/**
 * Bookings routes — `POST /bookings` (atomic create).
 *
 * Per spec-3-2 (E3-S2), the first-time guest-booking flow. Takes a slot
 * the patient picked from `/availability` and atomically inserts an
 * `appointment` row + an `appointment_audit` row.
 *
 * The route is open to any authenticated role (patient, receptionist,
 * doctor, admin). FR-022 makes phone the patient key, so the JWT's `sub`
 * does NOT pin the booking to a specific patient — the submitted
 * `patient_phone` is the source of truth.
 *
 * Atomic + GIST-protected:
 *   - All reads + the INSERT + the audit-row write happen in a single
 *     BEGIN/COMMIT block.
 *   - Slot re-validation runs INSIDE the transaction so a concurrent
 *     booking can't slip a row in between the check and the insert.
 *   - 0008's `appointment_no_overlap` GIST exclusion is the
 *     race-safety net (a concurrent winner of the slot fails at the
 *     constraint layer with SQLSTATE 23P01 → 409 slot_raced).
 *
 * 0008 also has `idx_appointment_patient_doctor_scheduled` (partial
 * unique on (patient_phone, doctor_id) WHERE status='Scheduled') which
 * enforces FR-027 — a second Scheduled row for the same patient+doctor
 * raises 23505 → 409 patient_has_future_with_doctor.
 *
 * FR-029 (patient time-overlap anywhere) is checked in-app via
 * SELECT (we don't have a GIST exclusion on patient time-overlap
 * because cross-branch overlap is allowed — see 0008's readme).
 *
 * Patient row lifecycle (FR-022): `patient.phone_number` is UNIQUE.
 * The route first tries `INSERT ... ON CONFLICT DO NOTHING` for a
 * fresh phone, then SELECTs to confirm. If a concurrent booking beat
 * us to the insert, the SELECT returns the existing row id and we
 * reuse it.
 *
 * Audit (per AD-7 / 0009): a single `created` audit row in the same
 * transaction. The actor depends on the JWT role:
 *   - `patient` → `actor_role='patient'`, `actor_id='patient:<phone>'`,
 *     `payload.source='self_book'` (FR-024; patient is self-booking).
 *   - `receptionist` → `actor_role='receptionist'`,
 *     `actor_id='staff:<sub>'`, `payload.source='receptionist_book'`
 *     (E3-S4 / F-13 / BR-004). The receptionist's branch_ids must
 *     include `body.branch_id` (403 outside_branch_scope otherwise).
 *   - `doctor` / `admin` → fall through as `patient` (out of scope for
 *     E3-S2..E3-S4).
 * `appointment.created_by` carries the same `staff:<sub>` or
 * `patient:<phone>` token. The audit row is INSERT-only — 0009's
 * `reject_audit_mutation` trigger raises on UPDATE/DELETE.
 *
 * Implementation note: SC2 documents a deliberate duplication of the
 * E3-S1 slot-math subset (`recheckSlotInTxn` here vs
 * `engine.ts:computeAvailability`). The in-txn recheck answers a
 * one-slot question, not a full-day list; refactoring the engine into
 * a "check-this-slot" mode is a future cleanup story.
 */
import { Router, type Request, type Response } from 'express';
import type { PoolClient } from 'pg';
import { getPool } from '../db/pool.js';
import { getLogger } from '../middleware/log.js';
import {
  validateCreateBookingBody,
  checkBookingWindow,
  type CreateBookingValidationError,
} from './bookings-helpers.js';
import {
  intersect,
  clampToDay,
} from '../availability/slots.js';
import {
  timeStringToMinutes,
  utcDayOfWeek,
} from '../availability/types.js';
import {
  branchLocalMidnightMs,
  branchLocalDayOfWeek,
} from './recurring-helpers.js';
import { patientCreatedBy, staffCreatedBy } from './created-by.js';
import { inc } from '../metrics/counters.js';

const VALIDATION_ERROR_MAP: Record<CreateBookingValidationError, string> = {
  unknown_field: 'unknown_field',
  invalid_doctor_id: 'invalid_doctor_id',
  invalid_branch_id: 'invalid_branch_id',
  invalid_appointment_type_id: 'invalid_appointment_type_id',
  invalid_start_datetime: 'invalid_start_datetime',
  invalid_end_datetime: 'invalid_end_datetime',
  invalid_slot_duration_minutes: 'invalid_slot_duration_minutes',
  invalid_patient_phone: 'invalid_patient_phone',
  invalid_patient_name: 'invalid_patient_name',
};

const SELECT_CLINIC_ID_SQL = `SELECT id FROM clinic LIMIT 1`;

// Doctor + branch + branch_hours (for the slot's DOW) + tz, all in one
// query. Replaces the previous two-query split: the disambiguation
// query at the top of the txn, and `SELECT_DOCTOR_AT_BRANCH_SQL` inside
// `recheckSlotInTxn`. P0-1 + P1-4 from review-loop-1.
//
// `$4` is the day_of_week (0..6) of the slot's date; `bw.*` are NULL
// when no branch_weekly_hours row exists for that DOW (LEFT JOIN). The
// `is_closed` column distinguishes closed days (true) from absent rows
// (NULL) — see recheck_branch_hours_row() for the disambiguation.
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

// E7-S6 partial: light-weight tz probe. Used to compute the
// branch-local DOW before the doctor+branch_hours SELECT, so the
// hours row is keyed on the correct (branch-local) day.
const SELECT_BRANCH_TZ_SQL = `SELECT tz FROM branch WHERE id = $1`;

const SELECT_APPOINTMENT_TYPE_SQL = `
  SELECT id, name, duration_minutes, is_active
    FROM appointment_type
   WHERE id = $1 AND clinic_id = $2;
`;

// Any Scheduled rows for this doctor + branch that overlap the slot's tstzrange.
const SELECT_EXISTING_APPOINTMENTS_SQL = `
  SELECT 1 FROM appointment
   WHERE doctor_id = $1 AND branch_id = $2
     AND status = 'Scheduled'
     AND tstzrange(start_datetime, end_datetime, '[)') &&
         tstzrange($3::timestamptz, $4::timestamptz, '[)')
   LIMIT 1;
`;

// Block rows for this doctor + branch that overlap the slot's tstzrange.
const SELECT_DOCTOR_BLOCKS_SQL = `
  SELECT 1 FROM doctor_block
   WHERE doctor_id = $1 AND branch_id = $2
     AND tstzrange(start_datetime, end_datetime, '[)') &&
         tstzrange($3::timestamptz, $4::timestamptz, '[)')
   LIMIT 1;
`;

// Doctor schedule rows for this (doctor, branch, DOW) effective on the slot's date.
const SELECT_DOCTOR_SCHEDULE_SQL = `
  SELECT start_time, end_time
    FROM doctor_schedule
   WHERE doctor_id = $1 AND branch_id = $2
     AND day_of_week = $3
     AND effective_from <= ($4::date)
     AND (effective_to IS NULL OR effective_to >= ($4::date));
`;

// FR-027: any future Scheduled row for (patient, doctor)?
const SELECT_PATIENT_DOCTOR_FUTURE_SQL = `
  SELECT 1 FROM appointment
   WHERE patient_phone = $1 AND doctor_id = $2
     AND status = 'Scheduled' AND start_datetime > now()
   LIMIT 1;
`;

// FR-029: any Scheduled row for patient overlapping the slot's tstzrange?
const SELECT_PATIENT_TIME_OVERLAP_SQL = `
  SELECT 1 FROM appointment
   WHERE patient_phone = $1
     AND status = 'Scheduled'
     AND tstzrange(start_datetime, end_datetime, '[)') &&
         tstzrange($2::timestamptz, $3::timestamptz, '[)')
   LIMIT 1;
`;

// The arbiter is named by CONSTRAINT, not by column. `ON CONFLICT
// (phone_number)` makes Postgres infer an index, and while a redundant
// plain btree on the same column existed it could infer that one — two
// concurrent upserts of DIFFERENT phones then landed on the same index
// leaf and deadlocked (40P01). Naming the constraint removes the
// inference entirely. See migration 0021.
const INSERT_PATIENT_SQL = `
  INSERT INTO patient (phone_number, full_name) VALUES ($1, $2)
  ON CONFLICT ON CONSTRAINT patient_phone_number_key DO NOTHING
  RETURNING id::text AS id;
`;

const SELECT_PATIENT_ID_SQL = `
  SELECT id::text AS id FROM patient WHERE phone_number = $1;
`;

// E3-S3 (FR-023): on a returning-patient booking, update the stored
// `full_name` to whatever the patient typed. The `IS DISTINCT FROM`
// predicate keeps the UPDATE a no-op when the name is unchanged, so
// the row's write-amplification stays at zero on the common path.
const UPDATE_PATIENT_NAME_SQL = `
  UPDATE patient SET full_name = $1
   WHERE phone_number = $2
     AND full_name IS DISTINCT FROM $1;
`;

const INSERT_APPOINTMENT_SQL = `
  INSERT INTO appointment
    (clinic_id, branch_id, doctor_id, patient_phone, appointment_type_id,
     start_datetime, end_datetime, status, created_by)
  VALUES
    ($1, $2, $3, $4, $5,
     $6::timestamptz, $7::timestamptz, 'Scheduled', $8)
  RETURNING id::text AS id, clinic_id::text AS clinic_id,
            branch_id::text AS branch_id, doctor_id::text AS doctor_id,
            patient_phone, appointment_type_id::text AS appointment_type_id,
            start_datetime, end_datetime, status,
            created_by, created_at, updated_at;
`;

const INSERT_AUDIT_SQL = `
  INSERT INTO appointment_audit
    (appointment_id, actor_role, actor_id, event, payload)
  VALUES ($1, $2, $3, $4, $5::jsonb);
`;

// ConflictModal envelope for slot_raced. Terminal — carries `can_do[]`.
const SLOT_RACED_ENVELOPE = {
  error: 'slot_raced',
  code: 'SLOT_RACED',
  what: 'That slot was just booked.',
  why: 'A concurrent booking completed first. Please refresh and pick another slot.',
  can_do: [
    { label: 'Refresh availability', action: 'refresh_availability' },
  ],
} as const;

export const bookingsRouter: Router = Router();

type RecheckFailureCode =
  | 'doctor_inactive'
  | 'branch_inactive'
  | 'outside_branch_hours'
  | 'doctor_unavailable'
  | 'inside_doctor_block'
  | 'slot_raced';

type RecheckOutcome =
  | { ok: true }
  | { ok: false; code: RecheckFailureCode };

interface DoctorBranchRow {
  doctor_active: boolean;
  tz: string;
  branch_active: boolean;
  open_time: string | null;
  close_time: string | null;
  is_closed: boolean | null;
}

/** Run the in-txn slot re-check. Pre-conditions already verified by the
 *  caller: doctor exists + at branch + active, branch active, type
 *  exists + active + matches `storedDuration === submittedDuration`.
 *  Branch-hours row may be NULL (no row for that DOW) — closed vs absent
 *  are differentiated explicitly. */
async function recheckSlotInTxn(
  client: PoolClient,
  args: {
    doctorId: string;
    branchId: string;
    storedDuration: number;
    submittedDuration: number;
    startMs: number;
    endMs: number;
    branchHours: {
      open_time: string | null;
      close_time: string | null;
      is_closed: boolean | null;
    };
    /** E7-S6 partial: IANA tz name. When supplied, the slot's
     *  minutes-of-day are anchored to branch-local midnight and
     *  the doctor_schedule query uses the branch-local DOW.
     *  Without it, the legacy UTC-anchored math is used (works
     *  only for UTC branches). */
    branchTz?: string | null;
  },
): Promise<RecheckOutcome> {
  // Defense in depth — caller already enforces this in the route, but
  // document it here so the function is safe to call in isolation.
  if (args.storedDuration !== args.submittedDuration) {
    // Should be unreachable; route already returns 409 before calling.
    return { ok: false, code: 'outside_branch_hours' };
  }

  // 1. Branch-hours disambiguation (P0-3 fix).
  const h = args.branchHours;
  // P0-3: differentiate NULL row (no branch_hours row for this DOW)
  // from `is_closed = true` (admin explicitly marked the day closed).
  // The spec matrix says "Branch closed → outside_branch_hours" — but
  // an absent row is not the same as closed, so fall through to the
  // doctor schedule check before declaring outside_branch_hours.
  if (h.is_closed === true) {
    return { ok: false, code: 'outside_branch_hours' };
  }
  if (h.is_closed !== null) {
    // is_closed is `false` (admin set explicitly to open) — fall through
    // with open_time/close_time as authoritative.
  }
  const openMin =
    h.is_closed === null ? null : h.open_time ? timeStringToMinutes(h.open_time) : null;
  const closeMin =
    h.is_closed === null ? null : h.close_time ? timeStringToMinutes(h.close_time) : null;
  // If `is_closed` is false but open/close are missing/malformed, the
  // admin set up the row incorrectly — treat as outside_branch_hours.
  if (openMin === null || closeMin === null || closeMin <= openMin) {
    return { ok: false, code: 'outside_branch_hours' };
  }

  // 2. Compute slot's minutes-of-day.
  //    E7-S6 partial: when branchTz is set, anchor to
  //    branch-local midnight so a 14:00 ET slot is 14*60=840 min,
  //    which fits the branch's 09:00-17:00 wall-clock window.
  //    Without it, fall back to UTC midnight (legacy).
  const startDate = new Date(args.startMs);
  const dayStartMs =
    args.branchTz !== undefined && args.branchTz !== null
      ? branchLocalMidnightMs(args.startMs, args.branchTz)
      : Date.UTC(
          startDate.getUTCFullYear(),
          startDate.getUTCMonth(),
          startDate.getUTCDate(),
        );
  const startMin = Math.floor((args.startMs - dayStartMs) / 60000);
  const endMin = Math.floor((args.endMs - dayStartMs) / 60000);

  // 3. Branch interval = [openMin, closeMin).
  const branchIntervals = [{ startMin: openMin, endMin: closeMin }];

  // 4. Doctor schedule intervals — multi-period days allowed.
  //    E7-S6 partial: use branch-local DOW when tz is set.
  const dow =
    args.branchTz !== undefined && args.branchTz !== null
      ? branchLocalDayOfWeek(args.startMs, args.branchTz)
      : utcDayOfWeek(startDate);
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

  // 5. Intersect branch ∩ doctor; the slot must be contained in the result.
  const working = intersect(branchIntervals, doctorIntervals);
  if (working.length === 0) {
    return { ok: false, code: 'doctor_unavailable' };
  }

  // 6. Block / existing appointment overlaps — SQL filter at the row level.
  const startDt = new Date(args.startMs);
  const endDt = new Date(args.endMs);
  const { rows: blockRows } = await client.query<{ exists: boolean }>(
    SELECT_DOCTOR_BLOCKS_SQL,
    [args.doctorId, args.branchId, startDt, endDt],
  );
  if (blockRows.length > 0) {
    return { ok: false, code: 'inside_doctor_block' };
  }

  const { rows: existingRows } = await client.query<{ exists: boolean }>(
    SELECT_EXISTING_APPOINTMENTS_SQL,
    [args.doctorId, args.branchId, startDt, endDt],
  );
  if (existingRows.length > 0) {
    return { ok: false, code: 'slot_raced' };
  }

  // 7. Slot's minutes-of-day must fit inside the working interval set.
  const slotIv = clampToDay(startMin, endMin);
  if (slotIv === null) {
    return { ok: false, code: 'outside_branch_hours' };
  }
  const fits = intersect(working, [slotIv]);
  if (fits.length === 0) {
    return { ok: false, code: 'outside_branch_hours' };
  }

  return { ok: true };
}

bookingsRouter.post(
  '/bookings',
  async (req: Request, res: Response): Promise<void> => {
    const claim = req.auth?.claim ?? null;
    if (!claim) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }

    // Every request that gets past auth is a booking attempt, whatever
    // its outcome.
    inc('booking.attempt');

    // Single response boundary: classify the outcome into the
    // success / conflict / failure counters so no exit path can be
    // forgotten. A 409 means the slot or the patient was already taken;
    // every other non-2xx is a failure.
    const respond = (status: number, body: unknown): void => {
      if (status === 201) inc('booking.success');
      else if (status === 409) inc('booking.conflict');
      else inc('booking.failure');
      res.status(status).json(body);
    };

    const validated = validateCreateBookingBody(req.body);
    if (!validated.ok) {
      respond(400, { error: VALIDATION_ERROR_MAP[validated.error] });
      return;
    }
    const body = validated.value;
    const nowMs = Date.now();

    // E3-S4 / F-13 / BR-004: receptionist flow locks branch to the
    // receptionist's assigned branch (single-branch invariant). The
    // branch picker is server-trusted here: if the body says branch-west
    // but the receptionist is at branch-east, we 403 — we do NOT retarget.
    // Other roles (patient, doctor, admin) bypass this gate; their
    // branch-scope semantics are out of scope for E3-S4.
    if (
      claim.role === 'receptionist' &&
      !claim.branch_ids.includes(body.branch_id)
    ) {
      respond(403, { error: 'outside_branch_scope' });
      return;
    }
    const isReceptionist = claim.role === 'receptionist';
    const actorSub = claim.sub;

    const startMs = Date.parse(body.start_datetime);
    const endMs = Date.parse(body.end_datetime);
    // P1-3: end_datetime MUST equal start_datetime + slot_duration_minutes.
    // The route never accepts a mismatch — clients are not allowed to
    // pass an arbitrary (start, end) pair.
    if (
      !Number.isFinite(startMs) ||
      !Number.isFinite(endMs) ||
      endMs - startMs !== body.slot_duration_minutes * 60_000
    ) {
      respond(400, { error: 'invalid_time_range' });
      return;
    }

    // P1-1: window check returns 409 (not 400) per spec matrix. Codes
    // are unchanged from `checkBookingWindow`.
    const windowCheck = checkBookingWindow(startMs, nowMs);
    if (!windowCheck.ok) {
      respond(409, { error: windowCheck.code });
      return;
    }

    const pool = await getPool();
    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'bookings_connect_failed',
      );
      throw err;
    }
    try {
      await client.query('BEGIN');

      const { rows: clinicRows } = await client.query<{ id: string }>(
        SELECT_CLINIC_ID_SQL,
      );
      if (clinicRows.length === 0) {
        await client.query('ROLLBACK');
        throw new Error('clinic_row_missing');
      }
      const clinicId = clinicRows[0]!.id;

      // Combined doctor + branch + branch_hours + tz lookup (P0-1, P1-4).
      // E7-S6 partial: probe branch tz first so the
      // branch_weekly_hours row is keyed on the branch-local
      // DOW. (The doctor+branch_hours query also returns `tz`
      // in the row, but we need it before the SELECT to compute
      // the DOW.)
      const { rows: tzRows } = await client.query<{ tz: string }>(
        SELECT_BRANCH_TZ_SQL,
        [body.branch_id],
      );
      if (tzRows.length === 0) {
        await client.query('ROLLBACK');
        respond(404, { error: 'branch_not_found' });
        return;
      }
      const branchTz = tzRows[0]!.tz;
      const dow = branchLocalDayOfWeek(startMs, branchTz);
      const { rows: docRows } = await client.query<DoctorBranchRow>(
        SELECT_DOCTOR_BRANCH_HOURS_SQL,
        [body.doctor_id, body.branch_id, clinicId, dow],
      );
      if (docRows.length === 0) {
        // Disambiguate doctor_not_found / branch_not_found /
        // doctor_not_at_branch with two additional SELECTs.
        const { rows: docOnly } = await client.query<{ id: string }>(
          SELECT_DOCTOR_SQL,
          [body.doctor_id, clinicId],
        );
        await client.query('COMMIT');
        if (docOnly.length === 0) {
          respond(404, { error: 'doctor_not_found' });
          return;
        }
        const { rows: branchOnly } = await client.query<{ id: string }>(
          SELECT_BRANCH_SQL,
          [body.branch_id, clinicId],
        );
        if (branchOnly.length === 0) {
          respond(404, { error: 'branch_not_found' });
          return;
        }
        respond(400, { error: 'doctor_not_at_branch' });
        return;
      }
      const docInfo = docRows[0]!;
      if (!docInfo.doctor_active) {
        await client.query('COMMIT');
        respond(400, { error: 'doctor_inactive' });
        return;
      }
      if (!docInfo.branch_active) {
        await client.query('COMMIT');
        respond(400, { error: 'branch_inactive' });
        return;
      }

      const { rows: typeRows } = await client.query<{
        id: string;
        duration_minutes: number;
        is_active: boolean;
      }>(
        SELECT_APPOINTMENT_TYPE_SQL,
        [body.appointment_type_id, clinicId],
      );
      // P0-2: collapse "appointment_type_not_found" + "inactive" into a
      // single 404 envelope. Clients shouldn't see inactive types, so
      // there is no useful distinction to surface — they just don't see
      // them. Documented in spec SC2.
      if (typeRows.length === 0 || !typeRows[0]!.is_active) {
        await client.query('COMMIT');
        respond(404, { error: 'appointment_type_not_found' });
        return;
      }
      const apptType = typeRows[0]!;

      // Duration mismatch — caught BEFORE the in-txn recheck.
      if (apptType.duration_minutes !== body.slot_duration_minutes) {
        await client.query('COMMIT');
        respond(409, { error: 'duration_mismatch' });
        return;
      }

      // Patient filters (FR-027 / FR-029).
      const { rows: pdRows } = await client.query<{ exists: boolean }>(
        SELECT_PATIENT_DOCTOR_FUTURE_SQL,
        [body.patient_phone, body.doctor_id],
      );
      if (pdRows.length > 0) {
        await client.query('COMMIT');
        respond(409, { error: 'patient_has_future_with_doctor' });
        return;
      }
      const { rows: poRows } = await client.query<{ exists: boolean }>(
        SELECT_PATIENT_TIME_OVERLAP_SQL,
        [body.patient_phone, new Date(startMs), new Date(endMs)],
      );
      if (poRows.length > 0) {
        await client.query('COMMIT');
        respond(409, { error: 'patient_time_conflict' });
        return;
      }

      // Slot re-check (runs the E3-S1 pipeline INSIDE the txn).
      const recheck = await recheckSlotInTxn(client, {
        doctorId: body.doctor_id,
        branchId: body.branch_id,
        storedDuration: apptType.duration_minutes,
        submittedDuration: body.slot_duration_minutes,
        startMs,
        endMs,
        branchHours: {
          open_time: docInfo.open_time,
          close_time: docInfo.close_time,
          is_closed: docInfo.is_closed,
        },
        // E7-S6 partial: thread branch tz so the validator uses
        // branch-local minutes-of-day + branch-local DOW.
        branchTz,
      });
      if (!recheck.ok) {
        await client.query('COMMIT');
        if (recheck.code === 'slot_raced') {
          respond(409, SLOT_RACED_ENVELOPE);
          return;
        }
        respond(409, { error: recheck.code });
        return;
      }

      // Patient row lifecycle (FR-022 + FR-023): try INSERT, fall back to SELECT.
      // When the INSERT path falls through, the row existed before — that's
      // the "returning patient" case (E3-S3). E3-S3 requires that the stored
      // `full_name` be updated to whatever the patient typed; FR-023: "Editing
      // the name updates the patient's stored name." The `IS DISTINCT FROM`
      // predicate in `UPDATE_PATIENT_NAME_SQL` makes the UPDATE a no-op when
      // the name is unchanged, so the common path (same name) writes zero
      // rows. Audit payload is enriched below with `patient_name_after`.
      const patientIns = await client.query<{ id: string }>(
        INSERT_PATIENT_SQL,
        [body.patient_phone, body.patient_name],
      );
      let patientId: string;
      let patientNameAfter: string;
      if (patientIns.rows[0]) {
        // First-time path: INSERT succeeded, name is the submitted value.
        patientId = patientIns.rows[0].id;
        patientNameAfter = body.patient_name;
      } else {
        // Returning-patient path: SELECT to confirm + UPDATE name if changed.
        const patientSel = await client.query<{ id: string }>(
          SELECT_PATIENT_ID_SQL,
          [body.patient_phone],
        );
        if (patientSel.rows.length === 0) {
          await client.query('ROLLBACK');
          throw new Error('patient_row_missing_after_conflict');
        }
        patientId = patientSel.rows[0]!.id;
        await client.query(UPDATE_PATIENT_NAME_SQL, [
          body.patient_name,
          body.patient_phone,
        ]);
        patientNameAfter = body.patient_name;
      }

      // INSERT the appointment row. The 0008 GIST exclusion catches any
      // concurrent winner that slipped past the in-txn re-check; the
      // SQLSTATE 23P01 path returns 409 slot_raced.
      //
      // E3-S4: the `created_by` column carries the actor of record:
      //   - patient self-book → `patient:<phone>` (FR-024).
      //   - receptionist booking on behalf → `staff:<sub>`.
      // The actor role + actor_id on the audit row below are derived
      // from the same predicate, so an audit consumer can reconstruct
      // who pressed the button without joining to the JWT.
      // The `created_by` column is CHECK-constrained to a controlled
      // token alphabet, so the actor identity is encoded into it. The
      // audit row's `actor_id` has no such constraint and keeps the
      // readable form.
      const createdBy = isReceptionist
        ? staffCreatedBy(actorSub)
        : patientCreatedBy(body.patient_phone);
      const auditActorId = isReceptionist
        ? `staff:${actorSub}`
        : `patient:${body.patient_phone}`;
      let apptRow: {
        id: string;
        clinic_id: string;
        branch_id: string;
        doctor_id: string;
        patient_phone: string;
        appointment_type_id: string;
        start_datetime: Date;
        end_datetime: Date;
        status: string;
        created_by: string;
        created_at: Date;
        updated_at: Date;
      };
      try {
        const result = await client.query(INSERT_APPOINTMENT_SQL, [
          clinicId,
          body.branch_id,
          body.doctor_id,
          body.patient_phone,
          body.appointment_type_id,
          new Date(startMs).toISOString(),
          new Date(endMs).toISOString(),
          createdBy,
        ]);
        apptRow = result.rows[0]!;
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === '23P01') {
          await client.query('ROLLBACK');
          respond(409, SLOT_RACED_ENVELOPE);
          return;
        }
        if (code === '40P01' || code === '40001') {
          // 40P01 (deadlock) and 40001 (serialization failure) are the two
          // SQLSTATEs Postgres documents as retryable. A booking txn that
          // aborts on either has lost the race for the slot just as surely
          // as one aborted by the 0008 GIST exclusion — the concurrent
          // writer committed first. Surfacing 500 here would tell the
          // patient "try again later" for what is really "someone else
          // booked that slot", and would leave the web client unable to
          // render the ConflictModal path (E7-S4) that consumes the
          // `slot_raced` envelope.
          await client.query('ROLLBACK');
          getLogger().warn(
            { err: err instanceof Error ? err.message : String(err), code },
            'booking_insert_retryable_conflict',
          );
          respond(409, SLOT_RACED_ENVELOPE);
          return;
        }
        if (code === '23505') {
          // The partial unique idx_appointment_patient_doctor_scheduled
          // caught a second Scheduled row for the same (patient, doctor).
          await client.query('ROLLBACK');
          respond(409, { error: 'patient_has_future_with_doctor' });
          return;
        }
        if (code === '23514') {
          // A CHECK violation (e.g. `appointment_created_by_check`) is a
          // server-side defect, not a client error — but it must not
          // escape the handler: an unhandled rejection in an async
          // Express handler terminates the process and takes the whole
          // API down. Roll back and surface it as a 500.
          await client.query('ROLLBACK');
          getLogger().error(
            { err: err instanceof Error ? err.message : String(err) },
            'booking_insert_check_violation',
          );
          respond(500, { error: 'internal_error' });
          return;
        }
        throw err;
      }

      // Append-only audit row (0009's reject_audit_mutation trigger
      // enforces INSERT-only). E3-S3 enriches the payload with
      // `patient_name_after` so audit consumers can see the post-update
      // name on a returning-patient booking. E3-S4 switches the actor
      // attribution when the caller is a receptionist.
      const auditActorRole = isReceptionist ? 'receptionist' : 'patient';
      const auditPayload = JSON.stringify({
        start_datetime: apptRow.start_datetime.toISOString(),
        end_datetime: apptRow.end_datetime.toISOString(),
        appointment_type_id: apptRow.appointment_type_id,
        doctor_id: apptRow.doctor_id,
        branch_id: apptRow.branch_id,
        source: isReceptionist ? 'receptionist_book' : 'self_book',
        patient_name_after: patientNameAfter,
        // Receptionist-only field; helps audit consumers identify the
        // human who pressed the button without re-parsing the JWT.
        ...(isReceptionist ? { actor_sub: actorSub } : {}),
      });
      await client.query(INSERT_AUDIT_SQL, [
        apptRow.id,
        auditActorRole,
        auditActorId,
        'created',
        auditPayload,
      ]);

      await client.query('COMMIT');

      // `branchTz` was captured in-txn (P0-1) — no post-COMMIT SELECT.
      respond(201, {
        appointment: {
          id: apptRow.id,
          doctor_id: apptRow.doctor_id,
          branch_id: apptRow.branch_id,
          appointment_type_id: apptRow.appointment_type_id,
          start_datetime: apptRow.start_datetime.toISOString(),
          end_datetime: apptRow.end_datetime.toISOString(),
          status: apptRow.status,
          tz: branchTz,
          patient_id: patientId,
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
        'bookings_create_failed',
      );
      // An exception escaping the handler never reaches `respond`, so the
      // failure counter is incremented here. The rethrow is caught by the
      // async-handler wrapper, which turns it into a 500 for this client.
      inc('booking.failure');
      throw err;
    } finally {
      client.release();
    }
  },
);