/**
 * Patient deep-link entry — `GET /patient/appointments/:id/deep-link`.
 *
 * Per spec-4-4 (E4-S4), staff-generated deep links (MVP, out-of-app
 * delivery is out of scope) must land a verified patient directly on
 * the cancel or reschedule modal for a specific appointment id. The
 * route returns metadata about the link target so the client can
 * route the verified patient into the right modal after OTP
 * verification.
 *
 * The route is NOT the cancel or reschedule executor — those are
 * E4-S2 and E4-S3. The route is a routing hint: it confirms the link
 * target is valid for the verified patient and returns a 404 if not.
 *
 * Privacy (E7-S3 + NFR-007): the lookup is keyed by
 * `(id, patient_phone = claim.sub)` in a single SQL statement. A row
 * that exists but doesn't match the verified patient's phone returns
 * 0 rows → `404 not_found`, identical to a non-existent id. This
 * matches the privacy filter in E4-S2 / E4-S3.
 *
 * Auth: claim.role='patient' only. Doctor / admin / receptionist
 * JWTs → 403 (no deep-link entry from staff roles).
 */
import { Router, type Request, type Response } from 'express';
import { getPool } from '../db/pool.js';
import { getLogger } from '../middleware/log.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Combined existence + ownership check. The single-statement
// `WHERE id = $1 AND patient_phone = $2` makes the existence and
// ownership indistinguishable to a caller probing for other
// patients' appointments by id (E7-S3).
const SELECT_DEEP_LINK_TARGET_SQL = `
  SELECT a.id::text AS id,
         a.branch_id::text AS branch_id,
         a.doctor_id::text AS doctor_id,
         a.appointment_type_id::text AS appointment_type_id,
         a.start_datetime, a.end_datetime, a.status
    FROM appointment a
   WHERE a.id = $1::uuid
     AND a.patient_phone = $2;
`;

interface DeepLinkRow {
  id: string;
  branch_id: string;
  doctor_id: string;
  appointment_type_id: string;
  start_datetime: Date;
  end_datetime: Date;
  status: string;
}

export const patientDeepLinkRouter: Router = Router();

patientDeepLinkRouter.get(
  '/patient/appointments/:id/deep-link',
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
    if (!UUID_RE.test(id)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const pool = await getPool();
    let client;
    try {
      client = await pool.connect();
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'patient_deep_link_connect_failed',
      );
      throw err;
    }
    try {
      const { rows } = await client.query<DeepLinkRow>(
        SELECT_DEEP_LINK_TARGET_SQL,
        [id, claim.sub],
      );
      // E7-S3: 0 rows = doesn't exist OR exists but not yours. Same
      // envelope either way.
      if (rows.length === 0) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const appt = rows[0]!;
      // Only Scheduled rows are cancellable / reschedulable. Terminal
      // states return can_cancel:false / can_reschedule:false so the
      // client can render an "already X" state rather than a
      // tappable cancel/reschedule button.
      const canCancel = appt.status === 'Scheduled';
      const canReschedule = appt.status === 'Scheduled';
      res.status(200).json({
        appointment_id: appt.id,
        can_cancel: canCancel,
        can_reschedule: canReschedule,
        appointment: {
          id: appt.id,
          branch_id: appt.branch_id,
          doctor_id: appt.doctor_id,
          appointment_type_id: appt.appointment_type_id,
          start_datetime: appt.start_datetime.toISOString(),
          end_datetime: appt.end_datetime.toISOString(),
          status: appt.status,
        },
      });
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'patient_deep_link_failed',
      );
      throw err;
    } finally {
      client.release();
    }
  },
);