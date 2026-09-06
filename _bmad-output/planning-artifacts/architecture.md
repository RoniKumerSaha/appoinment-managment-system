# Architecture — Multi-Branch Clinic Appointment Scheduling System

> **BMad planning artifact.** The architectural spine: the invariants that keep features, epics, and stories consistent. Derived from `_bmad-output/planning-artifacts/prd.md` and `_bmad-output/planning-artifacts/ux.md`. This is the **what must be true** for any implementation to satisfy the design.
>
> The repository is currently design-only (`docs/` + `_bmad/`). Code has not landed. Therefore this is a **greenfield spine** that ratifies the design as the contract that future code must honor.
>
> **Update history:** 2026-09-06 — review-gate findings F1–F19 rolled in. Added `§11 Architecture Decisions` (AD-1 through AD-10) and targeted amendments to §1, §3, §4, §5, §6, §7, §9. See `_bmad-output/planning-artifacts/architecture-update-2026-09-06/.memlog.md` for the full decision log.

## Source documents

- Requirements: `_bmad-output/planning-artifacts/prd.md` (PRD) + `docs/specs/BRD.md`
- UX spec: `_bmad-output/planning-artifacts/ux.md` + `docs/design/DESIGN-SYSTEM.md`
- System flows: `docs/specs/UX-FLOWS.md` (F-01…F-19)
- Visual reference: `docs/design/mockups/v1/winners/`

---

## 1. Architectural principles

1. **The server is the single source of truth for availability.** UI shows slots; only the server may grant or release one. (UX-FLOWS §6.2)
2. **Atomicity over clever UX.** Booking and rescheduling use transactional slot reservation. No tentative holds client-side.
3. **Never silently invalidate an appointment.** Schedule/block changes that would conflict are **rejected**; branch-hours changes **save and flag** for manual resolution.
4. **Patient identity is a phone number.** No passwords, no accounts. Identity verification is SMS OTP, server-side filtered. **Prevents:** a patient from seeing or being matched to another patient's appointments.
5. **Branch-local time.** All branch hours and slot times are stored UTC and rendered in the *appointment's branch* timezone (per AD-9). UI labels always carry tz; the session's branch tz never relabels another branch's event.
6. **Role × Branch authorization is a server concern.** Receptionists are branch-scoped; doctors are self-scoped via a doctor-patient link table (per AD-8); admins don't see individual appointments. **Prevents:** cross-branch reads/writes by a receptionist (BR-063); admin visibility into individual appointments (BR-065); a doctor enumerating patient relationships beyond first-booking doctor-patient link.
7. **Audit by default.** Every important appointment and configuration event writes one audit row.
8. **The design system is a contract.** Token names in `DESIGN-SYSTEM.md` map 1:1 to CSS variables / theme tokens in code. Drift is a bug.

---

## 2. Component map

```
                          ┌────────────────────────────┐
                          │   Patient web (public)     │
                          │   /book, /manage           │
                          └─────────────┬──────────────┘
                                        │ HTTPS
                          ┌─────────────▼──────────────┐
                          │  Edge / API gateway         │
                          │  (auth, rate-limit, tz      │
                          │   normalization, CORS)      │
                          └─────────────┬──────────────┘
                                        │
        ┌───────────────────────────────┼───────────────────────────────┐
        │                               │                               │
┌───────▼────────┐             ┌────────▼────────┐             ┌────────▼────────┐
│  Doctor web    │             │ Receptionist web│             │  Admin web      │
│  (signed-in)   │             │ (signed-in,     │             │  (signed-in)    │
│                │             │  branch-scoped) │             │                 │
└───────┬────────┘             └────────┬────────┘             └────────┬────────┘
        │                               │                               │
        └───────────────────────────────┼───────────────────────────────┘
                                        │
                          ┌─────────────▼──────────────┐
                          │       Application API       │
                          │   (role + branch authz)     │
                          └─────────────┬──────────────┘
                                        │
                ┌───────────────────────┼─────────────────────────┐
                │                       │                         │
        ┌───────▼────────┐      ┌───────▼────────┐         ┌───────▼────────┐
        │  Booking core  │      │  Schedule core │         │  Audit + OTP   │
        │  (slots, hold, │      │  (doctor       │         │  (audit log,   │
        │   reservations)│      │   schedules,   │         │   SMS OTP      │
        │                │      │   branches)    │         │   gateway)     │
        └───────┬────────┘      └───────┬────────┘         └───────┬────────┘
                │                       │                         │
                └───────────────────────┼─────────────────────────┘
                                        │
                          ┌─────────────▼──────────────┐
                          │     Primary database       │
                          │  (relational, ACID)         │
                          └─────────────┬──────────────┘
                                        │
                          ┌─────────────▼──────────────┐
                          │   Read replica (optional)  │
                          │   for availability queries │
                          └────────────────────────────┘
```

SMS provider is the only external dependency. Email/in-app/push are out of scope.

---

## 3. Key subsystems

### 3.1 Identity & access

- **Patient:** phone → OTP → short-lived session token. No persistent account.
- **Staff (doctor/receptionist/admin):** signed-in session with role + (for doctors) multi-branch list or (for receptionists) single branch id.

