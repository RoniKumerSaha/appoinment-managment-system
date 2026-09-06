# Architecture — Multi-Branch Clinic Appointment Scheduling System

> **BMad planning artifact.** The architectural spine: the invariants that keep features, epics, and stories consistent. Derived from `_bmad-output/planning-artifacts/prd.md` and `_bmad-output/planning-artifacts/ux.md`. This is the **what must be true** for any implementation to satisfy the design.
>
> The repository is currently design-only (`docs/` + `_bmad/`). Code has not landed. Therefore this is a **greenfield spine** that ratifies the design as the contract that future code must honor.

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
4. **Patient identity is a phone number.** No passwords, no accounts. Identity verification is SMS OTP, server-side filtered.
5. **Branch-local time.** All branch hours and slot times are in the branch's timezone. UI labels match.
6. **Role × Branch authorization is a server concern.** Receptionists are branch-scoped; doctors are self-scoped; admins don't see individual appointments.
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

- **`reserveSlot(doctor, branch, start, end)`** — insert a TentativeHold row (TTL seconds) or a guarded insert into `Appointment(status = Scheduled)` inside `SERIALIZABLE` / row-level lock with `UNIQUE(doctor_id, branch_id, start_datetime) WHERE status = Scheduled`.
- **`releaseSlot(doctor, branch, start, end)`** — transaction commits the prior hold and lets availability recompute.

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

### 3.5 Recurring series

A **preview-only** generator that reuses `availability()` per occurrence:

```
preview(doctor, branch, type, pattern, count_or_end_date):
  occurrences = expand pattern within window
  for each: run booking validators; bucket into {will_create, skipped_with_reason}
  return summary + per-row detail
```

On confirm: atomic batch insert of `will_create` rows; one audit row per created occurrence. Skipped rows are never persisted except as part of the result panel response.

### 3.6 Conflict resolution (doctor flow F-09)

When a schedule/block save is rejected:

1. Server identifies affected appointments (`status = Scheduled AND (start, end) ⊆ proposed_removal_window`).
2. Returns affected list; the doctor resolves one at a time.
3. Each resolution uses the rescheduling transaction (3.4) with appointment type locked and branch set restricted to doctor's branches.
4. After zero remaining, server re-runs the schedule validation; if clean, persists the change and audits.

### 3.7 Branch-hours impact (admin flow F-17)

Different from doctor flow on purpose (PRD §4.6):

1. Admin saves the new hours.
2. Server identifies future affected appointments (`status = Scheduled AND start_local_time ∉ new_hours`).
3. Affected appointments are **flagged** (a flag column / linked resolution task) — status remains Scheduled.
4. Each affected appointment appears on the assigned doctor's dashboard with a "Resolve" badge.

The system never silently invalidates an appointment.

### 3.8 OTP

- 6-digit code, sent via SMS provider.
- 5-minute TTL.
- 3-attempt cap per phone per 10-minute window → lockout.
- Server-side verification creates a short-lived patient session.

### 3.9 Audit

Append-only `AppointmentAudit` table with `(appointment_id, action, actor_role, actor_id, timestamp, metadata)`. Internal-only surface (UX §14). Patients never query audit.

---

## 4. Data model invariants

Derived from PRD §8 and design constraints:

- `Appointment.status ∈ {Scheduled, Completed, Cancelled, No-show}` — no other states.
- A doctor has at most one `Scheduled` appointment per `(start_datetime, end_datetime, branch_id)` tuple.
- A patient has at most one `Scheduled` appointment per `(doctor_id)`.
- A patient has no time-overlapping `Scheduled` appointments (across doctors/branches).
- `created_by` is either a staff user id or a patient phone number (guest booking).
- `Appointment` rows are never deleted — `Cancelled` is the terminal state.
- `AppointmentAudit` is append-only.
- `Branch.tz` is required for production (UX-FLOWS §6.4).
- `DoctorSchedule` is keyed by `(doctor_id, branch_id, day_of_week, effective_from)` with multiple periods per day.
- `Patient` is identified by `phone_number` (unique).
- `OTPVerification` is created on send, marked verified on success, expired on TTL, locked on attempt-cap.

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

Errors use the ConflictModal shape: `{what, why, can_do: [{label, action}]}`.

---

## 6. Non-functional architecture

- **Concurrency:** row-level locks on `(doctor_id, branch_id, start_datetime)` for slot reservation; SQL `SERIALIZABLE` or equivalent. Booking throughput target: 50 RPS sustained.
- **Availability latency:** NFR-008 (≤2s). Strategy: server-side cache of generated slots, invalidated synchronously on every appointment write. Indexes on `(doctor_id, branch_id, start_datetime)` and `(patient_phone, status, start_datetime)`.
- **TZ:** store all timestamps as UTC; convert at branch tz for display. Branch `tz` is the conversion source.
- **Observability:** structured logs include `actor_role`, `actor_id`, `appointment_id`, `trace_id`. Counter for double-booking incidents (should always be 0).
- **Privacy:** NFR-007 — patient filtering is server-side only. The API never returns appointments for a phone other than the verified session.
- **Audit durability:** `AppointmentAudit` writes are in the same transaction as the appointment write.

---

## 7. Frontend architecture (binding on UI engineers)

- **Stack freedom within token discipline.** The repo is greenfield; framework choice is downstream of this spine. Whatever is chosen must consume design tokens by name (`--brand-primary`, etc.), not literal hex.
- **No web fonts.** System stack only (DESIGN-SYSTEM §3). Zero layout shift.
- **Single source for tokens.** A `tokens.css` (or equivalent) generated from `DESIGN-SYSTEM.md`. Updating one without the other is a bug.
- **ConflictModal shape is global.** Every conflict surface uses the same three-part pattern, not bespoke error toasts.
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

## 9. Open architectural questions

These are intentionally deferred to sprint planning:

1. Web framework + language choice (greenfield; this spine is language-agnostic).
2. Database engine (Postgres recommended given the concurrency story).
3. SMS provider (Twilio / Unifonic / others — chosen at implementation time).
4. Hosting target (cloud region, edge presence).
5. Background job system for audit retention and slot cache warming.
6. Auth library for staff (likely OIDC/SAML given admin/clinical operations).

These are outside the spine; none of them changes the invariants above.

---

## 10. What this document is not

- Not a code library. Implementation teams choose the wire format for tokens, ORM, etc.
- Not a one-time write. When the UX or PRD changes, this spine is updated first.
- Not a substitute for design review. The mockups in `docs/design/mockups/v1/winners/` are still the visual ground truth.

---

**Next step:** `bmad-create-epics-and-stories` — break the 19 system flows into sprintable stories using this architecture as the invariant guardrail.
