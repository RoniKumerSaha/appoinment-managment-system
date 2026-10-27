/**
 * Express app factory (no side effects on import).
 *
 * `server.ts` is the runnable entry that binds to PORT. Tests import this
 * module directly so importing does NOT start listening on a real port.
 *
 * `opts.requestLogger` (optional) lets a test inject a `pinoHttp()` instance
 * wired to an in-memory destination so the JSON log line can be captured
 * without depending on stdout interception (which is unreliable on Windows
 * where SonicBoom writes via the fd-1 path directly). Production callers
 * omit this and get the production `requestLogger`.
 *
 * `opts.smsOtpService` (optional) lets a test inject the SmsOtpService
 * with a stub provider. Production callers construct the service in
 * `server.ts` from the env and pass it in. If omitted, the SMS OTP router
 * is NOT registered.
 *
 * Mock-OTP route registration is gated on `NODE_ENV ∈ {development, test}`
 * via `loadAuthConfig().mockOtpAllowed`. E0-S4 removes the mock — the
 * real SMS OTP gateway replaces it. The mock flag stays in `AuthConfig`
 * for one story to keep the diff visible; it is unused by `createApp()`
 * and documented as `@deprecated`.
 */
import express from 'express';
import type { RequestHandler } from 'express';
import { healthRouter } from './routes/health.js';
import { metricsRouter } from './routes/metrics.js';
import { patientOtpRouter } from './routes/patient-otp.js';
import { authStaffRouter, authMeRouter } from './routes/auth-staff.js';
import { createSmsOtpRouter } from './routes/sms-otp.js';
import { adminClinicRouter } from './routes/admin-clinic.js';
import { adminBranchesRouter } from './routes/admin-branches.js';
import { adminBranchHoursRouter } from './routes/admin-branch-hours.js';
import { adminBranchDoctorsRouter } from './routes/admin-branch-doctors.js';
import { adminBranchReceptionistsRouter } from './routes/admin-branch-receptionists.js';
import { adminDoctorScheduleRouter } from './routes/admin-doctor-schedule.js';
import { adminDoctorBlockRouter } from './routes/admin-doctor-block.js';
import { adminAppointmentTypesRouter } from './routes/admin-appointment-types.js';
import { adminStatsRouter } from './routes/admin-stats.js';
import { adminStaffPasswordRouter } from './routes/admin-staff-password.js';
import { availabilityRouter } from './routes/availability.js';
import { publicCatalogRouter } from './routes/public-catalog.js';
import { bookingsRouter } from './routes/bookings.js';
import { patientProfileRouter } from './routes/patient-profile.js';
import { patientAppointmentsRouter } from './routes/patient-appointments.js';
import { patientRecurringSeriesRouter } from './routes/patient-recurring-series.js';
import { patientCancelRouter } from './routes/patient-cancel.js';
import { patientRescheduleRouter } from './routes/patient-reschedule.js';
import { patientDeepLinkRouter } from './routes/patient-deep-link.js';
import { staffMarkStatusRouter } from './routes/staff-mark-status.js';
import { staffDoctorCancelRouter } from './routes/staff-doctor-cancel.js';
import { staffReceptionistCancelRouter } from './routes/staff-receptionist-cancel.js';
import { receptionistTodayRouter } from './routes/receptionist-today.js';
import { receptionScheduleRouter } from './routes/reception-schedule.js';
import { recurringPreviewRouter } from './routes/recurring-preview.js';
import { recurringConfirmRouter } from './routes/recurring-confirm.js';
import { staffDoctorMoveRouter } from './routes/staff-doctor-move.js';
import { doctorAffectedRouter } from './routes/doctor-affected.js';
import { doctorRecurringSeriesRouter } from './routes/doctor-recurring-series.js';
import { doctorAppointmentAuditRouter } from './routes/doctor-appointment-audit.js';
import { receptionAppointmentAuditRouter } from './routes/reception-appointment-audit.js';
import { adminAuditRouter } from './routes/admin-audit.js';
import { authMiddleware } from './middleware/auth.js';
import { wrapRouter } from './middleware/async-handler.js';
import { adminScope } from './middleware/admin-scope.js';
import { getLogger, requestLogger } from './middleware/log.js';
import { loadAuthConfig } from './auth/config.js';
import type { SmsOtpService } from './otp/service.js';

export interface CreateAppOptions {
  requestLogger?: RequestHandler;
  smsOtpService?: SmsOtpService;
}