**Auth contract (provider clause).** The chosen auth library MUST issue session tokens whose signed claims include `{role, branch_ids: string[], scope, doctor_id?: string}` plus a refresh contract. Server reads `branch_ids` from the claim, never from the request body. Any auth implementation that does not produce these claims does not satisfy this invariant — pick a library that does.

### 3.2 Availability engine

A pure function:

```
availability(doctor, branch, date, appointment_type):
  branch_hours  = branch.operating_hours for date
  doctor_hours  = doctor_schedule(doctor, branch, date)
  blocks        = doctor_blocks overlapping date
  existing      = appointments where doctor = X
                                 and branch = Y
                                 and status = Scheduled
                                 and start_date = date
  window        = today+1 ≤ date ≤ today+30
  patient_ok    = (no future appt for same patient+doctor) and (no patient overlap)
  return slots within ((branch_hours ∩ doctor_hours) − blocks − existing)
         such that the entire appointment_type.duration fits
         and window and patient_ok
```

Implementation requirement: server-side, transactional, **never cached on the client**. Cache (if any) is server-side with strict invalidation on every appointment write.

### 3.3 Slot reservation

Two operations, both transactional:

- **`reserveSlot(doctor, branch, start, end)`** — guarded insert into `Appointment(status = Scheduled)`. The table MUST carry a Postgres `EXCLUDE USING gist (doctor_id WITH =, branch_id WITH =, tstzrange(start_datetime, end_datetime, '[)') WITH &&) WHERE (status = 'Scheduled')` constraint so overlapping ranges for the same doctor/branch cannot commit. Application code wraps the write in either `SELECT FOR UPDATE` on the `(doctor_id, branch_id, start_datetime, status)` partial-unique tuple, or a `SERIALIZABLE` retry on `40001`, as belt-and-braces.
- **`releaseSlot(doctor, branch, start, end)`** — defined as **the same transaction that sets the prior Appointment's status to a non-`Scheduled` terminal state** (per AD-5). Availability cache invalidation is write-ahead within the same transaction, not read-after-commit.

Booking transaction (PRD §10):

```
validate patient → doctor → branch → type → date
 → doctor availability → branch hours
 → doctor conflict → patient conflict
 → reserve slot → create Appointment (status = Scheduled)
 → audit
```

Any failure → no appointment.

### 3.4 Rescheduling transaction (PRD §11)

```
existing appointment
  → select new slot (same doctor)
  → validate branch / type / availability / patient conflicts
  → reserve new slot
  → update Appointment (branch_id, appointment_type_id, start, end)
  → release old slot
  → audit
```

If reserve-new fails, the original is untouched.

**Series-occurrence reschedule (AD-3).** A row materialized from a recurring series retains `series_id` and `series_occurrence_index`. Rescheduling such a row creates an `OverrideOccurrence` child row (or sets an override flag) instead of mutating `start`. The original-pattern slot is released; the new slot is reserved; one audit row. The pattern itself is never retroactively rewritten.

### 3.5 Recurring series

A **preview-only** generator that reuses `availability()` per occurrence:

```
preview(doctor, branch, type, pattern, count_or_end_date):
  occurrences = expand pattern within window
  for each: run booking validators; bucket into {will_create, skipped_with_reason}
  return summary + per-row detail
```

On confirm (per AD-2): each row runs through the §3.3 booking transaction with full validators and the `SERIALIZABLE` lock. Rows that fail at confirm time are returned in `skipped:[{date, reason: <enum>}]` and are **not** counted as `will_create` for audit purposes. The `reason` field is a closed enum tied to AD-4 codes (`race_lost`, `branch_closed`, `doctor_unavailable`, `patient_conflict`, `type_unavailable`, ...; see AD-11). The success response carries exactly the rows that succeeded; the failure response carries exactly the rows that failed; the client never receives a `will_create` row that does not exist in storage. One audit row per row that committed.

### 3.6 Conflict resolution (doctor flow F-09)

When a schedule/block save is rejected:

1. Server identifies affected appointments (`status = Scheduled AND (start, end) ⊆ proposed_removal_window`).
2. Returns affected list; the doctor resolves one at a time.
3. Each resolution uses the rescheduling transaction (3.4) with appointment type locked and branch set restricted to doctor's branches.
4. After zero remaining, server re-runs the schedule validation; if clean, persists the change and audits.

**Schedule-lattice single-writer rule (AD-1).** There is exactly one writer of authority per `(branch_id, doctor_id, local_date)` cell. The cell is mutated via one of two operations: `DoctorScheduleMutation` (this section — reject if conflicts) or `BranchHoursMutation` (§3.7 — save + flag + enqueue resolution work item). A flag is a durable work item owned by `FlagResolver`; `FlagResolver` either reschedules the appointment (§3.4) or escalates. Doctors resolving their own schedule changes cannot consume admin-origin flags — they are dispatched to the flag owner.

**Schedule-change audit (AD-7).** The schedule-change audit row includes `affected_appointment_ids` at validation time in metadata and is written in the same transaction as the schedule row update. Each per-appointment resolution writes its own audit row with `cause: "schedule_change:<schedule_change_id>"`. The schedule-change audit is written only on successful persist; if the doctor abandons, no audit row, and any partial per-appointment audits are reconciled via a `cause`-replay walk.

