/**
 * Patient profile routes — `GET /patient/profile?phone=<e164>`.
 *
 * Per spec-3-3 (E3-S3), the server-side probe that returns the patient's
 * stored `full_name` when a phone number is already on file. Clients call
 * this when the patient tabs off the phone field on the booking form:
 *   - 200 → the patient is "returning", pre-fill the name field, lock
 *     the phone field, submit POST /bookings (E3-S2's flow).
 *   - 404 → the patient is "new", clear the name field, submit POST
 *     /bookings with the typed-in name (E3-S2's flow).
 *
 * Phone is the patient key (FR-022) — there is no separate
 * patient-id surface. The returned row is `{phone_number, full_name}`
 * only; the `patient` schema has no other columns today. No masking
 * needed (the patient is typing their own phone).
 *
 * Auth: any authenticated caller (patient, receptionist, doctor, admin).
 * The receptionist path (E3-S4) uses this same endpoint to detect
 * whether a phone is on file before collecting name + booking.
 *
 * No rate limiting in this story; deferred to E7-S3 (patient privacy
 * filter) which owns anti-enumeration controls.
 */
import { Router, type Request, type Response } from 'express';
import { getPool } from '../db/pool.js';
import { getLogger } from '../middleware/log.js';
import { isValidE164Phone } from './bookings-helpers.js';

const SELECT_PATIENT_SQL = `
  SELECT phone_number, full_name
    FROM patient
   WHERE phone_number = $1;
`;

export const patientProfileRouter: Router = Router();

patientProfileRouter.get(
  '/patient/profile',
  async (req: Request, res: Response): Promise<void> => {
    const claim = req.auth?.claim ?? null;
    if (!claim) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }

    const phoneRaw = req.query['phone'];
    const phone = typeof phoneRaw === 'string' ? phoneRaw.trim() : '';

    if (phone.length === 0) {
      res.status(400).json({ error: 'missing_patient_phone' });
      return;
    }
    if (!isValidE164Phone(phone)) {
      res.status(400).json({ error: 'invalid_patient_phone' });
      return;
    }

    try {
      const pool = await getPool();
      const { rows } = await pool.query<{
        phone_number: string;
        full_name: string | null;
      }>(SELECT_PATIENT_SQL, [phone]);
      if (rows.length === 0) {
        res.status(404).json({ error: 'patient_not_found' });
        return;
      }
      const row = rows[0]!;
      res.status(200).json({
        patient: {
          phone_number: row.phone_number,
          full_name: row.full_name,
        },
      });
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'patient_profile_lookup_failed',
      );
      throw err;
    }
  },
);