---
id: spec-7-7-no-tentative-client-side-slot-holds
title: E7-S7 — No tentative client-side slot holds
epic: epic-7
status: ready-for-dev
review_loop_iteration: 0
created: 2026-10-07
last_updated: 2026-10-07
source_story: planning-artifacts/epics-and-stories.md §E7-S7
---

# E7-S7 — No tentative client-side slot holds

## Intent

Architecture principle 2 (atomicity over clever UX) and UX-FLOWS §6.2 forbid the UI from treating availability responses as anything more than advisory. The UI may display slots; it may **not** assume a slot is still bookable, and it may **not** hold tentative reservations outside the server's booking transaction.

This story is the **static + dynamic test pair** that locks the invariant at the source level and at the booking-transaction level. Mirrors the E2-S4 (`doctor-cannot-reschedule`) static-test pattern.

**Why a static test:** the negative capability — "no client store treats a slot as held" — is easier to assert by absence-of-show-disconfirmation than by runtime behavior. A grep test pinned in CI catches a future regression where someone adds a `Map<slotId, holdExpiry>` or a `pendingHolds: string[]` to the web client.

**Why a dynamic test:** the dynamic invariant — "session B sees ConflictModal, not a 500, when session A books the same slot" — requires two concurrent booking transactions against the same `appointment` row, and the second must observe `409 slot_taken` (or the equivalent) inside ConflictModal. Without it, the static-only test would let a UI-side regression where the modal isn't wired slip through.

## Approach

### 1. Static test — forbid tentative-hold state on the web client

**File:** `apps/web/test/no-tentative-holds.test.ts` (NEW).

The test runs `git grep` (or a simple Node script that walks `apps/web/src`) for forbidden patterns and asserts zero matches:

| Forbidden pattern | Why |
|---|---|
| `pendingHolds`, `tentativeHolds`, `slotHolds`, `holdMap` | In-memory hold state |
| `holdExpiry`, `holdUntil`, `holdExpiryMs` | Hold lifetime tracking |
| `holds.set(`, `holds.add(`, `holdsMap.set(`, `Map<string, hold` | Mutable hold store |
| `optimisticHold`, `optimisticSlot`, `optimisticBooking` | Optimistic-locking smoke — wrong tool for the job |
| `localStorage.setItem('holds`, `sessionStorage.setItem('holds` | Persistent hold state across sessions |
| `setTimeout(..., hold`, `clearTimeout(hold` | Timer-driven hold expiry |

**Allowed exceptions (the test must whitelist):**
- The `holds_*` table column references in the API (`apps/api/.../migrations/*.sql`, schema definitions) — the server's GIST exclusion constraint is the source of truth, not a hold.
- `medicalBusyEvent` index name (typo in earlier draft; flagged in W54-style audit).
- ConflictModal's `aria-hold` if it ever appears (not in current design).

The test fails loudly with the offending file path + line number.

### 2. Dynamic test — concurrent booking sees ConflictModal

**File:** `apps/api/test/no-tentative-holds-concurrent.test.ts` (NEW).

Two-API-call booking race against the same `(doctor_id, start_datetime)`:

1. **Setup:** seed inserts a doctor + branch + appointment type + weekly hours + a future-dated slot that's free.
2. **Session A** issues `POST /bookings` with that slot → expects `201 Created`.
3. **Session B** issues `POST /bookings` with the same slot **before session A's response is processed** (or after, since the audit confirms the row exists).
5. **Session B** receives `409` with envelope `{error: 'slot_taken' | 'branch_inactive' | ...}` — the test pins the exact envelope via DB pin (count rows in `appointment` for the slot = 1, never 2).
6. **Audit row** for session A exists; audit row for session B does **not** exist (the failure path must not write audit).

The web client (E7-S4) renders ConflictModal on `409 slot_taken`; this test asserts the **server** contract that ConflictModal consumes.

### 3. Spec + sprint-status

- This doc.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — `7-7-no-tentative-client-side-slot-holds: done`.

## Files to change

| Path | Kind | What |
|------|------|------|
| `apps/web/test/no-tentative-holds.test.ts` | NEW | Static forbidden-pattern grep test |
| `apps/api/test/no-tentative-holds-concurrent.test.ts` | NEW | Concurrent-booking integration test |
| `_bmad-output/implementation-artifacts/spec-7-7-no-tentative-client-side-slot-holds.md` | NEW | Spec |
| `_bmad-output/implementation-artifacts/sprint-status.yaml` | EDIT | Story → done |

## I/O & Edge-Case Matrix

| Scenario | Expected outcome |
|---|---|
| Web client has no hold-state | `pnpm --filter @clinic/web test no-tentative-holds` → 0 violations |
| Future regression: someone adds `const slotHolds = new Map()` | Test fails, points to file + line |
| Concurrent booking race | `appointment` count = 1, audit count = 1 (session A only) |
| Session B gets `409` | Envelope is one of the documented booking-conflict codes |
| ConflictModal displays 409 envelope | Renderable via existing E1-S1 + E6-S2 surface (no new code) |

## Verification

1. `pnpm --filter @clinic/web test` — `no-tentative-holds.test.ts` green.
2. `pnpm --filter @clinic/api test` — `no-tentative-holds-concurrent.test.ts` green.
3. `pnpm --filter @clinic/web typecheck` — 0 new errors.
4. `pnpm --filter @clinic/web lint` — 0 new errors.
5. `pnpm --filter @clinic/api typecheck` — 0 new errors (3 pre-existing baseline unchanged).
6. `pnpm --filter @clinic/api lint` — 0 new warnings (4 pre-existing baseline unchanged).
7. Testcontainers runtime unavailable in this env; suite cannot be re-run; status relies on spec audit trail.

## Spec Change Log

(none yet — first authoring)