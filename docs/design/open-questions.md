# Design Open Questions — Parking Lot

**Source:** `docs/specs/UX-FLOWS.md` §7 (Open Questions for Design)
**Created:** 2026-10-07
**Last updated:** 2026-10-26
**Owner:** Sally (UX) · **Maintainer:** Amelia (Dev)

This is the living register of unresolved design questions. It does **not** answer
them — that is UX/PM work. It captures the current state, the decision owner, the
story that consumes the decision, and the explicit deferral rationale so that a
question is never silently forgotten.

**How to use this document:**

- New questions are appended to **Open** with a creation date and an owner.
- When a question is answered, it moves to **Resolved** with the decision date and
  a link to the story or commit that consumed it.
- Resolved entries are **never deleted** — they are the audit trail. The "Affects"
  column records where the decision landed.
- When an Open item is decided, a new story is spawned from it (e.g. `7-12`) and
  the story key is recorded in the "Affects" column.

---

## Open

| # | Question | Status | Owner | Affects | Decision / Deferral | Created | Updated |
|---|----------|--------|-------|---------|--------------------|---------|---------|
| 1 | Calendar visualization: day / week / month view for doctor and receptionist dashboards? Recurring series rendering on the agenda? | OPEN | Sally (UX) | A future dashboard story (post-MVP) — not yet created | No decision for MVP. The doctor dashboard ships with the affected-queue kanban (E6-S2 / `DoctorAffected.tsx`) and the receptionist dashboard ships with the today view (E5-S4 / `ReceptionistToday.tsx`). Neither is a calendar. Decide when a calendar component is first proposed — the decision then drives the component's API rather than the reverse. | 2026-10-07 | 2026-10-26 |
| 4 | OTP UX: SMS-only, or voice fallback? Copy for users without signal? | OPEN | Sally (UX) | E4-S1 (`LoginPage.tsx` OTP panel) — dev-mode copy only | SMS-only for MVP. The dev environment uses `LogSmsOtpProvider` (console output) and the production path wires the Twilio provider behind the `SmsOtpProvider` interface (E0-S4). Voice fallback is explicitly outside PRD §14 scope. Deferred: the copy for a no-signal user has not been written. The OTP panel currently ships a wrong-code path (`Invalid code. Try again.`) and an auto-advancing 6-digit input, but there is **no resend affordance and no client-side attempt counter** — the mock-OTP route does not enforce the 3-attempt cap server-side, so `LoginPage.tsx` decrements a local counter that has no server counterpart. Both the resend/cooldown UI and the server-side cap need work before this item can be closed. Revisit when a real SMS provider ships. | 2026-10-07 | 2026-10-26 |

---

## Partially Resolved

| # | Question | Status | Owner | Affects | Decision / Deferral | Created | Updated |
|---|----------|--------|-------|---------|--------------------|---------|---------|
| 6 | Accessibility: keyboard navigation through AvailabilityCalendar, screen-reader labels for status badges, focus management in OTPModal and ConflictModal | PARTIALLY RESOLVED | Sally (UX) + Amelia (Dev) | E7-S5 (`spec-7-5-accessibility-baseline-wcag-2-1-aa.md`) | **Resolved** — status-badge labelling and modal focus management. E7-S5 ships a global `:focus-visible` ring, a 40×40 mobile touch-target floor, `prefers-reduced-motion` support, glyph prefixes on every status pill, and a focus trap + focus restoration on `ConflictModal` (now `role="alertdialog"`). Covered by `apps/web/test/a11y-focus-ring.test.ts`, `a11y-status-pills.test.ts`, `a11y-touch-targets.test.ts`. **Deferred** — AvailabilityCalendar keyboard navigation. No calendar component exists yet, so there is nothing to make navigable; this moves to the same future story that resolves open item #1. | 2026-10-07 | 2026-10-26 |

---

## Resolved

| # | Question | Status | Owner | Decided in | Affects | Decision / Deferral | Created | Updated |
|---|----------|--------|-------|-----------|---------|--------------------|---------|---------|
| 2 | Bulk conflict resolution: can F-09 / E6-S2 resolve multiple affected rows in one go, or only one at a time? | DECIDED | Amelia (Dev) | E6-S2 (`spec-6-2-ui-doctor-conflict-move.md`) | `DoctorAffected.tsx` | **One at a time.** The affected queue renders as a kanban (To do / In progress / Resolved), and the resolve flow operates on a single row. UX rationale: the impact text and branch context differ per row, so a bulk action would hide the per-row decision that the conflict-resolution flow exists to surface. Reopen only if follow-up audit evidence shows a real workflow bottleneck. | 2026-10-07 | 2026-10-26 |
| 3 | In-progress reschedule cancellation: confirm no tentative holds (E7-S7) | DECIDED | Winston (Architect) | E7-S7 (`spec-7-7-no-tentative-client-side-slot-holds.md`) | `apps/web/test/no-tentative-holds.test.ts`, `apps/api/test/no-tentative-holds-concurrent.test.ts` | **No holds — confirmed.** Architecture principle 2 ratified. The client never assumes a slot is bookable from stale data and never holds a slot outside the booking transaction. The dynamic half proves the server contract: two concurrent bookings for the same slot yield exactly one `201` and one `409 slot_raced`, with exactly one appointment row and exactly one audit row. | 2026-10-07 | 2026-10-26 |
| 5 | Empty states: what does an empty doctor schedule or empty receptionist day look like? | DECIDED | Sally (UX) | E2-S1 (`AdminDoctorSchedule.tsx`), E5-S4 (`ReceptionistToday.tsx`), E6-S1 (`RecurringPreviewPage.tsx`) | `AdminDoctorSchedule.tsx`, `ReceptionistToday.tsx`, `RecurringPreviewPage.tsx` | **Each surface ships an inline empty state** (not a separate empty-state card). Doctor schedule renders a per-day empty row (`styles['day-empty']`). Receptionist today renders `No appointments on <date>.` — and a distinct variant, `No appointments match "<search>" on <date>.`, when a filter narrows the list to zero. Recurring preview renders its "will be skipped" split with reasons, so a fully-skipped series is explained rather than blank. No further work. | 2026-10-07 | 2026-10-26 |

---

## Traceability

| UX-FLOWS §7 # | Question (abbreviated) | Parking-lot status | Consuming story / file |
|---|---|---|---|
| 1 | Calendar visualization | OPEN | — |
| 2 | Bulk conflict resolution | DECIDED | E6-S2 — `DoctorAffected.tsx` |
| 3 | In-progress reschedule cancellation | DECIDED | E7-S7 — no-tentative-holds tests |
| 4 | OTP UX / no-signal copy | OPEN | E4-S1 — `LoginPage.tsx` OTP panel |
| 5 | Empty states | DECIDED | E2-S1, E5-S4, E6-S1 UI |
| 6 | Accessibility | PARTIALLY RESOLVED | E7-S5 (a11y tests) + future calendar story |
