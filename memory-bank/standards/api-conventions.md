# API Conventions

## Overview

The API is an Express 4 app over PostgreSQL. There is no service layer
and no repository layer: a route handler owns the transaction, the SQL,
the role gate and the audit write in one function. This file records
the HTTP contract that the web client depends on, and the conventions
that make the routes predictable.

**The API is the single source of truth for availability.** The UI
shows slots; only the server may grant or release one.

## Route families

One file per route family, kebab-case, domain-prefixed. Helpers live
in a `-helpers.ts` sibling.

| Prefix | Family | Auth |
|---|---|---|
| `/healthz`, `/readyz` | `routes/health.ts` | none |
| `/metrics` | `routes/metrics.ts` | none |
| `/patient/otp/send`, `/patient/otp/verify` | `routes/sms-otp.ts` | none — it *is* the authentication step |
| `/patient/otp/verify-now` | `routes/patient-otp.ts` | none — mock OTP, dev/test only |
| `/auth/login/staff` | `routes/auth-staff.ts` | none — it *is* the authentication step |
| `/auth/me` | `routes/auth-staff.ts` | authenticated |
| `/availability` | `routes/availability.ts` | authenticated |
| `/bookings` | `routes/bookings.ts` | authenticated |
| `/appointments/:id/mark-status`, `/appointments/:id/cancel` | `routes/staff-mark-status.ts`, `routes/staff-doctor-cancel.ts` | doctor / receptionist |
| `/reception/*` | `routes/receptionist-today.ts`, `routes/reception-schedule.ts`, `routes/staff-receptionist-cancel.ts`, `routes/reception-appointment-audit.ts` | receptionist, branch-scoped |
| `/doctor/*` | `routes/doctor-affected.ts`, `routes/staff-doctor-move.ts`, `routes/doctor-appointment-audit.ts`, `routes/doctor-recurring-series.ts` | doctor |
| `/patient/*` | `routes/patient-appointments.ts`, `routes/patient-cancel.ts`, `routes/patient-reschedule.ts`, `routes/patient-deep-link.ts`, `routes/patient-profile.ts`, `routes/patient-recurring-series.ts` | patient, `claim.sub` = phone |
| `/public/*` | `routes/public-catalog.ts` | none (public catalog) |
| `/staff-catalog/*` | `routes/staff-catalog.ts` | any authenticated caller |
| `/recurring/preview`, `/recurring/confirm` | `routes/recurring-preview.ts`, `routes/recurring-confirm.ts` | authenticated |
| `/admin/*` | `routes/admin-*.ts` | `adminScope` — admin only |

### Two catalogs, deliberately

`/public/*` and `/staff-catalog/*` return **the same DTO shapes** as
the `/admin/*` catalog routes, but with different gates:

- `/public/*` — no authentication at all. Used by the patient flow.
- `/staff-catalog/*` — any authenticated caller.

This exists because the doctor and receptionist screens originally
called the `/admin/*` catalog routes, which are gated by `adminScope`
and return `403 forbidden_role` for a doctor or receptionist. The
pickers silently stayed **empty**, which broke the walk-in booking
flow, the availability browser and the doctor's recurring-series form
for exactly the two roles that use them. Keep the DTOs identical so the
client-side filtering logic stays in one place.

### The Vite proxy map

The dev server proxies a fixed set of path prefixes to `:3001`. **A
prefix missing from that map is not proxied** — Vite answers from the
SPA fallback and returns a 404 with an HTML body, which the client
surfaces as `api_404:unknown_error`.

When adding a route family, add its prefix to `apps/web/vite.config.ts`
in the same change.

## Authentication

`Authorization: Bearer <jwt>` on every authenticated route. The JWT
is hand-rolled HS256; see `system-architecture.md` for the claim shape
and the verification order.

**There is no refresh mechanism.** No refresh token, no refresh
endpoint, no refresh claim. The client treats a token as expired 60
seconds before its actual expiry and signs the user out.

The dev-only `x-auth-claim` header is a **client-side** fallback for
the case where no session exists at all — it is never sent when a
session exists but is unusable. See `apps/web/src/api/client.ts:176-190`
for the three-way branch (`none` / `expired` / `valid`) and the reason
an expired session must send *no* credential.

## Authorization

The request body is **never** consulted for `role`, `branch_ids`,
`scope` or `doctor_id`. Only the verified claim is.

Scope semantics:

| Role | Bound by | Out-of-scope response |
|---|---|---|
| Patient | `claim.sub` (the phone number) | `404 not_found` |
| Doctor | `claim.doctor_id` **and** `branch_id ∈ claim.branch_ids` | `403 outside_branch_scope` |
| Receptionist | `branch_id ∈ claim.branch_ids` | `403 outside_branch_scope` |
| Admin | clinic-wide | — |

**"404 not 403" is a patient-only privacy filter**, not a general rule.
`routes/patient-cancel.ts:136-140` returns the *same* envelope for
"does not exist" and "exists but is not yours", because a 403 would
confirm the appointment exists. Staff flows deliberately return 403
instead — the staff audience already knows the appointment exists.

