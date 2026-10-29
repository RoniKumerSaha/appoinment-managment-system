---
last_updated: 2026-10-29T07:39:58Z
total_decisions: 0
---

# Decision Index

This index tracks all Architecture Decision Records (ADRs) created during Construction bolts.
Use this to find relevant prior decisions when working on related features.

## How to Use

**For Agents**: Scan the "Read when" fields below to identify decisions relevant to your current task. Before implementing new features, check if existing ADRs constrain or guide your approach. Load the full ADR for matching entries.

**For Humans**: Browse decisions chronologically or search for keywords. Each entry links to the full ADR with complete context, alternatives considered, and consequences.

---

## Decisions

<!-- Entries are appended below in reverse chronological order (newest first) -->
<!-- Format for each entry:

### ADR-{n}: {title}
- **Status**: {proposed|accepted|deprecated|superseded}
- **Date**: {YYYY-MM-DD}
- **Bolt**: {bolt-id} ({unit-name})
- **Path**: `bolts/{bolt-id}/adr-{n}-{slug}.md`
- **Summary**: {First sentence from Context}. {First sentence from Decision}.
- **Read when**: {Agent guidance - domain keywords and scenarios when this ADR is relevant}

-->

---

## Pre-existing architectural decisions

No ADR bolts have been run in this AI-DLC flow, so the index above is
empty. The architectural decisions that **do** exist in this repository
predate the memory bank and are recorded in prose, in
`standards/system-architecture.md`. They are summarised here because
they constrain future work in exactly the way an ADR would.

### ADJ-1: No ORM — raw `pg` with hand-written SQL
- **Status**: accepted
- **Date**: pre-existing (before 2026-10-29)
- **Path**: `memory-bank/standards/data-stack.md` § "Decision Relationships"
- **Summary**: The API talks to PostgreSQL through the `pg` driver with
  hand-written SQL and hand-written transactions. The availability engine
  and the slot-race guards depend on exact query shapes and on
  transaction boundaries that an ORM would abstract away.
- **Read when**: Adding a data-access layer, introducing a query
  builder, or writing any query that must interact with the GIST
  exclusion constraint.

### ADJ-2: Database constraints enforce the core booking rules
- **Status**: accepted
- **Date**: pre-existing
- **Path**: `memory-bank/standards/data-stack.md` § "Database"
- **Summary**: Double-booking is prevented by a GIST exclusion
  constraint; one future appointment per doctor per patient is
  prevented by a partial unique index. The application still
  pre-validates to give a useful error message, but the constraint is
  what makes the rule true under concurrency.
- **Read when**: Writing a booking, cancel, reschedule or move path;
  mapping a SQLSTATE to an HTTP status.

### ADJ-3: The server is the sole authority on availability
- **Status**: accepted
- **Date**: pre-existing
- **Path**: `memory-bank/standards/system-architecture.md` § "Key Invariants" #1
- **Summary**: The UI shows slots; only the server may grant or release
  one. There are no tentative client-side holds.
- **Read when**: Designing any UI that displays or selects a time slot.
  Enforced by `apps/web/test/no-tentative-holds.test.ts`.

### ADJ-4: No refresh-token mechanism
- **Status**: accepted (deferred hardening)
- **Date**: pre-existing
- **Path**: `memory-bank/standards/tech-stack.md` § "Authentication"
- **Summary**: There is no refresh token, no refresh endpoint and no
  refresh claim. The client treats a token as expired 60 seconds before
  its actual expiry and signs the user out rather than silently
  refreshing.
- **Read when**: Adding a session-lifetime feature, or changing the
  client-side expiry margin.

### ADJ-5: Hand-rolled HS256 JWT, signature verified before claim shape
- **Status**: accepted
- **Date**: pre-existing
- **Path**: `memory-bank/standards/system-architecture.md` § "JWT"
- **Summary**: No auth library. The signature is checked before the
  claim shape using `timingSafeEqual`, because the reverse order leaks
  through timing whether a token had a valid signature. Unknown extra
  claim fields are rejected.
- **Read when**: Touching `apps/api/src/auth/jwt.ts`, adding a claim
  field, or changing the token payload shape.

### ADJ-6: The admin role has no appointment-audit read
- **Status**: accepted
- **Date**: pre-existing
- **Path**: `memory-bank/standards/api-conventions.md` § "Authorization"
- **Summary**: Admin authority over individual appointments is
  enforced by omission — no appointment routes are mounted under
  `/admin`. `GET /admin/audit` returns a 200 policy envelope explaining
  why, rather than an error or data.
- **Read when**: Adding an admin route, or mounting an existing
  appointment route under `/admin`.

### ADJ-7: Hash routing, admin-only
- **Status**: accepted
- **Date**: pre-existing
- **Path**: `memory-bank/standards/ux-guide.md` § "Routing"
- **Summary**: The admin shell uses a hand-rolled hash router because
  the Vite dev proxy forwards unknown paths to the API, so a
  `history.pushState` route would 404 on refresh. The patient, doctor
  and receptionist apps are self-contained state machines.
- **Read when**: Adding an admin page or a new top-level route.

### ADJ-8: The design system is a contract
- **Status**: accepted
- **Date**: pre-existing
- **Path**: `memory-bank/standards/ux-guide.md` § "The token layer"
- **Summary**: Token names map 1:1 to CSS variables and no colour
  literal may appear outside `tokens.css`. Drift is a bug.
- **Read when**: Adding any visual value. Enforced by
  `apps/web/test/token-only-css.test.ts`.

### ADJ-9: `ConflictModal` is a singleton
- **Status**: accepted
- **Date**: pre-existing
- **Path**: `memory-bank/standards/ux-guide.md` § "The ConflictModal"
- **Summary**: One shared three-slot conflict modal (what / why /
  canDo), used by every flow that surfaces a server conflict. A second
  conflict-shaped dialog is a regression, not a style preference.
- **Read when**: Building any error or conflict surface. Enforced by
  `apps/web/test/conflict-modal-singleton.test.ts`.
