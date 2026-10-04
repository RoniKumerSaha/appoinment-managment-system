/**
 * Admin audit policy envelope — `GET /admin/audit`.
 *
 * Per spec-7-2 (E7-S2) + PRD §2.4 + NFR-005:
 * The admin role has NO appointment-audit read endpoint.
 * PRD §2.4 ("Administrator role scope") explicitly excludes
 * individual-appointment reads from the admin role. The
 * admin reads *configuration* audit (Doctor / DoctorBranch /
 * Branch / Receptionist / schedule / block / branch-hours),
 * but those audit tables don't exist yet (E1-S1 / E1-S2 set
 * the precedent of no admin audit; the audit table from
 * E7-S2 covers appointments only).
 *
 * This route exists so the admin's "Audit" tab has a
 * surface to land on. The 200 + policy envelope documents
 * WHY individual-appointment audit is not exposed. The admin
 * UI can show the explanatory text without a 4xx
 * fall-through.
 *
 * Auth: claim.role === 'admin' only. Other roles →
 * 403 forbidden_role. Anonymous → 401.
 *
 * Future hardening (W51 — deferred): add a
 * `configuration_audit` table and a
 * `GET /admin/configuration-audit` route so the admin can
 * read Doctor / Branch / Receptionist / schedule / block /
 * branch-hours configuration mutations.
 */
import { Router, type Request, type Response } from 'express';

export const adminAuditRouter: Router = Router();

adminAuditRouter.get(
  '/admin/audit',
  (req: Request, res: Response): void => {
    const claim = req.auth?.claim ?? null;
    if (!claim) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    if (claim.role !== 'admin') {
      // The /admin/* surface is admin-only.
      res.status(403).json({ error: 'forbidden_role' });
      return;
    }
    res.status(200).json({
      appointments_audit_reads: 'rejected_per_role_policy',
      reason:
        'PRD §2.4 — the administrator role does not read ' +
        'individual appointment audit data. The audit log is ' +
        'internal-only (NFR-005); doctors read audits for their ' +
        'own appointments and receptionists read audits at ' +
        'their branch.',
      reference: 'per_appointment_audit_see_doctor_reception_routes',
      doctor_endpoint: 'GET /doctor/appointments/:id/audit',
      receptionist_endpoint: 'GET /reception/appointments/:id/audit',
      future_work:
        'configuration-level audit (Doctor / Branch / ' +
        'Receptionist / schedule / block / branch-hours) is ' +
        'deferred (W51). When implemented, the route will be ' +
        'GET /admin/configuration-audit.',
    });
  },
);