// Express 4 does not await route handlers, so a `throw` after an `await`
// becomes an unhandled rejection — and this codebase's `unhandledRejection`
// handler calls `process.exit(1)`. Wrapping every router's handlers makes
// a failed request answer 500 for that client alone instead of taking the
// whole API down. The wrapper is idempotent, so `createApp()` may be
// called more than once (the test suite does).
for (const router of [
  healthRouter,
  metricsRouter,
  patientOtpRouter,
  authStaffRouter,
  authMeRouter,
  publicCatalogRouter,
  availabilityRouter,
  bookingsRouter,
  patientProfileRouter,
  patientAppointmentsRouter,
  patientCancelRouter,
  patientRescheduleRouter,
  patientDeepLinkRouter,
  staffMarkStatusRouter,
  staffDoctorCancelRouter,
  staffReceptionistCancelRouter,
  receptionistTodayRouter,
  recurringPreviewRouter,
  recurringConfirmRouter,
  staffDoctorMoveRouter,
  doctorAffectedRouter,
  doctorRecurringSeriesRouter,
  doctorAppointmentAuditRouter,
  receptionAppointmentAuditRouter,
  adminAuditRouter,
  adminClinicRouter,
  adminBranchesRouter,
  adminBranchHoursRouter,
  adminBranchDoctorsRouter,
  adminBranchReceptionistsRouter,
  adminDoctorScheduleRouter,
  adminDoctorBlockRouter,
  adminAppointmentTypesRouter,
  adminStatsRouter,
]) {
  wrapRouter(router);
}

