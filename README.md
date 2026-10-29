# Clinic Scheduling

A multi-branch clinic appointment scheduling system: patients book, reschedule and
cancel by phone; doctors manage their schedule and resolve conflicts; receptionists
run the branch day; administrators own the clinic structure.

The API is the single source of truth for availability. The UI shows slots; only the
server may grant or release one.

---

## Table of contents

- [Stack](#stack)
- [Repo layout](#repo-layout)
- [Two documentation flows](#two-documentation-flows-read-this-before-writing-docs)
- [Local setup](#local-setup)
- [Database](#database)
- [Running the app](#running-the-app)
- [Tests](#tests)
- [The API surface](#the-api-surface)
- [Roles and authorization](#roles-and-authorization)
- [The login screens](#the-login-screens)
- [Design system](#design-system)
- [Known deferrals](#known-deferrals)

---

## Stack

| Layer    | Choice                                                          |
|----------|-----------------------------------------------------------------|
| Runtime  | Node ≥ 20, TypeScript 5.6 (strict)                              |
| Monorepo | pnpm workspaces (`pnpm@12.3.4`)                                 |
| API      | Express 4.21, `pg` 8.13, `pino` 9.5, JWT (HS256)                |
| Database | PostgreSQL (local dev container)                                 |
| Web      | React 18.3, Vite 5.4, hand-rolled hash router (no router dep)   |
| E2E      | Playwright 1.64 (Chromium only, single worker)                   |
| Tests    | `node:test` + `supertest` (API), `node:test` (web static), Playwright (browser) |

There is **no ORM and no migration framework beyond `node-pg-migrate`** — the API
writes SQL directly. That is deliberate: the availability engine and the slot-race
guards depend on exact query shapes and on transaction boundaries that an ORM would
abstract away.

---

## Repo layout

```
apps/
  api/                      Express API
    src/
      routes/                One file per route family
      auth/                  JWT sign/verify, claim shape, config
      db/                    Pool, migrations runner
      middleware/            Auth, logging, error shaping
      app.ts                 Route mounting (the seam to read first)
    db/
      migrations/            Forward-only SQL migrations (0001…)
      seeds/                 01_minimum → 02_role_ids → 03_rich_operations
    test/                    One test file per route family (01…20)
    scripts/                 db-reset, seed-demo, verify-* probes
  web/                      React SPA
    src/
      pages/                 One file per screen
      api/client.ts          Every API call in the app
      auth/store.ts          Session store (localStorage)
      router/                Hash router for the admin shell
      styles/                Design tokens (tokens.css)
    test/                    Static/unit runners (node:test)
    e2e/                     Playwright specs
      flows/                 One spec per user journey
      helpers/               API + fixture helpers
docs/                       Human-facing spec (PRD, BRD, UX flows, design)
_bmad-output/               BMAD planning + implementation artifacts
```

### Where to start reading code

1. `apps/api/src/app.ts` — every route is mounted here, with a comment explaining
   *why* it is mounted at that point in the chain. The ordering is load-bearing
   (auth middleware before most routes; `adminScope` on the admin family).
2. `docs/specs/PRD.md` — the requirements, with stable `FR-xxx` / `BR-xxx` IDs.
3. `_bmad-output/planning-artifacts/architecture.md` — the invariants that must
   hold for any change.
4. `apps/api/src/routes/availability.ts` — the core availability engine.

---

## Two documentation flows (read this before writing docs)

This repository carries **two** documentation systems. They are not interchangeable,
and mixing their conventions is the most common way to produce a document nobody
can use.

### A. `docs/` — the human-facing specification

| File                          | What it is                                                        |
|-------------------------------|-------------------------------------------------------------------|
| `docs/specs/BRD.md`           | Business requirements (`BR-xxx`)                                   |
| `docs/specs/PRD.md`           | Product requirements (`FR-xxx`), MVP scope, acceptance scenarios   |
| `docs/specs/UX-FLOWS.md`      | System flows `F-01…F-19`, component table, cross-cutting rules      |
| `docs/design/DESIGN-SYSTEM.md`| Design tokens and their CSS variable mapping — a **contract**       |
| `docs/design/open-questions.md` | Parked design decisions                                          |
| `docs/A…D-*/`                | Product brief, trigger map, UX scenarios, UX design                 |

**Rule:** `BR-xxx` / `FR-xxx` / `F-xx` IDs are **stable**. Never renumber or reuse
them. When behaviour changes, amend the text and add a dated note under a
"Reconciliation" heading rather than silently rewriting history.

### B. `_bmad-output/` — the BMAD build-tracking flow

| Path                                     | What it is                                       |
|------------------------------------------|--------------------------------------------------|
| `planning-artifacts/`                    | `architecture.md`, `epics-and-stories.md`        |
| `implementation-artifacts/sprint-status.yaml` | **The task tracker.** Every story key + a prose record of what shipped |
| `implementation-artifacts/spec-*.md`     | A **spec file** per story (see below)            |
| `implementation-artifacts/epic-7-backlog-specs-index.md` | Batch index for a spec-stub pass |

#### The spec-file format

Every story that touched code has one. The section order is stable:

```markdown
---
title: 'W12 — <short title>'
type: 'feature' | 'bugfix' | 'refactor'
created: 'YYYY-MM-DD'
status: 'done' | 'review' | 'ready-for-dev'
review_loop_iteration: 0
baseline_commit: '<sha>'
context:
  - '{project-root}/<path/to/related/doc.md>'
---

## Intent              # the problem, and why the old behaviour was wrong
## Boundaries & Constraints   # what must NOT change
## I/O & Edge-Case Matrix     # inputs → outputs, including the failure cases
## Code Map            # which files changed and why
## Reuse of existing code
## Verification        # what was run, and the actual results
## Spec Change Log    # SC1, SC2… — deviations, with reasons
## Deferrals           # what was deliberately left undone
## Cross-References    # BR/FR/PRD §/story IDs
```

The `Spec Change Log` is not optional. If the implementation diverged from the
plan — even slightly — record it there with a reason. That section is what makes
the artifact useful to the next person.

#### Adding a story

1. Add the spec file to `implementation-artifacts/`.
2. Add a key to `sprint-status.yaml` under `development_status:` with a prose block
   above it recording what shipped and what was verified.
3. Update the `last_updated:` header.

---

## Local setup

### Prerequisites

- Node ≥ 20
- pnpm 12.3.4 (`corepack enable`)
- PostgreSQL on `localhost:5432`
- Docker Desktop — **only** for the API test suite (see [Tests](#tests))

### Install

```bash
pnpm install
```

### Environment

Copy `.env.example` to `.env` at the repo root. The API reads it via
`apps/api/scripts/_load-env.ts` and refuses to boot without `AUTH_SECRET`
(32+ bytes).

```bash
cp .env.example .env
```

The defaults assume a local Postgres with database `medislot` and credentials
`medislot`/`medislot`.

---

## Database

Migrations are forward-only SQL files in `apps/api/db/migrations/`, applied by
`node-pg-migrate`. The applied-migration ledger lives at
`apps/api/db/migrations/.applied.json`.

```bash
pnpm db:migrate                  # apply pending migrations
pnpm --filter @clinic/api run db:seed      # baseline seed only
pnpm --filter @clinic/api run db:seed:rich # baseline + rich operational seed
pnpm --filter @clinic/api run db:reset     # drop schema → migrate → seed (both)
```

### The three seeds

| Seed                   | What it gives you                                                        |
|------------------------|--------------------------------------------------------------------------|
| `01_minimum.ts`        | The baseline: one clinic, branches, doctors, receptionists, an admin, appointment types, schedules, and five patients. |
| `02_role_ids.ts`       | Role id constants shared by the other seeds.                             |
| `03_rich_operations.ts`| **The rich seed.** Adds staff `password_hash` credentials, doctor blocks, full-status appointment history, a recurring series, and an audit trail. |

**`db:reset` runs the baseline *and* the rich seed.** The baseline seed alone
leaves `password_hash` NULL on every staff account, which means the API's
dev-only email-only login path is still reachable — the staff sign-in form
refuses a blank password, but the API will still honour an email-only request in
`NODE_ENV=development`. Seed the rich data if you want staff to sign in with a
password.

### Dev credentials

All seeded staff accounts share one password: **`Clinic@12345678`**

| Role        | Email                          |
|-------------|--------------------------------|
| Admin       | `admin-main@clinic.local`      |
| Doctor      | `dr.-east-lead@clinic.local`   |
| Receptionist| `receptionist-east@clinic.local`|

---

## Running the app

```bash
pnpm dev
```

This runs both workspaces in parallel:

- **API** — `http://localhost:3001` (`/healthz` for liveness, `/readyz` for readiness)
- **Web** — `http://localhost:5173`

The web app is **hash-routed**, so the entry point is `http://localhost:5173/#/`.
The Vite dev server proxies every API path prefix to `:3001` — see
`apps/web/vite.config.ts` for the list. **A missing prefix is not proxied**: Vite
answers from the SPA fallback and returns 404 with an HTML body, which the client
surfaces as `api_404:unknown_error`. If a new route prefix 404s in the browser but
works in Postman, add it to that proxy map.

---

## Tests

Three tiers, each with different requirements.

### 1. API tests — need a container runtime

```bash
pnpm --filter @clinic/api run test
```

Runs `node:test` against a **real PostgreSQL** started by `testcontainers`. It
**requires Docker** (or another container runtime) to be running — with the daemon
down the suite fails immediately with `Could not find a working container runtime
strategy`, before a single test executes.

- 425 tests across 21 files — one per route family, plus a concurrency suite.
- The suite is destructive: it drops and recreates its own database. It never
  touches your dev database.

### 2. Web unit / static tests — no dependencies

```bash
pnpm --filter @clinic/web run test:phone-number
```

There is no umbrella test runner for the web package; each runner is separate
because they cover unrelated concerns. The `test` script itself is a placeholder
(`echo 'no web tests in E0-S1'`) — it does **not** run the checks below. Run the
individual scripts.

| Script                   | Covers                                                     |
|--------------------------|------------------------------------------------------------|
| `test:phone-number`      | E.164 normalisation and the single-input phone field        |
| `test:api-error-body`    | Error envelope shape on the client                          |
| `test:recurring-client`  | Recurring-series client helpers                            |
| `test:reception-schedule`| Reception availability rendering                           |
| `test:e7-s1`             | Token-only CSS invariant (no hex/rgb/hsl outside tokens)   |
| `test:e7-s4`             | `ConflictModal` is the only conflict modal                 |
| `test:e7-s5-focus`       | Global focus ring                                           |
| `test:e7-s5-pills`       | Status pills carry a colour-independent marker              |
| `test:e7-s5-touch`       | Touch-target and reduced-motion rules                       |
| `test:e7-s7`             | No tentative client-side slot holds                         |

### 3. E2E — need a running API, a seeded DB, and a browser

```bash
pnpm --filter @clinic/web run test:e2e
```

Prerequisites:

1. A **seeded** database (`pnpm --filter @clinic/api run db:reset`) reachable at
   the `DATABASE_URL` in `.env`.
2. Playwright browsers installed (`npx playwright install chromium`).

Playwright boots the dev stack itself — the `webServer` block in
`playwright.config.ts` runs `pnpm dev` and waits for `:5173`, reusing an already-
running server in local mode. The API must therefore be able to reach your
Postgres.

`e2e/auth.setup.ts` runs once as the Playwright `globalSetup`. It wipes
test-prefixed appointment rows first (via `apps/api/scripts/reset-test-appointments.ts`
— the API forbids `DELETE` on appointments, so this script is the only clean
way), then obtains a real token per role through the API and writes a
`storageState` into `apps/web/e2e/.auth/` (gitignored). It obtains tokens
through the API rather than by driving the login UI, so the login specs can
still assert on the form itself.

Specs live in `apps/web/e2e/flows/`, one per journey:

| Spec                          | Covers                                            |
|-------------------------------|---------------------------------------------------|
| `complete-user-journey.spec.ts`| The full patient path, end to end                |
| `login-split.spec.ts`         | The three login screens stay separate            |
| `staff-login.spec.ts`         | A staff password is required                     |
| `staff-nav.spec.ts`           | Staff navigation                                 |
| `receptionist-audit.spec.ts`  | The receptionist audit drawer                    |
| `phone-number.spec.ts`        | International phone entry                        |
| `reschedule.spec.ts`          | Patient rescheduling                             |
| `admin-doctor-specialty.spec.ts` | Admin specialty editing                       |

### Before you commit

```bash
pnpm typecheck   # both packages
pnpm lint        # both packages
pnpm build       # web production build
```

---

## The API surface

Every route is mounted in `apps/api/src/app.ts`. The prefix is the first segment
after the origin.

| Prefix            | Auth                          | What it is                                    |
|-------------------|-------------------------------|-----------------------------------------------|
| `/healthz`, `/readyz`, `/metrics` | none           | Liveness, readiness, Prometheus metrics        |
| `/public/*`       | any authenticated caller      | Trimmed catalog for the patient pickers        |
| `/staff-catalog/*`| any authenticated caller      | Full catalog for doctor / receptionist pickers |
| `/admin/*`        | **admin only** (`adminScope`) | Clinic structure, doctors, types, stats, staff passwords |
| `/auth/login/staff`, `/auth/me` | — | Staff sign-in and session introspection |
| `/patient/*`      | patient (self-scoped)         | OTP, profile, appointments, cancel, reschedule, recurring, deep link |
| `/doctor/*`       | doctor (self-scoped)          | Conflict resolution, affected queue, recurring series, own-appointment audit |
| `/reception/*`    | receptionist (branch-scoped)   | Today's branch view, availability, appointment audit |
| `/appointments/:id/mark-status` | doctor or receptionist | Mark Completed / No-show                 |
| `/bookings`, `/availability`, `/recurring/*` | mixed | Booking core, availability engine, recurring preview/confirm |

### Two catalogs, deliberately

- **`/public/*`** returns a **trimmed** shape: no `branches`, no `email`, no
  `is_active`, and the list is wrapped in an object. It is for patients.
- **`/staff-catalog/*`** returns the **same shapes as `/admin/*`** but is open to
  any authenticated caller. It is for doctor and receptionist pickers.

They are not interchangeable. The doctor and receptionist screens need `email` and
`branches` off a doctor row; switching them to `/public/*` would have meant
rewriting their filtering logic.

---

## Roles and authorization

Authorization is a **server** concern. The UI hides things the server would
refuse anyway — it is never the enforcement point.

| Role          | Scope                                    | Notes                                                    |
|---------------|------------------------------------------|----------------------------------------------------------|
| `patient`     | Self. Identity **is** the phone number.  | Sees only their own appointments; other patients' rows return 404, not 403. |
| `doctor`      | Self-scoped via `doctor_branch`          | Sees their own appointments and the audit trail for them. |
| `receptionist`| Branch-scoped                             | Sees the branch day, and the audit trail for that branch's appointments. |
| `admin`       | Clinic structure                          | **Never** sees individual appointments — the admin audit route returns a policy envelope, not data. |

Two rules worth stating explicitly because they surprise people:

- **A patient asking for another patient's appointment gets `404`, not `403`.**
  A 403 would confirm the appointment exists. The same envelope is used for
  "does not exist" and "exists but is not yours".
- **The admin role cannot read individual appointments at all.** `/admin/audit`
  returns `{appointments_audit_reads: "rejected_per_role_policy", ...}` with 200.

### `No-show`, not `No-Show`

The `appointment_status` DB enum is `{Scheduled, Completed, Cancelled, No-show}` —
**lowercase `s`** — and the API mirrors the enum verbatim on the wire. Sending
`'No-Show'` is rejected with `400 invalid_status`.

---

## The login screens

The login is three screens, not one page with two cards:

| Hash              | Screen           | For                                  |
|-------------------|------------------|--------------------------------------|
| `#/login`         | `LoginChooser`   | The app root's landing screen        |
| `#/login/staff`   | `StaffLoginPage` | Role + email + **required** password |
| `#/login/patient` | `PatientLoginPage` | Phone + 6-digit OTP                 |

With no hash at all, the reader returns `choose`, so a bare `page.goto('/')` still
lands on a usable login screen. An unrecognised hash also falls back to the
chooser.

**The staff password is required.** It used to be optional, and a blank field fell
through to the API's dev-only email-only path — which minted a valid token for
anyone who knew a seeded staff address. The form now refuses a blank password in
the UI, and the submit button stays disabled until one is typed.

Hash constants live in `apps/web/src/auth/login-hashes.ts` rather than in `pages/`
so the auth store can reset the URL on sign-out without importing from `pages/`
(a layering inversion).

---

## Design system

`docs/design/DESIGN-SYSTEM.md` is a **contract**: token names map 1:1 to CSS
variables, and drift is a bug.

The live tokens are in `apps/web/src/styles/tokens.css`. **All CSS must use
tokens** — no hex literals, no `rgb()`/`rgba()`, no `hsl()`, no named colours.
This is enforced by `test:e7-s1`, which walks every CSS and TSX file and fails on
a violation. If you need a colour that does not exist, add a token.

Additional invariants with their own tests:

- `ConflictModal` is the only conflict modal (`test:e7-s4`).
- Status pills carry a colour-independent glyph, so meaning survives a
  colour-blind reader or a stripped stylesheet (`test:e7-s5-pills`).
- Focus rings, touch targets, and reduced-motion are global rules
  (`test:e7-s5-focus`, `test:e7-s5-touch`).

---

## Known deferrals

These are deliberate, and each is recorded in a spec file's `Deferrals` section.

| Item                       | Status                                                                |
|----------------------------|-----------------------------------------------------------------------|
| **The four new e2e specs** | `login-split`, `staff-login`, `staff-nav`, `receptionist-audit` are written but **have not been run against a live API**. Run them once the dev stack is up. |
| Token refresh / denylist   | The JWT is not refreshed and not revocable before expiry.             |
| Rate limiting              | No brute-force protection on the login routes.                          |
| Account lockout            | No lockout after N failed attempts.                                    |
| SSO                        | Staff auth is password-only.                                            |
| `x-auth-claim` dev header  | A dev-mode auth shortcut still exists in the web client.               |
| Patient `sub` is the phone | A patient's JWT subject is their phone number — PII, and mutable. A synthetic `patient.id` UUID would be better. |
| Branch timezone            | Documented in a spec file, not enforced by a regression test.          |
| Per-page WCAG audit        | The global a11y rules are locked by static tests; per-page `axe` validation is deferred. |

---

## Contributing

1. **Read the spec first.** `docs/specs/PRD.md` for the requirement,
   `_bmad-output/planning-artifacts/architecture.md` for the invariant it must
   not break.
2. **Write or update the spec file** for your story under
   `_bmad-output/implementation-artifacts/`, and add the story key to
   `sprint-status.yaml`.
3. **Never renumber `FR-` / `BR-` / `F-` IDs.** Amend the text and add a dated
   reconciliation note.
4. **Do not weaken an invariant** to make a test pass. If an invariant is wrong,
   change it deliberately — in the spec, in the code, and in the spec change log.
5. **Run the tests you can.** API tests need Docker; web static tests do not.
   Say which ones you ran, and which you could not, in the story record.
