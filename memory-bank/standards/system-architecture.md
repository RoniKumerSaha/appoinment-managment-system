# System Architecture

## Overview

A two-tier monorepo: an Express API that owns all scheduling truth over
PostgreSQL, and a React SPA that renders it. There is no service layer and
no shared runtime between them — the API is the single source of truth for
availability, and the web client is a pure consumer that never decides
whether a slot is bookable.

## Architecture Style

**Layered monolith with a fat-controller route layer.**

- `apps/api/src/app.ts` composes everything through a single `createApp()`
  factory. Importing the module has no side effects; `server.ts` binds the
  port.
- Route handlers own **the transaction, the SQL, the role gate and the
  audit write** in one function. There is no service layer and no
  repository layer — for example `routes/staff-mark-status.ts:136-200` does
  `BEGIN` → `SELECT FOR UPDATE` → role gate → status gate → `UPDATE` →
  `INSERT` audit → `COMMIT` inline.

The one real abstraction is the availability engine, split into three files
by responsibility (`apps/api/src/availability/`):

| File | Responsibility |
|---|---|
| `engine.ts` | DB orchestration — queries, transaction, result assembly |
| `slots.ts` | **Pure** interval math — `intersect`, `subtractIntervals`, `mergeIntervals`, `clampToDay`, `buildSlots` |
| `types.ts` | **Pure** time helpers |

Rationale: the interval math is the part most worth testing in isolation
and hardest to test through HTTP, so it is kept free of I/O. The
duplication of a subset of that math inside `routes/bookings.ts`
(`recheckSlotInTxn`) is **deliberate and documented** at `bookings.ts:51-55`
— booking must re-check inside its own transaction, and sharing the
engine's function across that boundary would couple them.

### Middleware chain order

The order in `app.ts` is load-bearing:

1. `express.json({ limit: '64kb' })` — `:125`
2. `logMw` (pino-http) — `:126`
3. `healthRouter`, `metricsRouter` — `:128-129`
4. `/patient` SMS-OTP router, then `/patient` mock-OTP router — `:136`, `:151`
   — **both mounted before authentication**, because they *are* the
   authentication step.
5. `/auth` staff login — `:159` — before authentication, same reason.
6. `authMiddleware` — `:161` ← **the pivot**
7. `/auth/me` — `:166` — after, because it needs a claim.
8. Every other router — `:172-353`
9. `/admin` chain with `adminScope` — `:360`
10. JSON 404 fallthrough — `:364-366`
11. Four-argument error middleware — `:368-392`

### The `wrapRouter` requirement

Express 4 does not await async handlers. A `throw` after an `await`
becomes an unhandled rejection, which Node escalates to `process.exit(1)` —
the whole API dies, with no error response.

`apps/api/src/middleware/async-handler.ts` wraps every handler so
rejections reach `next(err)`. Every router must be registered in the wrap
loop at `app.ts:82-119`.

> **A new router that is not added to that array will kill the process on
> the first rejected promise.**

## Security Patterns

### JWT

Hand-rolled HS256 (`apps/api/src/auth/jwt.ts`) — no auth library.

Claims: `sub`, `role`, `branch_ids`, `scope`, optional `doctor_id`, plus
`aud`, `iss`, `jti` (UUID v4), `iat`, `exp`.

Verification specifics that matter:

- **Signature before claim shape**, using `timingSafeEqual` (`jwt.ts:126`).
  The reverse order would leak through timing whether a token had a valid
  signature.
- `alg` and `typ` are hard-checked against expected values (`jwt.ts:139`).
- Closed enums for `role` and `scope` are enforced at verify time
  (`jwt.ts:164-166`).
- **Unknown extra claim fields are rejected** (`jwt.ts:191-205`).
- 30-second clock skew allowance (`jwt.ts:27`).

### Authorization

`middleware/auth.ts` populates `req.auth = { claim }`. It **never returns
4xx for a bad token** — an invalid token yields `claim = null`, i.e. the
caller is anonymous. The one exception: a staff token with empty
`branch_ids` gets `403 staff_token_requires_branch_ids`.

The request **body is never consulted** for `role`, `branch_ids`, `scope`
or `doctor_id` (`auth.ts:14-18`). Only the verified claim is.

**Only `adminScope` exists as middleware** (`middleware/admin-scope.ts`):

```ts
// no claim        → 401 unauthenticated
// role ≠ 'admin'  → 403 forbidden_role
// scope ≠ clinic  → 403 forbidden_scope
```

Every other role gate is **inline in the route handler** — roughly 20
files re-implement `if (claim.role !== 'doctor') …`. This duplication is
real and is a known inconsistency, not a pattern to imitate. When adding a
route, follow the local convention of the route family, but be aware you
are copying a gate that could have been a middleware.

### Scope semantics

| Role | Bound by | Out of scope response |
|---|---|---|
| Patient | `claim.sub` (the phone number) | `404 not_found` |
| Doctor | `claim.doctor_id` **and** `branch_id ∈ claim.branch_ids` | `403 outside_branch_scope` |
| Receptionist | `branch_id ∈ claim.branch_ids` | `403 outside_branch_scope` |
| Admin | clinic-wide | no individual-appointment routes are mounted under `/admin` |