**Block creation (AD-6).** Block creation validates against (a) all `Appointment` rows where `status = Scheduled` overlapping the proposed window AND (b) all existing blocks for the same doctor overlapping the proposed window, under the same `SERIALIZABLE` lock as §3.3. Block creation and booking creation racing for the same `(doctor, branch, start_datetime)` row are serialized through the same lock target; whichever loses receives the appropriate 409/410 per AD-4.

### 3.7 Branch-hours impact (admin flow F-17)

Different from doctor flow on purpose (PRD §4.6):

1. Admin saves the new hours.
2. Server identifies future affected appointments (`status = Scheduled AND start_local_time ∉ new_hours`).
3. Affected appointments are **flagged** (a flag column / linked resolution task) — status remains Scheduled.
4. Each affected appointment appears on the assigned doctor's dashboard with a "Resolve" badge, **dispatched to `FlagResolver`** per AD-1.

The system never silently invalidates an appointment.

### 3.8 OTP

- 6-digit code, sent via SMS provider.
- 5-minute TTL.
- 3-attempt cap per phone per 10-minute window → lockout.
- Server-side verification creates a short-lived patient session.

**SMS provider contract (provider clause).** The chosen SMS provider MUST be regionally compliant — US A2P 10DLC brand+campaign registration, KSA DLT registration, EU GDPR Art. 9 disclosure for health-adjacent context — and MUST honor the rate-limit above. Provider-specific concerns (deliverability, sender ID, regional failover) are accounted for in implementation, not here.

### 3.9 Audit

Append-only `AppointmentAudit` table with `(appointment_id, action, actor_role, actor_id, timestamp, metadata)`. Internal-only surface (UX §14). Patients never query audit.

---

## 4. Data model invariants

Derived from PRD §8 and design constraints:

- `Appointment.status ∈ {Scheduled, Completed, Cancelled, No-show}` — no other states.
- A doctor has at most one `Scheduled` appointment per `(start_datetime, end_datetime, branch_id)` tuple. **Enforcement:** Postgres `EXCLUDE USING gist (doctor_id WITH =, branch_id WITH =, tstzrange(start_datetime, end_datetime, '[)') WITH &&) WHERE (status = 'Scheduled')` (F14), with row-lock / SERIALIZABLE as belt-and-braces.
- A patient has at most one `Scheduled` appointment per `(doctor_id)`.
- A patient has no time-overlapping `Scheduled` appointments (across doctors/branches). **Index:** `(patient_phone, status, start_datetime)`; falls back to read-replica if availability call exceeds NFR-008 budget (F16).
- `created_by` is either a staff user id or a patient phone number (guest booking).
- `Appointment` rows are never deleted — `Cancelled` is the terminal state.
- `AppointmentAudit` is append-only. Retention: at least 7 years (F18); specifics (cold storage, encryption-at-rest, PII scrubbing) deferred to §9.1.
- `Branch.tz` is required for production (UX-FLOWS §6.4). All appointment timestamps are stored UTC and rendered in `appointment.branch.tz` (AD-9); session branch tz never relabels another branch's event.
- `Branch.active` is required. Inactive branches are excluded from `/availability` and `/bookings` at the data layer; existing `Scheduled` appointments remain Scheduled and resolvable (F17).
- `DoctorSchedule` is keyed by `(doctor_id, branch_id, day_of_week, effective_from)` with multiple periods per day.
- `DoctorPatientLink` is populated on first booking; required for AD-8 doctor self-scope.
- `RoleFieldPolicy` declares field-level access per role; `patient.phone` is visible to `{receptionist: same_branch, doctor: own_appointment, admin: never}` (AD-10).
- `Patient` is identified by `phone_number` (unique).
- `OTPVerification` is created on send, marked verified on success, expired on TTL, locked on attempt-cap.
- `OverrideOccurrence` (or override flag) carries the per-occurrence reschedule for a series-materialized row (AD-3); `series_id` and `series_occurrence_index` are preserved on the underlying row.

**DB-engine contract (F1).** The DB engine MUST support all three: row-level pessimistic locking, partial-unique-index capable (predicate `WHERE` clause), and range-overlap expression via `tstzrange` (Postgres `EXCLUDE USING gist` or equivalent). Engines that lack any of these (e.g. MySQL — no partial indexes; SQLite — no real `SERIALIZABLE`) do not satisfy this invariant. Postgres is a conforming reference implementation.

---

## 5. API surface (logical, not prescriptive)

| Verb | Resource | Notes |
|---|---|---|
| POST | `/bookings` | Atomic create. Returns 201 Scheduled, 409 ConflictModal-shaped body, 410 with reasons. |
| GET | `/availability` | Doctor + branch + type + date → slots. |
| POST | `/bookings/:id/cancel` | Body: `{reason?}` (required for staff, optional for patient). |
| POST | `/bookings/:id/reschedule` | Body: `{new_start, new_branch_id?, new_type_id?}`. Same doctor. |
| POST | `/recurring/preview` | Returns `{will_create, skipped:[{date,reason}]}`. |
| POST | `/recurring/confirm` | Body: `{preview_id}`. Atomic batch insert. |
| GET/POST/PATCH | `/doctors/:id/schedule` | PATCH validates affected appts; 409 if any. |
| POST | `/doctors/:id/blocks` | Validates overlap; 409 if any. |
| GET/POST/PATCH | `/admin/branches` | Hours change flags affected appts (no rejection). |
| POST | `/patient/otp/send`, `/patient/otp/verify` | SMS OTP. |
| GET | `/patient/appointments` | Auth: patient session. Server-side phone filter. |
| GET | `/staff/appointments` | Auth: staff session. Server-side role+branch filter. |
| GET | `/audits/:appointment_id` | Doctor/receptionist: own scope. Admin: config audits only. |