export function createApp(opts: CreateAppOptions = {}): express.Express {
  const logMw = opts.requestLogger ?? requestLogger;
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  app.use(logMw);

  app.use(healthRouter);
  app.use(metricsRouter);

  // SMS-OTP router mounts BEFORE authMiddleware so an unauthenticated
  // caller can hit the login routes. The routes are themselves the auth
  // gate (the OTP is the credential). Body-parser is also above this
  // point so the routes can read `req.body`.
  if (opts.smsOtpService) {
    app.use('/patient', wrapRouter(createSmsOtpRouter({ service: opts.smsOtpService })));
  }

  // Mock-OTP router mounts BEFORE authMiddleware for backward compatibility
  // with E0-S3's test suite. The mock stays for one story per the E0-S4
  // spec; E4-S1 will delete it when the real OTP modal lands.
  let mockOtpAllowed = false;
  try {
    mockOtpAllowed = loadAuthConfig().mockOtpAllowed;
  } catch {
    // If config fails to load (missing AUTH_SECRET), skip the mock-OTP
    // registration. Production boots will still fail-fast via server.ts's
    // explicit `loadAuthConfig()` call before `createApp()`.
  }
  if (mockOtpAllowed) {
    app.use('/patient', patientOtpRouter);
  }

  // Staff login — `POST /auth/login/staff`. Mounted BEFORE authMiddleware
  // so the login route is its own auth gate. There is no credential check
  // today (deferred W10a — password/SSO); the route gates on the caller's
  // knowledge of the seeded email. A future hardening story adds a real
  // credential check before this endpoint is exposed in production.
  app.use('/auth', authStaffRouter);

  app.use(authMiddleware);

  // `GET /auth/me` — rehydrate the session from the JWT. Mounted AFTER
  // authMiddleware so req.auth.claim is populated. Used by the web client
  // on boot to confirm a token in localStorage is still valid.
  app.use('/auth', authMeRouter);

  // Public catalog routes — `GET /public/{doctors,branches,appointment-types}`.
  // Mounted AFTER authMiddleware so req.auth.claim is populated. Used by
  // the patient booking flow (E3-ui). Open to any authenticated caller;
  // no adminScope. Returns only active rows.
  app.use(publicCatalogRouter);

  // Availability route — mounted AFTER authMiddleware so req.auth.claim
  // is populated. Open to any authenticated caller (no adminScope).
  app.use(availabilityRouter);

  // Bookings route — POST /bookings. Atomic create; GIST-protected.
  // Same auth gate as availability: open to any authenticated caller.
  app.use(bookingsRouter);

  // Patient profile route — GET /patient/profile?phone=<e164>. Read-only
  // probe for returning-patient detection (E3-S3).
  app.use(patientProfileRouter);

  // Patient self-service appointments — GET /patient/appointments.
  // Returns the verified patient's upcoming Scheduled rows (FR-032).
  // Phone is bound from req.auth.claim.sub, never from the body or a
  // query param (E7-S3 privacy filter). Mounted AFTER authMiddleware
  // since the route requires a verified patient JWT.
  app.use(patientAppointmentsRouter);

  // Patient recurring series — GET /patient/recurring-series.
  // Lists the patient's recurring series with EVERY occurrence
  // (E6-S4, mock 33) so the per-occurrence cancel surface can show
  // the siblings that a single cancel will not touch (BR-052 /
  // FR-049). Phone is bound from req.auth.claim.sub — E7-S3
  // privacy filter. Mounted AFTER authMiddleware.
  app.use(patientRecurringSeriesRouter);

  // Patient self-service cancel — POST /patient/appointments/:id/cancel.
  // Verified patient cancels their own Scheduled appointment (F-04,
  // FR-033). Atomic: SELECT FOR UPDATE + UPDATE + audit INSERT in a
  // single transaction. Privacy filter (E7-S3): same 404 envelope for
  // "doesn't exist" and "exists but not yours". Terminal states return
  // a distinct envelope `not_found_appointment_in_terminal_state` so the
  // UI can surface WHY to the patient.
  app.use(patientCancelRouter);

  // Patient self-service reschedule — POST
  // /patient/appointments/:id/reschedule. Verified patient reschedules
  // their own Scheduled appointment (F-05, FR-039…043). Doctor is
  // LOCKED (FR-040, BR-042 — the body schema never accepts
  // `new_doctor_id`); branch, type, date, time may all change (FR-041).
  // Atomic two-slot transaction: SELECT FOR UPDATE the existing row,
  // in-txn re-check the new slot (re-uses the E3-S1 pipeline), UPDATE
  // the row, INSERT the audit row with `payload={from, to,
  // branch_change, type_change}` per F-05. On any failure the original
  // row is untouched (FR-043).
  app.use(patientRescheduleRouter);

  // Patient deep-link entry — GET /patient/appointments/:id/deep-link.
  // Verified patient looks up metadata for a staff-generated deep
  // link (E4-S4). The route is a routing hint: it confirms the link
  // target is valid for the verified patient and returns a 404 if not.
  // Privacy filter (E7-S3 + NFR-007): single-statement lookup keyed
  // by `(id, patient_phone = claim.sub)` — same 404 envelope for
  // "doesn't exist" and "exists but not yours". The route is NOT the
  // cancel or reschedule executor; E4-S2 / E4-S3 do that.
  app.use(patientDeepLinkRouter);

  // Staff mark-status — POST /appointments/:id/mark-status.
  // Doctor or receptionist marks an appointment as Completed or
  // No-Show (E5-S1, F-10). Mounted AFTER authMiddleware; the route
  // is the role gate. Body schema is the only input.
  app.use(staffMarkStatusRouter);

  // Staff doctor cancel — POST /appointments/:id/cancel.
  // Doctor cancels a Scheduled appointment on behalf of a patient
  // (E5-S2, F-10 Cancel branch). Reason is required (BR-037 /
  // FR-035). Mounted AFTER authMiddleware; the route is the
  // doctor-only role gate. The patient flow lives under
  // /patient/appointments/:id/cancel (E4-S2); the receptionist
  // flow lives at E5-S3.
  app.use(staffDoctorCancelRouter);

  // Staff receptionist cancel — POST /reception/appointments/:id/cancel.
  // Receptionist cancels a Scheduled appointment at their branch
  // on behalf of a patient (E5-S3, F-14). Reason is required
  // (BR-036 / FR-034). Mounted AFTER authMiddleware; the route
  // is the receptionist-only role gate. The path is intentionally
  // NOT `/appointments/:id/cancel` to avoid colliding with the
  // doctor route's role gate.
  app.use(staffReceptionistCancelRouter);

  // Receptionist today dashboard — GET /reception/branch/today.
  // Read-only list of today's appointments for the receptionist's
  // assigned branch (E5-S4, F-12, BR-063). Branch is locked to
  // claim.branch_ids[0] server-side; cross-branch URLs return
  // the receptionist's branch data, never the requested branch
  // (Scenario 11). Mounted AFTER authMiddleware.
  app.use(receptionistTodayRouter);

  // Receptionist day schedule — GET /reception/branch/schedule.
  // The booked half of the receptionist's availability calendar
  // (F-15). `GET /availability` returns only open slots, so the
  // booked slots need their own read. Patient identity is limited
  // to a first-name initial (F-15). Branch is locked to
  // claim.branch_ids[0] server-side. Mounted AFTER authMiddleware;
  // the route is the receptionist-only role gate.
  app.use(receptionScheduleRouter);

  // Recurring preview — POST /recurring/preview. Doctor or
  // receptionist previews a recurring series (E6-S1, F-11,
  // BR-047…053, FR-044…050). Read-only: validates every
  // occurrence in isolation and returns {will_create,
  // skipped_with_reason}. Patient / admin → 403 (FR-045).
  // Mounted AFTER authMiddleware.
  app.use(recurringPreviewRouter);

  // Recurring confirm — POST /recurring/confirm. Atomic batch
  // insert of the preview's valid occurrences (E6-S1, FR-047,
  // FR-050). All occurrences of a single confirm share the same
  // recurring_series_id. Mounted AFTER authMiddleware; the route
  // is the role gate.
  app.use(recurringConfirmRouter);

  // Staff doctor move — POST /doctor/affected/:id/move.
  // Doctor moves a Scheduled appointment to a new slot on
  // behalf of conflict resolution (E6-S2, F-09, BR-054…058,
  // FR-011). The doctor is the only actor that "moves" an
  // appointment; type is locked (BR-058); branch may change
  // to any branch the doctor works at (BR-057). Mounted AFTER
  // authMiddleware; the route is the doctor-only role gate.
  app.use(staffDoctorMoveRouter);

  // Doctor affected queue — GET /doctor/affected.
  // Read-only list of the doctor's Scheduled appointments
  // that fall outside the current branch_weekly_hours for
  // the appointment's branch (E6-S3, F-09). The "Resolve"
  // badge on the doctor dashboard reads this list and links
  // each row to E6-S2's POST /doctor/affected/:id/move.
  // Mounted AFTER authMiddleware; the route is the
  // doctor-only role gate.
  app.use(doctorAffectedRouter);

  // Doctor recurring series read — GET
  // /doctor/recurring-series/:id (mock 40). Lists the
  // occurrences of a recurring series the doctor created, plus the
  // audit trail, so the back-out screen can show what is already on
  // the books. Scoped to the doctor's OWN series — another
  // doctor's series returns the same 404 as a non-existent one.
  // Mounted AFTER authMiddleware; the route is the doctor-only
  // role gate.
  app.use(doctorRecurringSeriesRouter);

  // Doctor appointment audit read — GET
  // /doctor/appointments/:id/audit (E7-S2, FR-051, NFR-005).
  // Doctor reads audit rows for their OWN appointments (cross-
  // doctor reads → 403 outside_branch_scope). Mounted AFTER
  // authMiddleware; the route is the doctor-only role gate.
  app.use(doctorAppointmentAuditRouter);

  // Receptionist appointment audit read — GET
  // /reception/appointments/:id/audit (E7-S2, FR-051,
  // NFR-005). Receptionist reads audit rows for
  // appointments at THEIR branch (cross-branch reads →
  // 403 outside_branch_scope). Mounted AFTER
  // authMiddleware; the route is the receptionist-only
  // role gate.
  app.use(receptionAppointmentAuditRouter);

  // Admin audit policy envelope — GET /admin/audit (E7-S2).
  // Returns the policy envelope documenting WHY the admin
  // role does not read individual appointment audits (PRD
  // §2.4 — admin never touches individual appointments).
  // Mounted AFTER authMiddleware; the route is the
  // admin-only role gate.
  app.use(adminAuditRouter);

  // Admin routes — mounted AFTER authMiddleware. Chained router-level
  // middleware means adminScope gates only `/admin/*`, not every path.
  // The mount order mirrors the E0-S3 convention: authenticated routers
  // (admin) come after the auth middleware, public routers (health,
  // metrics, OTP) before it.
  app.use('/admin', adminScope, adminClinicRouter, adminBranchesRouter, adminBranchHoursRouter, adminBranchDoctorsRouter, adminBranchReceptionistsRouter, adminDoctorScheduleRouter, adminDoctorBlockRouter, adminAppointmentTypesRouter, adminStatsRouter, adminStaffPasswordRouter);

  // JSON 404 fallthrough — kept after the routers so a matching route wins;
  // every other path returns a stable JSON error envelope (no HTML default).
  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction,
    ) => {
      // express.json() throws a SyntaxError with `type === 'entity.parse.failed'`
      // when the request body is malformed JSON. That's a client error
      // (4xx), not a server error — surface it as 400 invalid_json instead
      // of the generic 500 (P-A5 from E1-S1 review).
      const parseErr = err as { type?: string; statusCode?: number };
      if (
        err instanceof SyntaxError &&
        parseErr.type === 'entity.parse.failed'
      ) {
        res.status(400).json({ error: 'invalid_json' });
        return;
      }
      const message = err instanceof Error ? err.message : 'unknown_error';
      getLogger().error({ err: message }, 'request_failed');
      res.status(500).json({ error: 'internal_error' });
    },
  );

  return app;
}