**"404 not 403" is a patient-only privacy filter**, not a general rule.
`routes/patient-cancel.ts:136-140` returns the *same* envelope for "does
not exist" and "exists but is not yours", because a 403 would confirm the
appointment exists. Staff flows deliberately return 403 instead — the
staff audience already knows the appointment exists.

Admin authority over individual appointments is enforced by **omission**:
no appointment routes are mounted under `/admin`. `GET /admin/audit`
returns a policy envelope rather than data.

## Domain Model

Tables, by migration:

| Table | Migration | Notes |
|---|---|---|
| `clinic`, `branch`, `doctor`, `doctor_branch`, `receptionist`, `admin_user`, `patient` | `0001` | |
| `appointment_type` | `0005` | |
| `doctor_schedule` | `0006` | Keyed by `(doctor_id, branch_id, day_of_week, effective_from)`, multiple periods per day |
| `doctor_block` | `0007` | |
| `appointment` | `0008` | Carries the GIST exclusion constraint |
| `appointment_audit` | `0009` | Append-only |
| `otp_verification`, `sms_otp_send_attempts` | `0010`, `0012` | |
| `branch_weekly_hours` | `0015` | |
| `appointment.recurring_series_id` | `0018` | Recurring linkage |

**Double-booking** is prevented by the GIST exclusion constraint described
in `data-stack.md`. **One future appointment per doctor per patient** is
prevented by a partial unique index. Both are database-level, so they hold
under concurrency regardless of what the application does.

**Recurring series are not a table.** A `recurring_series_id uuid` column
on `appointment` (plus a sparse partial index, `0018:52-54`) links the
occurrences. Once created, each occurrence is an independent appointment
row — cancelling one does not touch its siblings.

## Frontend Architecture

**Hand-rolled hash router** (`apps/web/src/router/usePathRoute.tsx`).

`parsePath()` (`:75-146`) maps `#/admin/{section}` to an `AdminSection`
union, with regex sub-page matches first and prefix fallbacks after.
`usePathRoute()` (`:196-221`) subscribes to `hashchange`. `<Link>`
(`:238-274`) intercepts left-clicks only.

Why hash routing: the Vite dev proxy forwards unknown paths to the API, so
a `history.pushState` route would 404 on refresh.

**Scope limitation** (`:22-24`): the router is **admin-only**. The
patient, doctor and receptionist apps are self-contained state machines
(`App.tsx:195-203`).

**Auth state** — no Context, no Redux, no Zustand. A module-level store
plus `useSyncExternalStore` (`auth/store.ts:42-89`), persisted to
`localStorage` under `medislot.auth`. `useAuth()` returns
`{ stored, expired, isAuthenticated }` with a 60-second expiry margin.

**State management**: React `useState` / `useEffect` / `useMemo` only. The
web package's only runtime dependencies are `react` and `react-dom`.

**API client**: one `request<T>()` helper in `apps/web/src/api/client.ts`
(`:173-216`) is the only way the app talks to the API. It attaches the
bearer token, falls back to a dev-only `x-auth-claim` header when there is
no session at all (`:176-190`), sends **no** credential for an expired
session so the API returns 401, and raises `ApiError(status, code, body)`
for non-2xx.

## Key Invariants

From `_bmad-output/planning-artifacts/architecture.md` §1, which remain the
governing principles:

1. **The server is the single source of truth for availability.** The UI
   shows slots; only the server may grant or release one.
2. **Atomicity over clever UX.** Booking and rescheduling use transactional
   slot reservation. No tentative holds client-side.
3. **Never silently invalidate an appointment.** Schedule and block changes
   that would conflict are *rejected*; branch-hours changes *save and flag*
   for manual resolution.
4. **Patient identity is a phone number.** No passwords, no accounts.
5. **Branch-local time.** Operating hours and slots are in the branch's
   local timezone; timestamps are stored UTC and rendered in
   `appointment.branch.tz`.
6. **Role × Branch authorization is a server concern.** The UI hides things
   the server would refuse anyway; it is never the enforcement point.
7. **Audit by default.** Important appointment events write an audit row.
8. **The design system is a contract.** Token names map 1:1 to CSS
   variables; drift is a bug.

## Divergences from the planning document

`_bmad-output/planning-artifacts/architecture.md` was written **before the
code landed** — its own header says *"The repository is currently
design-only… Code has not landed."* It is a greenfield spine, not a
description of the implementation.

| Planning document says | Implementation does |
|---|---|
| Next.js 15, React 19 | Express 4.21, React 18.3, Vite 5.4 |
| Tailwind v4 | CSS custom properties + CSS Modules |
| Prisma 5 | raw `pg`, hand-written SQL |
| `ErrorEnvelope = {code, what, why, can_do, details}` | flat `{ error: 'snake_case_code' }` |
| SERIALIZABLE isolation | plain `BEGIN` + `SELECT FOR UPDATE` |
| A refresh-token contract (§3.1) | no refresh mechanism at all |
| Next.js routing | hash routing, admin-only |

**The implementation is the contract.** When the two disagree, code must
follow the implementation and the planning document should be corrected —
not the other way round. This is exactly the pattern the W12 reconciliation
applied: where the code was wrong (the `No-show` casing), the code was
changed; where the doc was wrong (the audit-visibility gap), the doc was
changed.

`architecture.md` still remains the best statement of *intent* — its
principles in §1 are correct and are enforced by the code.