Errors use the **canonical `ErrorEnvelope`** (AD-4): `{code: <enum>, what: string, why: string, can_do: [{label: string, action: <enum>}] | null, details: object | null}`.

- `code` is a closed enum: `SLOT_RACED`, `SLOT_NO_LONGER_AVAILABLE`, `PATIENT_CONFLICT`, `BRANCH_HOURS_CONFLICT`, `SCHEDULE_CONFLICT`, `VALIDATION`, ...
- 410 fires **only** for terminal availability codes (`SLOT_NO_LONGER_AVAILABLE` and similar).
- `can_do` is non-null for terminal codes; `action` is a closed enum the ConflictModal can dispatch.
- Save-time conflicts (e.g. doctor schedule change with affected appointments) carry the affected list in `details`, **not** as recovery actions.

---

## 6. Non-functional architecture

- **Concurrency:** row-level locks on `(doctor_id, branch_id, start_datetime)` for slot reservation, **plus the `EXCLUDE USING gist` constraint** (F14, AD-5); SQL `SERIALIZABLE` or equivalent. Booking throughput target: 50 RPS sustained. The double-booking counter (below) MUST remain 0.
- **Availability latency:** NFR-008 (≤2s). Strategy: server-side cache of generated slots, invalidated **write-ahead in the same transaction** as the appointment write (AD-5 — not read-after-commit). Indexes on `(doctor_id, branch_id, start_datetime)` and `(patient_phone, status, start_datetime)`; the patient-overlap check routes through the read-replica if the availability call would blow NFR-008 (F16).
- **TZ:** store all timestamps as UTC; convert at `appointment.branch.tz` for display (AD-9 — never `session.branch.tz`). Edge gateway normalizes incoming timestamps to UTC only, never to a tz (only the application knows which branch the request targets). Every appointment-related response carries an explicit `tz` field.
- **Observability:** structured logs include `actor_role`, `actor_id`, `appointment_id`, `trace_id`. Counter for double-booking incidents (should always be 0). Alerting thresholds are deferred to §9.1.
- **Privacy:** NFR-007 — patient filtering is server-side only. The API never returns appointments for a phone other than the verified session. **Field-level PII is governed by `RoleFieldPolicy` (AD-10):** `patient.phone` visibility per role is declared in §4 and inherited by every endpoint. A future role must declare its field policy at provisioning.
- **Audit durability:** `AppointmentAudit` writes are in the same transaction as the appointment write. Schedule-change audits carry `affected_appointment_ids` and reference `cause: "schedule_change:<id>"` on per-resolution audits (AD-7). Audit retention ≥ 7 years (F18); specifics in §9.1.
- **Staff scope on `/staff/appointments`:** role+branch filter per AD-8 — doctor: `doctor_id = session AND branch_id IN session.branch_ids AND patient IN DoctorPatientLink`; receptionist: `branch_id = session.branch_id` (no phone, no doctor); admin: empty (config audits only).

---

## 7. Frontend architecture (binding on UI engineers)

- **Stack freedom within token discipline.** The repo is greenfield; framework choice is downstream of this spine. Whatever is chosen must consume design tokens by name (`--brand-primary`, etc.), not literal hex.
- **No web fonts.** System stack only (DESIGN-SYSTEM §3). Zero layout shift.
- **Single source for tokens.** A `tokens.css` (or equivalent) generated from `DESIGN-SYSTEM.md`. Updating one without the other is a bug.
- **CI lint on token discipline.** A lint rule on the chosen frontend MUST fail CI when a literal hex color appears outside `tokens.css` (or equivalent generated artifact). Token names referenced as variables are required; literal hex is forbidden (F19).
- **ConflictModal shape is global.** Every conflict surface uses the same `ErrorEnvelope` shape (AD-4); not bespoke error toasts.
- **Status pills never use brand teal.** Brand teal is for actions (DESIGN-SYSTEM §2.4 color rule).
- **Touch targets ≥ 40×40** on mobile, even though mockups target 1440.
- **Honor `prefers-reduced-motion`.** Toast slide and modal scale-in are disabled.

---

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Concurrent double-booking | Row-level locks + unique constraint + 410 with ConflictModal |
| Reschedule race (reserve-new fails) | Reserve-new before release-old; abort cleanly if reserve fails |
| Branch tz confusion | Store UTC; convert at branch tz; UI labels always carry tz |
| Doctor removes appts inadvertently | Schedule changes that affect appts are **rejected**, not flagged |
| Admin change affects appts | Branch-hours changes save and flag; flag is visible on doctor's dashboard |
| Recurring silent partial failure | RecurrenceResultPanel always shows skipped + reasons (FR-048) |
| OTP abuse / brute force | 3-attempt cap, 10-min lockout, rate-limit on send |
| PII leak across roles | Server-side filters; never expose patient phone to other branches |

