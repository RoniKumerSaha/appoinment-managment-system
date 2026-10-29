---
id: spec-7-10-design-open-questions-parking-lot
title: E7-S10 — Design open questions parking lot
epic: epic-7
status: ready-for-dev
review_loop_iteration: 0
created: 2026-10-07
last_updated: 2026-10-07
source_story: planning-artifacts/epics-and-stories.md §E7-S10
---

# E7-S10 — Design open questions parking lot

## Intent

UX-FLOWS §8 lists six items that were "not yet decided" at the time the planning artifact was written. This story doesn't **answer** the questions — that's UX / PM work — but it ships the **parking lot**: a single, queryable, dated document that captures the current state, the decision owner, the target epic/story, and the explicit deferral rationale.

**Why a parking lot rather than a series of stories:** some items will turn into stories once decided (e.g., "day / week / month view for doctor dashboard" becomes a `7-12` story). Others are intentional deferred-then-never decisions (e.g., "SMS-only OTP" is fine for MVP and unlikely to need a separate work item). The parking lot is the source of truth; stories are spawned from it, not the other way around.

### 1. Parking lot document

**File:** `docs/design/open-questions.md` (NEW).

The document is a single markdown table per item, with these columns:

| # | Question | Status | Owner | Decided in | Affects | Decision / Deferral | Created | Updated |
|---|----------|--------|-------|-----------|---------|--------------------|---------|---------|

Items at authoring time (mirror the planning-artifact list, dated 2026-10-07):

| # | Question | Status | Owner | Affects | Decision / Deferral |
|---|----------|--------|-------|---------|--------------------|
| 1 | Calendar visualization: day / week / month view for doctor and receptionist dashboards? | OPEN | Sally (UX) | A future dashboard story (post-MVP) | No decision in MVP. Doctor dashboard ships with the affected-queue kanban (E6-S2) and the today view (E5-S1/S2). When a calendar story lands, decide at that time. |
| 2 | Bulk conflict resolution: can F-09 / E6-S2 resolve multiple affected rows in one go, or only one at a time? | DECIDED | Amelia (Dev) | E6-S2-ui | One-at-a-time. The kanban shows the queue; the resolve flow operates on a single row. UX reason: the impact text + branch context differ per row; bulk would hide the per-row decision. Reopen only if a follow-up audit shows a real workflow bottleneck. |
| 3 | In-progress reschedule cancellation: confirm no tentative holds (E7-S7) | DECIDED | Winston (Architect) | E7-S7 | No holds. Architecture principle 2 ratified. |
| 4 | OTP UX: SMS only, or voice fallback? Copy for users without signal? | OPEN | Sally (UX) | E4-S1 (real OTP) | SMS only for MVP. The current dev mode uses a console log; production wires the Twilio mock (E0-S4). Voice fallback is not in PRD §14 scope. Defer. |
| 5 | Empty states: doctor schedule, receptionist day, recurring preview | DECIDED | Sally (UX) | E2-S1-ui, E5-3-4-ui, E6-S1-ui | Empty states shipped in each respective UI story: doctor schedule shows a "No working hours set" card with an "Add hours →" CTA; receptionist today shows "No appointments today" with the next-day's first appointment link; recurring preview shows "No occurrences to create" + the proposed schedule + "Cancel". No further work. |
| 6 | Accessibility: keyboard navigation through AvailabilityCalendar, screen-reader labels for status badges, focus management in OTPModal and ConflictModal | PARTIALLY DECIDED | Sally (UX) + E7-S5 | E7-S5, future | ConflictModal focus management covered by E7-S5. Status-pill icon prefix covered by E7-S5. AvailabilityCalendar keyboard nav: no calendar yet, deferred to when a calendar component lands. OTPModal: covered by E7-S5 (modal focus trap). |

### 2. Reuse

The document is a *living* parking lot. New items get appended; "OPEN" items move to "DECIDED" with a date; "DECIDED" items move to a separate "Resolved" section at the bottom (preserved for audit trail, not deleted).

### 3. Spec + sprint-status

- This doc.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — `7-10-design-open-questions-parking-lot: done`.

## Files to change

| Path | Kind | What |
|------|------|------|
| `docs/design/open-questions.md` | NEW | Parking lot |
| `_bmad-output/implementation-artifacts/spec-7-10-design-open-questions-parking-lot.md` | NEW | Spec |
| `_bmad-output/implementation-artifacts/sprint-status.yaml` | EDIT | Story → done |

## I/O & Edge-Case Matrix

| Scenario | Outcome |
|---|---|
| New open question raised | Append to "Open" section with date + owner |
| Question answered | Move to "Resolved" section; cross-link to the story that consumed it |
| New dashboard story created from #1 | Update the table; link the story key |
| Story owner changed (e.g., Amelia → new agent) | Update the Owner column with date |
| ConflictModal focus audit (#6) closes | Update the "DECIDED" entry; link the commit hash |

## Verification

1. `docs/design/open-questions.md` is committed and lists every UX-FLOWS §8 item.
2. The 6 items from UX-FLOWS §8 are present, each with a status (DECIDED or OPEN), an owner, and a cross-link to the story that resolved or will resolve it.
3. The document is dated 2026-10-07 (authoring date).
4. `pnpm --filter @clinic/web typecheck` — 0 new errors (this is docs-only; typecheck unchanged).
5. `pnpm --filter @clinic/api typecheck` — 0 new errors (3 pre-existing baseline unchanged).

## Deferrals (anticipated)

- **D1 — Story creation from OPEN items.** When Sally (UX) decides on calendar visualization (item #1), a new `7-12` story will be created with the decision recorded. This story does not block on that work.

## Spec Change Log

(none yet — first authoring)