Admin authority over individual appointments is enforced by
**omission**: no appointment routes are mounted under `/admin`.
`GET /admin/audit` returns a **200 policy envelope**, not an error and
not data:

```json
{
  "appointments_audit_reads": "rejected_per_role_policy",
  "reason": "PRD §2.4 — …",
  "reference": "per_appointment_audit_see_doctor_reception_routes",
  "doctor_endpoint": "GET /doctor/appointments/:id/audit",
  "receptionist_endpoint": "GET /reception/appointments/:id/audit",
  "future_work": "configuration-level audit … is deferred (W51)."
}
```

The route exists so the admin "Audit" tab has a surface to land on
without a 4xx fall-through.

## Validation

**Hand-rolled, per route.** There is no validation library (zod/yup) and
no shared validator.

The house style:

1. Read the field as `unknown` off `req.body`.
2. Narrow with a local type-guard function (`isValidName`,
   `isValidUuid`, `isValidActive`, …) declared near the top of the file.
3. Reject with `400` and a specific snake_case code.

```ts
function isValidName(name: unknown): name is string {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  return trimmed.length >= NAME_MIN && trimmed.length <= NAME_MAX;
}
```

Rules that hold across routes:

- **Trim, then length-check.** A name of `"   "` would otherwise pass
  the length check and render as invisible whitespace.
- **Booleans are `typeof value === 'boolean'`** — not `'true'`, not
  `1`, not `'maybe'`.
- **UUIDs are rejected before any DB lookup** by a `UUID_RE` test.
- **Unknown body fields are rejected** with
  `400 unknown_field` + a `fields` array naming them
  (`admin-appointment-types.ts:146`).
- **Timezone strings** are checked against a real IANA list
  (`isValidTimezone` in `admin-branch-hours-helpers.ts`).
- **Timestamps** are ISO-8601 with an explicit offset. Dates are
  `YYYY-MM-DD` in the **branch's** timezone.

## Response shapes

There is no single envelope. Three shapes coexist, and the split is
by route family rather than random:

| Shape | Example | Where |
|---|---|---|
| **Bare array** | `GET /admin/branches` → `BranchDto[]` | Admin CRUD list endpoints |
| **Single-key wrapper** | `GET /admin/branches/:id/hours` → `{ branch_id, tz, address, hours }`; `POST /bookings` → `{ appointment }`; `GET /public/doctors` → `{ doctors }` | Domain reads and mutations |
| **Object** | `GET /admin/stats` → `{ branches, doctors, receptionists, appointment_types }`; `GET /reception/branch/today` → `{ date, branch, filters, appointments }` | Composite / dashboard reads |

The rule of thumb: **a list is wrapped when it is a sub-resource of
something else** (`{ doctors }`, `{ blocks }`, `{ branches }`,
`{ appointment_types }`), and **bare when it is the resource itself**
(`BranchDto[]`, `DoctorWithBranchesDto[]`).

Both shapes are acceptable in one file, but be consistent within a
route family.

### 204

Used exactly once — `DELETE /admin/doctors/:id/blocks/:blockId`
returns `204` with no body.

## The error envelope

A **flat** object with a snake_case `error` code:

```json
{ "error": "outside_branch_scope" }
```

Some codes carry sibling fields when the client needs them:

| Sibling | Example |
|---|---|
| `impact` | `{ error: 'appointments_outside_hours', impact: { count_affected, affected, affected_doctors, requires_doctor_acknowledgement } }` (409) |
| `fields` | `{ error: 'unknown_field', fields: ['foo'] }` (400) |
| `warning` + `future_appointment_count` | on a doctor / receptionist / appointment-type PATCH that deactivated an entity with future appointments (200, not an error) |
| `retry_after_ms` | `{ error: 'otp_locked', retry_after_ms: 30000 }` (429) |

`apps/web/src/api/client.ts` types the body as
`ApiErrorBody { error?, fields?, impact?, warning?, future_appointment_count?, [key: string]: unknown }` and raises `ApiError(status, code, body)` for every non-2xx.

### Error codes

The API emits **103 distinct error codes**. They are snake_case and
domain-namespaced by prefix:

| Prefix / pattern | Examples |
|---|---|
| `invalid_*` | `invalid_branch_id`, `invalid_name`, `invalid_status`, `invalid_otp_code`, `invalid_patient_phone`, `invalid_timezone`, `invalid_schedule_row` |
| `not_found` / `*_not_found` | `not_found`, `doctor_not_found`, `branch_not_found`, `patient_not_found`, `preview_not_found`, `block_not_found` |
| `forbidden_*` / `*_scope` | `forbidden_role`, `outside_branch_scope` |
| `*_inactive` / `*_active` | `doctor_inactive`, `branch_inactive`, `appointment_type_inactive`, `invalid_active_filter` |
| Terminal state | `already_in_terminal_state`, `not_found_appointment_in_terminal_state`, `appointment_in_past`, `appointment_in_future` |
| Conflict | `slot_raced`, `patient_has_future_with_doctor`, `patient_time_conflict`, `appointments_outside_hours`, `block_overlaps_future_appointments`, `schedule_invalidates_future_appointments`, `schedule_rows_overlap`, `branch_has_future_appointments` |
| OTP | `otp_expired`, `otp_locked`, `otp_cooldown`, `invalid_code`, `no_outstanding_otp`, `sms_send_failed` |
| Invariant | `clinic_row_missing`, `branch_row_missing`, `internal_error` |