---

## 9. Resolved & deferred stack choices

The following are **ratified as decisions** (2026-09-06):

- **Frontend.** **Next.js 15 (App Router) + React 19 + Tailwind CSS v4 + Radix UI primitives.** Server Components are the default render mode; Server Actions for staff mutations; Route Handlers for cross-origin public surfaces (`/patient/otp/*`, `/bookings/*`). Tailwind consumes the §7 design tokens by name (`--brand-primary`, etc.); Radix supplies the accessible primitives for ConflictModal, OTP modal, and dialogs.
- **Backend.** **Next.js Route Handlers + Server Actions on Node runtime.** Same repo, same auth boundary. Long-running transactions (AD-2 recurring confirm) require the Node runtime, not Edge — Edge runtime is reserved for tz normalization (AD-9) and middleware.
- **Database.** **PostgreSQL 16 + Prisma 5.** Postgres is locked, not recommended — the §4 DB-engine contract (`EXCLUDE USING gist` on `tstzrange`, partial unique indexes, `SERIALIZABLE`, `timestamptz`) is the reason. Prisma handles migrations and queries; the `EXCLUDE USING gist` constraint is added via one raw-SQL migration per ADR-1 below.

The following remain **deferred to sprint planning**. Each is constrained by a contract clause in §3.1, §3.3, §3.8, or §4 so the choice cannot silently weaken an invariant.

1. Hosting target (cloud region, edge presence).
2. **SMS provider.** MUST satisfy the §3.8 provider contract — regionally compliant (US A2P 10DLC, KSA DLT, EU GDPR Art. 9 for health-adjacent context) and honor the §3.8 rate-limit.
3. Background job system for audit retention (F18) and slot cache warming.
4. **Auth library for staff.** MUST satisfy the §3.1 auth contract — claims include `{role, branch_ids, scope, doctor_id?}` plus a refresh contract. Options: NextAuth.js v5 with a JWT+refresh session, Auth.js with an OIDC provider, or a hosted provider (Clerk, WorkOS) whose claim shape is verified against the §3.1 contract before adoption.

### 9.1 Operational envelope (deferred to sprint planning)

At system altitude the spine must enumerate — even if it doesn't decide — the operational envelope. The items below are deferred but each touches at least one invariant; an implementation choice that contradicts an item must surface the conflict before shipping.

- **Environments:** dev / staging / prod parity; branch-deployment strategy; CI/CD expectations; environment-variable contract.
- **SLOs:** NFR-008 (availability latency ≤2s) and NFR-009 (booking service availability) translated to specific targets and alerting thresholds; the §6 double-booking counter remains 0 by definition.
- **DR / backup:** RPO/RTO targets; backup frequency; restore drill cadence.
- **Secrets management:** rotation cadence; storage contract; split between edge and application secrets.
- **Audit retention:** ≥ 7 years per F18; cold storage, encryption-at-rest, PII scrubbing for compliance exports.
- **Scaling strategy:** read replica labeled optional (no sharding decision at this altitude); connection-pool sizing; write-scaling story if traffic grows.
- **TLS / transport security:** cert management (rotation, mTLS internal, HSTS).
- **Observability depth:** beyond the §6 structured logs and counter — metrics, traces, dashboards.

These are outside the spine's load-bearing decisions but inside its mandate at this altitude; an implementation that treats them as out-of-scope is the failure mode this enumeration prevents.

---

## 10. What this document is not

- Not a code library. Implementation teams choose the wire format for tokens, ORM, etc.
- Not a one-time write. When the UX or PRD changes, this spine is updated first.
- Not a substitute for design review. The mockups in `docs/design/mockups/v1/winners/` are still the visual ground truth.

---

## 11. Architecture decisions (ADs)

Stable IDs — never renumber. Add new decisions as the next AD-n. Each AD carries Rule + Binds + Prevents. Rolled in from the 2026-09-06 validate-gate review.

### AD-1 · Schedule-lattice single-writer rule (FlagResolver)

- **Rule.** There is exactly one writer of authority per `(branch_id, doctor_id, local_date)` cell. The cell is mutated via one of two operations: `DoctorScheduleMutation` (§3.6 — reject if conflicts) or `BranchHoursMutation` (§3.7 — save + flag + enqueue resolution work item). A flag is a durable work item owned by `FlagResolver`; `FlagResolver` either reschedules the appointment (§3.4) or escalates. Doctors resolving their own schedule changes cannot consume admin-origin flags — they are dispatched to the flag owner.
- **Binds.** `ScheduleCore`, `BookingCore`, `FlagResolver`, §3.6, §3.7.
- **Prevents.** A doctor schedule change being blocked by an admin-flagged appointment that the doctor has no authority to resolve; a flagged appointment silently staying `Scheduled` past branch-hours change without an open resolution work item; two systems both believing they own the cleanup of the same cell.

### AD-2 · Recurring-confirm atomic per-row with race_lost reason

