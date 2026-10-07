/**
 * Availability engine — public route.
 *
 * Per spec-3-1 + architecture §3.2, exposes `GET /availability` with
 * query params:
 *   - doctor_id (required, UUID)
 *   - branch_id (required, UUID)
 *   - date (required, YYYY-MM-DD; UTC; must be in [today+1, today+30])
 *   - appointment_type_id (required, UUID)
 *   - patient_phone (optional, E.164 form; when supplied applies FR-027 + FR-029)
 *
 * Returns 200 with `{slots: [{start_datetime, end_datetime}, ...], reason?: ...}`.
 *
 * Auth: any authenticated caller (patient, receptionist, doctor, admin).
 * Anonymous callers → 401 unauthenticated. Per the E3 booking flow,
 * unauthenticated browsing is NOT supported; the OTP login gate runs
 * first. The route does NOT enforce a specific role — every role
 * needs to read availability for the booking flow.
 *
 * E3-S5 / F-15: when `claim.role === 'receptionist'`, the route locks
 * the `branch_id` query param to the receptionist's `branch_ids`
 * (BR-004 single-branch invariant). Same gate as E3-S4's POST
 * /bookings. The doctor-at-branch rule is the engine's existing
 * `doctor_not_at_branch` 400 envelope (E3-S1).
 */
import { Router, type Request, type Response } from 'express';
import {
  computeAvailability,
  type AvailabilityError,
} from '../availability/engine.js';
import {
  parseIsoDate,
  datePlusMinutes,
} from '../availability/types.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const E164_PHONE_RE = /^\+[1-9]\d{6,14}$/;

export const availabilityRouter: Router = Router();

availabilityRouter.get(
  '/availability',
  async (req: Request, res: Response): Promise<void> => {
    const claim = req.auth?.claim ?? null;
    if (!claim) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }

    const doctorIdRaw = req.query['doctor_id'];
    const branchIdRaw = req.query['branch_id'];
    const dateRaw = req.query['date'];
    const typeIdRaw = req.query['appointment_type_id'];
    const patientPhoneRaw = req.query['patient_phone'];

    const doctorId = typeof doctorIdRaw === 'string' ? doctorIdRaw : '';
    const branchId = typeof branchIdRaw === 'string' ? branchIdRaw : '';
    const typeId = typeof typeIdRaw === 'string' ? typeIdRaw : '';
    const dateStr = typeof dateRaw === 'string' ? dateRaw : '';
    // FR-027/FR-029 patient filter derivation:
    //   - For `role === 'patient'`, the JWT `sub` IS the phone (per
    //     patient-otp.ts / otp/service.ts signClaim). Always apply
    //     the patient filter so the preview matches what the
    //     commit-time recheck will do (otherwise the slot grid
    //     shows 28 open slots and the user only learns about a
    //     conflict after picking one — see E4-S3 UX bug).
    //   - For staff roles, the explicit `patient_phone` query param
    //     is honoured when supplied (receptionist booking on
    //     behalf of a patient — E3-S4). When omitted, no patient
    //     filter applies.
    const explicitPatientPhone =
      typeof patientPhoneRaw === 'string' && patientPhoneRaw.length > 0
        ? patientPhoneRaw
        : null;
    const patientPhone =
      claim.role === 'patient'
        ? claim.sub
        : explicitPatientPhone;

    if (!UUID_RE.test(doctorId)) {
      res.status(400).json({ error: 'invalid_doctor_id' });
      return;
    }
    if (!UUID_RE.test(branchId)) {
      res.status(400).json({ error: 'invalid_branch_id' });
      return;
    }
    if (!UUID_RE.test(typeId)) {
      res.status(400).json({ error: 'invalid_appointment_type_id' });
      return;
    }
    if (!ISO_DATE_RE.test(dateStr)) {
      res.status(400).json({ error: 'invalid_date' });
      return;
    }
    const date = parseIsoDate(dateStr);
    if (date === null) {
      res.status(400).json({ error: 'invalid_date' });
      return;
    }
    if (patientPhone !== null && !E164_PHONE_RE.test(patientPhone)) {
      res.status(400).json({ error: 'invalid_patient_phone' });
      return;
    }

    // E3-S5 / F-15 / BR-004: receptionist flow locks branch to the
    // receptionist's assigned branch (single-branch invariant). The
    // branch picker is server-trusted here: if the query says branch-west
    // but the receptionist is at branch-east, we 403 — we do NOT retarget.
    // Other roles (patient, doctor, admin) bypass this gate; their
    // branch-scope semantics are out of scope for E3-S5.
    if (
      claim.role === 'receptionist' &&
      !claim.branch_ids.includes(branchId)
    ) {
      res.status(403).json({ error: 'outside_branch_scope' });
      return;
    }

    const outcome = await computeAvailability({
      doctorId,
      branchId,
      appointmentTypeId: typeId,
      date,
      durationMinutes: 0, // engine overwrites with stored duration
      patientPhone,
      nowMs: Date.now(),
    });

    if (outcome.kind === 'err') {
      const err = outcome.error;
      const statusAndBody = mapAvailabilityError(err);
      res.status(statusAndBody.status).json(statusAndBody.body);
      return;
    }

    const { slots, reason } = outcome.result;
    const dayStartMs = date.getTime();
    const jsonSlots = slots.map((s) => ({
      start_datetime: datePlusMinutes(dayStartMs, s.startMin).toISOString(),
      end_datetime: datePlusMinutes(dayStartMs, s.endMin).toISOString(),
    }));
    const body: Record<string, unknown> = { slots: jsonSlots };
    if (reason !== null) {
      body['reason'] = reason;
    }
    res.status(200).json(body);
  },
);

function mapAvailabilityError(err: AvailabilityError): {
  status: number;
  body: { error: string };
} {
  switch (err.kind) {
    case 'past_date':
      return { status: 400, body: { error: 'past_date' } };
    case 'outside_30d_window':
      return { status: 400, body: { error: 'outside_30d_window' } };
    case 'doctor_not_found':
      return { status: 404, body: { error: 'doctor_not_found' } };
    case 'branch_not_found':
      return { status: 404, body: { error: 'branch_not_found' } };
    case 'doctor_not_at_branch':
      return { status: 400, body: { error: 'doctor_not_at_branch' } };
    case 'doctor_inactive':
      return { status: 400, body: { error: 'doctor_inactive' } };
    case 'branch_inactive':
      return { status: 400, body: { error: 'branch_inactive' } };
    case 'appointment_type_not_found':
      return {
        status: 404,
        body: { error: 'appointment_type_not_found' },
      };
    case 'appointment_type_inactive':
      return {
        status: 400,
        body: { error: 'appointment_type_inactive' },
      };
  }
}