**New codes must be snake_case and specific.** `invalid_branch_id`
tells the client what to fix; `bad_request` does not.

## Status codes

In use across the API:

| Status | Count | Use |
|---|---|---|
| `200` | 61 | Success with a body |
| `201` | 5 | Resource created (admin CRUD) |
| `204` | 1 | Resource deleted (doctor block) |
| `400` | 139 | Validation failure |
| `401` | 37 | Unauthenticated / expired token |
| `403` | 43 | Authenticated but out of scope |
| `404` | 61 | Not found (or patient privacy filter) |
| `409` | 14 | Conflict — slot raced, schedule invalidates an appointment |
| `415` | 2 | Unsupported media type |
| `422` | 7 | Semantically invalid but well-formed — a terminal-state appointment, a future appointment, a no-op move |
| `429` | 3 | Rate limited / OTP locked |
| `500` | 81 | Server defect — invariant violation, CHECK constraint violation |
| `502` | 1 | Upstream failure |
| `503` | 2 | Dependency unavailable (e.g. the SMS provider) |

**`410` is not used.** A gone appointment returns `404` with a terminal-state code.

The `400` / `422` split: **400 means the request is malformed** (bad
uuid, bad name, unknown field); **422 means the request is well-formed
but the operation is not legal right now** (`already_in_terminal_state`,
`appointment_in_future`, `no_op_move`).

## SQLSTATE → HTTP

Database errors are translated, never leaked:

| SQLSTATE | Meaning | Response |
|---|---|---|
| `23P01` | GIST exclusion violation (double-booking) | `409 slot_raced` |
| `23505` | Unique violation (patient has a future appointment with the same doctor) | `409 patient_has_future_with_doctor` |
| `40P01` / `40001` | Deadlock / serialization failure | `409 slot_raced` |
| `23514` | CHECK constraint violation | `500` — a server defect, not a user error |

The catch block lives in `routes/bookings.ts:709-753`.

## Transactions

Route handlers that write own their transaction inline:

```ts
await client.query('BEGIN');
// work
await client.query('COMMIT');
```

Rules that hold:

- `pool.connect()` is caught **separately** from the transaction body,
  because `client` would be unassigned in the `finally` if the connect
  itself failed.
- A **read-only failure inside a transaction still COMMITs** — the
  availability engine returns `{ kind: 'err', error }` after a
  `COMMIT`, not a `ROLLBACK`. There is nothing to undo.
- `ROLLBACK` is reserved for genuine aborts.
- `client.release()` is always in the `finally`.

The canonical pattern is repeated across the API; see
`data-stack.md` for the full template.

## Audit

Important appointment events write an `appointment_audit` row inside
the same transaction as the state change. Audit writes are **not**
best-effort — if the audit insert fails, the whole transaction rolls
back.

Audit rows carry `appointment_id`, `actor_role`, `actor_id`,
`event` and `payload`. The `actor_id` is namespaced by role:
`staff:<sub>` for staff, the raw phone for a patient.

Events seen in the codebase: `marked_completed`, `marked_no_show`,
`booked`, `rescheduled`, `moved`, `cancelled`, `created`,
`block_created`, `block_deleted`, `schedule_changed`, `resolved`.

## Logging

See `coding-standards.md` § Logging. The essentials for a route author:

- Get the logger with `getLogger()` **at the call site**, never by
  importing a `logger` binding.
- `err` is always a string: `err instanceof Error ? err.message : String(err)`.
- Event names are snake_case and domain-namespaced.
- Never log an authorization header, cookie, password, phone number
  or OTP code.

## Pagination

**There is no pagination.** No `limit` / `offset` / `cursor` parameters
on any read route.

Three read paths silently cap their rows, and the cap is a server-side
constant rather than a parameter:

| Path | Cap |
|---|---|
| `GET /doctor/appointments/:id/audit` | `MAX_AUDIT_ROWS = 200` |
| `GET /reception/appointments/:id/audit` | `MAX_AUDIT_ROWS = 200` |
| `GET /doctor/recurring-series/:id` | Series occurrences, bounded by the series length |

The audit drawers do **client-side** filtering over that full window.

## Versioning

**No API versioning.** No `/v1` prefix, no `Accept` negotiation, no
deprecation headers. The path prefix (`/admin`, `/doctor`,
`/patient`, `/reception`) is the only grouping.

## Enforcing the async contract

Express 4 does not await async handlers. A `throw` after an `await`
becomes an unhandled rejection, which Node escalates to
`process.exit(1)` — the whole API dies, with no error response.

`apps/api/src/middleware/async-handler.ts` wraps every handler so
rejections reach `next(err)`.

> **Every new router must be registered in the `wrapRouter` loop at
> `apps/api/src/app.ts:82-119`.** A router that is not in that array
> will kill the process on the first rejected promise.