- **Rule.** Recurring confirm runs each row through the §3.3 booking transaction with full validators and the `SERIALIZABLE` lock. Rows that fail at confirm time are returned in `skipped:[{date, reason: "race_lost"}]` and are **not** counted as `will_create` for audit purposes. The success response carries exactly the rows that succeeded; the failure response carries exactly the rows that failed; the client never receives a `will_create` row that does not exist in storage.
- **Binds.** `RecurringSeries`, `BookingCore`, `Audit`, §6 double-booking counter.
- **Prevents.** The double-booking counter incrementing on a documented race; audit rows for rows that did not materialize; preview result becoming a contract the server cannot honor.

### AD-3 · OverrideOccurrence for recurring-occurrence reschedule

- **Rule.** A row materialized from a recurring series retains `series_id` and `series_occurrence_index`. Rescheduling such a row creates an `OverrideOccurrence` child row (or sets an override flag) instead of mutating `start`. The original-pattern slot is released; the new slot is reserved; one audit row. The pattern itself is never retroactively rewritten.
- **Binds.** `BookingCore`, `RecurringSeries`, `AvailabilityEngine`, `Audit`, §3.4.
- **Prevents.** Silent loss of series identity after a single-occurrence reschedule; duplicate slots if the series is ever re-materialized; inconsistent audit trail between row-level and series-level actions.

### AD-4 · Closed-enum `ErrorEnvelope` (ConflictModal canonical shape)

- **Rule.** Every error response from `/bookings/*`, `/recurring/*`, `/doctors/*/schedule`, `/admin/branches` uses `ErrorEnvelope = {code: <enum>, what: string, why: string, can_do: [{label: string, action: <enum>}] | null, details: object | null}`. Codes are a closed enum (`SLOT_RACED`, `SLOT_NO_LONGER_AVAILABLE`, `PATIENT_CONFLICT`, `BRANCH_HOURS_CONFLICT`, `SCHEDULE_CONFLICT`, `VALIDATION`, ...). 410 fires **only** for terminal availability codes; `can_do` is non-null for terminal codes; `can_do.action` is a closed enum the ConflictModal can dispatch. Save-time conflicts carry the affected list in `details`, **not** as recovery actions.
- **Binds.** Every API endpoint, every error path in `BookingCore`/`ScheduleCore`/`RecurringSeries`, §5 API surface, §7 frontend ConflictModal.
- **Prevents.** Endpoint-specific error shapes that drift the ConflictModal; untyped `can_do.action` strings the modal cannot dispatch; 409s for save-time conflicts that force a list-of-appointments into a recovery-actions shape.

### AD-5 · `releaseSlot` = status mutation in one transaction

- **Rule.** `releaseSlot(doctor, branch, start, end)` is defined as **the same transaction that sets the prior `Appointment.status` to a non-`Scheduled` terminal state**. Availability cache invalidation is write-ahead within the same transaction, not read-after-commit. For recurring series cancel, all rows cancel in a single transaction with one `series_id` audit parent + N child audit rows; failure rolls back the whole series.
- **Binds.** `BookingCore`, `ScheduleCore` (cache invalidation), `Audit`, `RecurringSeries`, §3.3, §3.4.
- **Prevents.** Window between `status = Cancelled` and availability recompute where another booking can win the slot; partial series-cancel with audit rows committed but appointment rows not (or vice versa).

### AD-6 · Block creation validates against appointments AND existing blocks

- **Rule.** Block creation validates against (a) all `Appointment` rows where `status = Scheduled` overlapping the proposed window AND (b) all existing blocks for the same doctor overlapping the proposed window, under the same `SERIALIZABLE` lock as §3.3. A block creation and a booking creation racing for the same `(doctor, branch, start_datetime)` row are serialized through the same lock target; whichever loses receives the appropriate 409/410 per AD-4.
- **Binds.** `ScheduleCore`, `BookingCore`, `AvailabilityEngine`, §3.6.
- **Prevents.** Two overlapping blocks silently emptying availability; a booking landing inside a block via a TOCTOU race between block-read and block-write.

### AD-7 · Schedule-change audit `cause` link

- **Rule.** Schedule-change audits include the set of `affected_appointment_ids` at validation time in metadata and are written in the same transaction as the schedule row update, which is itself serialized against other schedule mutations on the same `(doctor, branch, day_of_week)`. Each per-appointment resolution writes its own audit row with `cause: "schedule_change:<schedule_change_id>"`. The schedule-change audit is written only on successful persist; if the doctor abandons, no audit row, and any partial per-appointment audits are reconciled via a `cause`-replay walk that ties them to the abandoned change.
- **Binds.** `ScheduleCore`, `BookingCore`, `Audit`, `ConflictResolver`, §3.6, §6.
- **Prevents.** Audit log showing reschedules/cancels with no upstream cause; schedule-change audit row that does not match the validated state; orphaned per-appointment audits after an abandoned schedule change.

### AD-8 · Doctor self-scope via doctor-patient link

