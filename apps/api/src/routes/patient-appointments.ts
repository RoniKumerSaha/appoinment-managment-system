/**
 * Patient self-service appointments — `GET /patient/appointments`.
 *
 * Per spec-4-1 (E4-S1), the verified patient's upcoming-appointments
 * list. The phone comes from the JWT claim (`req.auth.claim.sub`),
 * NEVER from a query param or body — this is the E7-S3 privacy filter:
 * a patient cannot enumerate another patient's appointments.
 *
 * Filter is server-side (FR-032): only `status='Scheduled' AND
 * start_datetime > now()` rows appear. Cancelled / Completed /
 * No-show / past rows are excluded at the DB layer. The response is
 * sorted by `start_datetime ASC` so the patient dashboard can render
 * a deterministic, time-ordered list.
 *
 * Auth: `claim.role === 'patient'` only. Doctor / admin / receptionist
 * JWTs → 403 forbidden_role. Each role has its own dashboard; cross-
 * role access is not part of E4-S1.
 *
 * Privacy: when a patient with no `patient` row hits this endpoint
 * (i.e. they have NEVER booked), the response is 200 `{appointments: []}`
 * — NOT 404. We never reveal whether a phone is on file; the OTP
 * verification is the gate. (E7-S3 explicitly requires this.)
 */
import { Router, type Request, type Response } from 'express';
import { getPool } from '../db/pool.js';
import { getLogger } from '../middleware/log.js';

// FR-032 filter — Cancelled / Completed / No-show / past all excluded
// at the DB layer. Phone is bound from claim.sub, never from the body
// or a query param (E7-S3 privacy filter).
const SELECT_UPCOMING_APPOINTMENTS_SQL = `
  SELECT a.id::text AS id,
         a.doctor_id::text AS doctor_id,
         a.branch_id::text AS branch_id,
         a.appointment_type_id::text AS appointment_type_id,
         a.start_datetime, a.end_datetime,
         a.status,
         b.tz
    FROM appointment a
    JOIN branch b ON b.id = a.branch_id
   WHERE a.patient_phone = $1
     AND a.status = 'Scheduled'
     AND a.start_datetime > now()
   ORDER BY a.start_datetime ASC;
`;

export const patientAppointmentsRouter: Router = Router();

interface AppointmentRow {
  id: string;
  doctor_id: string;
  branch_id: string;
  appointment_type_id: string;
  start_datetime: Date;
  end_datetime: Date;
  status: string;
  tz: string;
}

patientAppointmentsRouter.get(
  '/patient/appointments',
  async (req: Request, res: Response): Promise<void> => {
    const claim = req.auth?.claim ?? null;
    if (!claim) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    if (claim.role !== 'patient') {
      // Doctor / admin / receptionist each have their own dashboards;
      // cross-role access is out of scope for E4-S1.
      res.status(403).json({ error: 'forbidden_role' });
      return;
    }
    // The phone is bound from the JWT — no query param, no body field.
    // (E7-S3 privacy filter: patients cannot enumerate other phones.)
    const phone = claim.sub;

    try {
      const pool = await getPool();
      const { rows } = await pool.query<AppointmentRow>(
        SELECT_UPCOMING_APPOINTMENTS_SQL,
        [phone],
      );
      res.status(200).json({
        appointments: rows.map((r) => ({
          id: r.id,
          doctor_id: r.doctor_id,
          branch_id: r.branch_id,
          appointment_type_id: r.appointment_type_id,
          start_datetime: r.start_datetime.toISOString(),
          end_datetime: r.end_datetime.toISOString(),
          status: r.status,
          tz: r.tz,
        })),
      });
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'patient_appointments_list_failed',
      );
      throw err;
    }
  },
);