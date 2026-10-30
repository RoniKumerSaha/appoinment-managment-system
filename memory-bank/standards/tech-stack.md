# Tech Stack

## Overview

A pnpm-workspace TypeScript monorepo with an Express 4 API over PostgreSQL
and a React 18 SPA. The API writes SQL directly through `pg` and the web
client is hand-rolled (no router library, no state library, no ORM) — every
abstraction that was deliberately left out is one the availability engine's
correctness depends on.

## Languages

**TypeScript 5.6** (strict) for both packages. **SQL** for the database.
**JavaScript** for a handful of tooling scripts (`.mjs` test drivers,
`eslint.config.cjs`).

Rationale: strict mode plus `noUncheckedIndexedAccess` is what makes the
slot-generation arithmetic checkable — a missing row and an empty row are
different states, and the compiler forces the distinction to be handled
rather than papered over with `!`.

Module conventions differ per package and are load-bearing:

| Package | Relative import style | Why |
|---|---|---|
| `apps/api` | **with** `.js` extension — `from '../auth/jwt.js'` | NodeNext ESM resolution. The source is `.ts` but the emitted specifier must be `.js`. |
| `apps/web` | **without** extension — `from '../api/client'` | Vite/`Bundler` module resolution. |

**Do not mix these within a package.**

## Framework

**API**: Express 4.21. **Web**: React 18.3 + Vite 5.4.

Rationale: Express 4 (not 5) is what the code is written against — and it
matters, because Express 4 does **not** await async route handlers. A
`throw` after an `await` becomes an unhandled rejection, which Node turns
into `process.exit(1)` and takes the whole API down. Every router is
therefore registered through `wrapRouter()` in `apps/api/src/app.ts:82-119`
so rejections reach `next(err)`. **A new router that is not added to that
array will kill the process on a rejected promise.**

Rationale (Vite): the dev server proxies API path prefixes to `:3001`. A
prefix missing from that map is *not* proxied — Vite answers from the SPA
fallback and returns a 404 with an HTML body, which the client surfaces as
`api_404:unknown_error`. When adding a route family, add its prefix to
`apps/web/vite.config.ts` in the same change.

## Authentication

**Hand-rolled JWT (HS256)** — no auth library. `apps/api/src/auth/jwt.ts`
signs and verifies with `node:crypto`.

Claims: `sub`, `role`, `branch_ids`, `scope`, optional `doctor_id`, plus
`aud`, `iss`, `jti`, `iat`, `exp`.

Verification is deliberately strict and, in one specific way, ordered:
the **signature is checked before the claim shape** (`jwt.ts:126`), using
`timingSafeEqual`. Checking the shape first would leak, through timing,
whether a token had a valid signature — a claim-shape oracle. Unknown
extra claim fields are rejected (`jwt.ts:191-205`), and `alg`/`typ` are
hard-checked against the expected values (`jwt.ts:139`).

Password hashing is **bcrypt via Postgres `pgcrypto.crypt`** — verified
in-database, not in Node (`apps/api/src/routes/auth-staff.ts:186-190`).

Patient identity is the **phone number**, verified by SMS OTP. There are no
patient passwords and no patient accounts.

Refresh: **none**. There is no refresh token, no refresh endpoint, and no
refresh claim. The client treats a token as expired 60 seconds before its
actual expiry and logs the user out rather than silently refreshing.
This is a known gap, recorded in the README's deferrals table.

## Infrastructure & Deployment

Local development only. The API runs on `:3001`, the web dev server on
`:5173`.

**Docker is required for the API test suite only** — `apps/api/test/db/withTestDb.ts`
starts a `postgres:16-alpine` container through testcontainers, or reuses
an existing `DATABASE_URL` when one is set. With the Docker daemon down the
suite fails immediately with `Could not find a working container runtime
strategy`, before a single test executes.

The database is **PostgreSQL**, expected at `localhost:5432` with database
`medislot` and credentials `medislot`/`medislot`.

Migrations are **forward-only SQL** applied by `node-pg-migrate` in SQL
mode. The schema of record is the `pgmigrations` **table** in the
database; node-pg-migrate's own file ledger lives at
`dist/db/migrations/.applied.json`, inside the build output.

## Package Manager

**pnpm 12.3.4** (`pnpm-workspace.yaml` → `apps/*`, `packages/*`).
`corepack enable` pins the version.

Two live packages: `@clinic/api` and `@clinic/web`. The `packages/*` glob
exists but no package lives there yet.

## Testing

**`node:test` + `node:assert/strict`** on both sides — no Jest, no Vitest,
no Chai.

- **API**: `node --import tsx --test --test-global-setup=test/setup/globalSetup.cjs --test-concurrency=1 test/*.test.ts`
  with `supertest` against a real PostgreSQL. 425 tests across 21 files.
- **Web**: static source scanners and pure-function assertions, one
  `test:<name>` script per suite. The aggregate `test` script is a **no-op
  placeholder** (`echo 'no web tests in E0-S1'`) — it does not run the
  suites. Run the individual scripts.
- **E2E**: removed. The Playwright browser-journey suite was deleted from
  this repository; there is no browser-level automated coverage.

## Decision Relationships

- **No ORM** is the load-bearing decision. The availability engine and the
  slot-race guards depend on exact query shapes and on transaction
  boundaries that an ORM would abstract away. `apps/api/src/routes/bookings.ts:50-56`
  documents a *deliberate* duplication of slot math for exactly this reason.
- **No router library** in the web client: the app is hash-routed, and the
  hash scheme sidesteps the Vite proxy 404 on reload.
- **No state-management library**: React state plus a small module-level
  store backed by `localStorage`, read through `useSyncExternalStore`.
- **No validation library** (zod/yup): validation is hand-rolled per route.
- **No formatter**: formatting is emergent, not enforced. See
  `coding-standards.md` § "Code Formatting".