- **Rule.** `/staff/appointments` filter is exactly `(role=doctor → doctor_id = session.doctor_id AND branch_id IN session.branch_ids AND patient IN DoctorPatientLink)` OR `(role=receptionist → branch_id = session.branch_id)`. A receptionist cannot filter by phone or by doctor. Admin scope on appointments is empty (configuration audits only per §3.9/§5). `DoctorPatientLink` is populated on first booking.
- **Binds.** `StaffAppointmentsController`, `ApplicationAPI` (authz middleware), `PatientPrivacyFilter`, §5 `/staff/appointments`, §6.
- **Prevents.** A doctor seeing every appointment at any of their branches regardless of patient relationship; a receptionist enumerating patients across doctors at one branch; an admin escalating via a shared session.

### AD-9 · Response `tz` = `appointment.branch.tz`

- **Rule.** Every appointment-related timestamp in any response carries an explicit `tz` field naming the IANA tz it is rendered in, and the value is always `appointment.branch.tz`. The session's branch tz is never used to relabel an appointment. Edge gateway normalizes incoming timestamps to UTC only, never to a tz (only the application knows which branch the request targets).
- **Binds.** `EdgeGateway`, `ApplicationAPI`, every response serializer, §1.5, §6.
- **Prevents.** A doctor scheduling on the wrong day because session-tz labels were applied to an event at another branch's tz; edge normalizing against request-supplied `branch_id` and silently shifting the doctor's query window.

### AD-10 · `RoleFieldPolicy` for PII visibility

- **Rule.** Field-level access is declared per role in a `RoleFieldPolicy` table. `patient.phone` is visible to `{receptionist: same_branch, doctor: own_appointment, admin: never}`. New roles added in the future MUST declare their field policy at provisioning; endpoints inherit. The spine is updated whenever a new role is introduced.
- **Binds.** All response serializers, every endpoint returning patient PII, §4, §6.
- **Prevents.** A future role (nurse, manager, billing) inheriting receptionist's phone visibility by default; a receptionist seeing patient phones for appointments they do not staff; an admin escalating to read patient phones via a config-audit side channel.

### AD-11 · `skipped[].reason` as closed enum tied to AD-4 codes

- **Rule.** The `reason` field in `skipped[]` (AD-2) is a closed enum mapped 1:1 to AD-4 `ErrorEnvelope` codes: `race_lost`, `branch_closed`, `doctor_unavailable`, `patient_conflict`, `type_unavailable`, ... Per-row `ErrorEnvelope`-shaped entries with `code` in `details.skipped[]` are the canonical alternative — both shapes are accepted, but free-form strings are forbidden.
- **Binds.** AD-2, AD-4, `RecurringSeries`, `BookingCore`, §3.5.
- **Prevents.** Free-form `reason` strings the client cannot dispatch; drift between per-row reasons and the top-level `ErrorEnvelope` shape; new failure modes silently inventing reason verbs.

### AD-12 · `OverrideOccurrence` ownership on series-cancel

- **Rule.** A recurring series cancel (AD-5 single-tx cascade) tombstones existing `OverrideOccurrence` rows in the same transaction: `status = superseded`, `parent_appointment_id` preserved, one audit row per override. `OverrideOccurrence` rows are owned by their parent series row; the cascade is tombstone (not delete) so audit history remains reconstructable.
- **Binds.** AD-3, AD-5, `BookingCore`, `RecurringSeries`, `Audit`, §3.5.
- **Prevents.** Orphaned `OverrideOccurrence` rows after series cancel; lost override audit history; two writers for the override cell.

### AD-13 · Cause-replay walk serialization + self-audit

- **Rule.** The cause-replay walk (AD-7 abandoned-change reconciliation) reads the schedule-change row where `abandoned_at IS NOT NULL`, holds the same `(doctor, branch, day_of_week)` lock as the original schedule change, and writes one `cause_replay` audit row per walk. Walks are idempotent (re-runnable on the same `abandoned_change_id`) and serialize via the schedule-change lock, not a separate lock target.
- **Binds.** AD-1, AD-7, `ScheduleCore`, `Audit`, `ConflictResolver`, §3.6, §6.
- **Prevents.** The cause-replay walk racing live schedule changes; orphan audit rows after replay; concurrent walks double-reconciling the same abandoned change.

---

## 12. Ratified implementation choices (ADRs)

Stable IDs — never renumber. Each ADR pins one ratified choice to the spine invariants it must not weaken. Decisions made 2026-09-06.

### ADR-1 · Postgres `EXCLUDE USING gist` as a raw-SQL migration in Prisma

- **Decision.** The `EXCLUDE USING gist (doctor_id WITH =, branch_id WITH =, tstzrange(start_datetime, end_datetime, '[)') WITH &&) WHERE (status = 'Scheduled')` constraint is added via one Prisma `prisma migrate` raw-SQL migration file, named e.g. `prisma/migrations/<timestamp>_appointment_exclusion_constraint/migration.sql`. Prisma's schema DSL does not express `EXCLUDE` constraints; the raw-SQL migration is the canonical path. The constraint is part of the `Appointment` table from day one and is verified by an integration test (booking conflict must fail at the DB layer, not at the application layer).
- **Binds.** §4 DB-engine contract (F1), §3.3 `reserveSlot` (F14), ADR-2 below.
- **Prevents.** Drift between Prisma's generated DDL and the runtime DDL; an implementation stream migrating the schema but forgetting the constraint; double-booking that the application layer "remembers" to prevent but the DB layer doesn't.

### ADR-2 · `prisma.$transaction({ isolationLevel: 'Serializable' })` for §3.3 booking + reschedule + recurring confirm

- **Decision.** The booking, reschedule, and recurring-confirm code paths use `prisma.$transaction(async tx => { ... }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5000, timeout: 10000 })`. The transaction body MUST catch `Prisma.PrismaClientKnownRequestError` with `code 'P2034'` (transaction conflict) and retry up to 3× with jittered backoff. Application-level `SELECT … FOR UPDATE` on `(doctor_id, branch_id, start_datetime, status)` is unnecessary when the exclusion constraint + serializable retry cover the same surface — keep it only if profiling proves it helps.
- **Binds.** AD-2, AD-5, §3.3, §3.4, §3.5, ADR-1.
- **Prevents.** Silent downgrade to a weaker isolation level under load; transaction-conflict errors surfacing as 500s; an implementation stream "optimizing" away the serializable level for throughput and re-introducing the very race the exclusion constraint catches.

### ADR-3 · Server Actions for staff mutations; Route Handlers for `/patient/*` and `/bookings/*`

- **Decision.** Staff flows (doctor, receptionist, admin) use **Next.js Server Actions** invoked from React Server Components — co-located with the page, same auth context, same Node runtime. Public cross-origin surfaces (`/patient/otp/*`, `/patient/appointments`, `/bookings`, `/availability`, `/recurring/*`, `/audits/:appointment_id`) use **Route Handlers** under `app/api/`. Both call the same `BookingCore` / `ScheduleCore` service layer; the service layer is the only place that touches `prisma`. Edge runtime is reserved for middleware (session decode, tz normalization to UTC per AD-9).
- **Binds.** §1.1 server-as-source-of-truth, §5 API surface, §3.1 auth, §3.3 reservation, AD-9.
- **Prevents.** Staff mutations routed through a second auth boundary (defeats AD-8); patient APIs accidentally served from Server Actions (no CSRF token); edge runtime handling long-running recurring confirms (no `node:fs`, no Postgres wire protocol — would crash).

### ADR-4 · Radix UI primitives + design-system tokens mapped to Tailwind config

- **Decision.** Component primitives — Dialog (ConflictModal, OTP modal), AlertDialog, Toast, DropdownMenu, Tabs, Select, RadioGroup — are built on **Radix UI** (`@radix-ui/react-*`) for accessibility (focus traps, keyboard nav, ARIA). Visual styling is **Tailwind v4** consuming the design-system tokens from `DESIGN-SYSTEM.md` by name: `--brand-primary` → `bg-[var(--brand-primary)]`, `--surface-card` → `bg-[var(--surface-card)]`, etc. The CI lint rule from §7 (F19) fails on any literal hex color outside `app/styles/tokens.css`.
- **Binds.** §7 frontend architecture, AD-19 (F19), design-system.md.
- **Prevents.** Bespoke dialogs that drift from the ConflictModal canonical shape (AD-4); literal hex creeping back into components; accessibility regressions in modal focus management; redesigns that re-implement token names from scratch.

### ADR-5 · Simulated OTP for v1 (hardcoded test code, SMS deferred)

- **Decision.** For v1, OTP verification uses a **hardcoded test code** (`000000` unless overridden by `OTP_TEST_CODE` env). Behavior depends on `process.env.NODE_ENV`:
  - `development` or `test`: any phone number passes the rate-limit and accept-counters, and verification succeeds when the submitted code equals `OTP_TEST_CODE` (default `000000`). No SMS provider is wired.
  - `production` (or any non-test environment without `OTP_SIMULATOR=1`): behavior is unchanged from §3.8 — SMS provider is required and verified against the provider contract. Hardening this path is a tracked TODO before v1 GA.
  - `OTP_SIMULATOR=1` (any env): the simulator path is active even outside dev/test, for staging demos.
- The `OTPVerification` table (BR-029, §4) is still written — the row exists with `code_hash = hash(OTP_TEST_CODE)`, `attempt_count`, `expires_at`, `verified_at`, `locked_until`. TTL and 3-of-10 lockout continue to fire, so the §3.8 rate-limit is exercised end-to-end. The "send" step is a no-op that writes a `dev_console_log=true` flag and an audit row.
- An environment-flag adapter (`isOtpSimulator()` in `lib/otp.ts`) is the **single** place that branches simulator vs. real. Production never imports the simulator branch.
- The spine's §3.8 provider contract is preserved for the day SMS ships; AD-5 only changes the *implementation* of `/patient/otp/send`, not the contract.
- **Binds.** §3.8 OTP (rate-limit, TTL, lockout — all preserved), §3.1 identity (patient-session creation unchanged), AD-4 error envelope (validation errors mapped to `ErrorEnvelope.code = VALIDATION`).
- **Prevents.** Test environments accidentally buying SMS capacity; rate-limit logic skipped during v1 (locks accounts to 0 attempts); patient-session-create step accidentally coupled to the SMS path; future SMS rollout blocked because the contract was changed instead of the implementation.

---

**Next step:** `bmad-create-epics-and-stories` — break the 19 system flows into sprintable stories using this architecture as the invariant guardrail. The four ADRs above are the binding between stories and code.
