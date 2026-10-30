# Coding Standards

## Overview

Conventions in this repository are **emergent and largely unenforced**: there
is no formatter configured, and the lint config downgrades the two rules
most likely to fire. This file records what the code actually does, and
marks clearly where a convention is *observed* versus *enforced*. An agent
writing new code should follow the observed conventions and rely on the
enforced invariants — which are listed separately under § "Enforced
invariants" below.

## Code Formatting

**Tool**: none. There is **no Prettier config anywhere** in the repo and
Prettier is not a dependency of either package. Formatting is emergent.

**Observed conventions** (from the source, not enforced):

- Single quotes.
- Semicolons.
- Two-space indentation.
- Trailing commas in multi-line literals and parameter lists.
- Relative import width roughly 80–110 characters. **This varies** —
  `apps/api/src/availability/engine.ts:216` runs to 110 chars while
  `apps/api/src/routes/availability.ts:169` is 66.

**Enforcement**: none. Nothing checks formatting in CI.

**Rule for new code**: match the surrounding file. Do not reformat
unrelated lines. 2-space indent, single quotes, semicolons, trailing commas
on multi-line structures.

## Linting

**Tool**: ESLint 8.57.1, legacy `.eslintrc.cjs` format (not flat config).

**Base config**:

```js
// apps/api/.eslintrc.cjs
extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
rules: {
  '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
  '@typescript-eslint/no-explicit-any': 'warn',
  'no-console': 'off',
},
```

```js
// apps/web/.eslintrc.cjs — additionally
extends: [..., 'plugin:react/recommended', 'plugin:react-hooks/recommended'],
settings: { react: { version: '18.3' } },
rules: { 'react/react-in-jsx-scope': 'off', 'react/prop-types': 'off' },
```

**Strictness**: the recommended sets are at `error`; only
`no-unused-vars` and `no-explicit-any` are downgraded to `warn`.

**Key rules**:

- `no-unused-vars`: warn — 14 warnings are committed and accepted. They are
  all in test files and `src/server.ts`. **Do not introduce new ones**,
  but do not treat the existing 14 as a failure either.
- `no-explicit-any`: warn — currently fires zero times. Keep it that way;
  use a discriminated union or `unknown` plus narrowing instead.
- `no-console`: off — the API logs through pino, not console.
- `react/prop-types`: off — TypeScript covers prop types.
- `react/react-in-jsx-scope`: off — the new JSX transform is in use.

No custom rules and no custom plugins. `ignorePatterns` covers `dist/` and
`node_modules/`.

## Naming Conventions

| Element | Convention | Example |
|---|---|---|
| API route file | kebab-case, domain-prefixed | `admin-branch-hours.ts`, `patient-recurring-series.ts` |
| API route helper | kebab-case + `-helpers` suffix | `bookings-helpers.ts`, `recurring-helpers.ts` |
| API router export | camelCase + `Router` suffix | `availabilityRouter`, `patientOtpRouter` |
| API SQL constant | `SCREAMING_SNAKE_CASE` | `SELECT_CLINIC_ID_SQL` |
| API error code | snake_case string literal | `forbidden_role`, `invalid_branch_id` |
| React component | PascalCase `.tsx` | `AdminBranches.tsx`, `ReceptionistAuditDrawer.tsx` |
| Web helper module | kebab-case | `doctor-name.ts`, `staff-nav-items.ts`, `deep-link.ts` |
| Web hook | camelCase, `use` prefix | `usePhoneField.ts`, `usePathRoute.tsx` |
| Test file (API) | `NN-kebab-description.test.ts` | `20-staff-catalog.test.ts` |
| Test file (web) | `kebab-case.test.ts` | `conflict-modal-singleton.test.ts` |
| Test driver (web) | `run-kebab-case.mjs` | `run-token-only-css.mjs` |

**File naming**:

- **Components**: PascalCase `.tsx`, with a co-located stylesheet.
- **Utilities**: kebab-case `.ts` for multi-purpose helpers;
  camelCase for hooks.
- **Tests**: API files carry a zero-padded ordinal prefix because the suite
  is ordered by route family. Web test files do not — they are keyed by
  concern.
- **Non-test helpers in the API test dir** take a leading underscore:
  `_populate-app.ts`, `_globalSetupRun.ts`.

### `.css` vs `.module.css` — mixed, and the split correlates with era

Both forms exist in `apps/web/src/pages/`.

- **`.module.css`** (imported as a default object, accessed as `styles.x`)
  — all admin screens, the entire patient flow, and the newer login
  screens: `AdminBranches.tsx:41`, `PatientBooking.tsx:64`,
  `RecurringPreviewPage.tsx`, `LoginPage.module.css`.
- **Plain `.css`** (side-effect import) — the doctor and receptionist
  screens, which are older: `DoctorMarkStatus.tsx:39`,
  `ReceptionistToday.tsx`, `ReceptionistAuditDrawer.tsx:27`.

**There is no documented rule and no test for the choice.** The evidence
suggests `.module.css` is the current convention — it covers everything
built most recently — so **prefer `.module.css` for new screens**, using
`styles['kebab-class-name']` for access. Do not migrate existing plain
`.css` files as a side effect of unrelated work.

## File Organization

**Pattern**: type-based within each package, with a route family as the
unit for the API.

```text
apps/api/src/
  routes/      one file per route family (+ -helpers.ts siblings)
  auth/        JWT sign/verify, claim shape, config
  db/          pool, migration runner
  middleware/  auth, admin-scope, async-handler, logging
  availability/  engine.ts (DB orchestration), slots.ts (pure math),
                 types.ts (pure time helpers)
  otp/         SMS OTP provider wiring
apps/web/src/
  pages/       one file per screen (+ co-located CSS)
  components/  shared components (ConflictModal, drawers)
  patient/components/  patient-flow primitives (barrel index.ts)
  api/client.ts      every API call in the app
  auth/store.ts      session store
  router/            hash router for the admin shell
  styles/            design tokens (tokens.css) + global CSS
```

**Conventions**:

- **Tests**: `apps/api/test/` (mirrored by route family) and
  `apps/web/test/` (by concern). Web test drivers are `.mjs` and spawn the
  `.ts` test file via `node --import tsx --test`.
- **Types**: co-located with the code that uses them. There is no shared
  `types/` directory.
- **Index files**: only `apps/web/src/patient/components/index.ts`, a barrel
  for the patient primitives. The API does not use barrels.

## Testing Strategy

**Framework**: `node:test` + `node:assert/strict` on both packages.
**Coverage target**: not numeric. The suite is exhaustive over route
families (425 tests / 21 files) and the design invariants are locked by
static scanners.

**Test types**:

| Type | Tool | When to Use |
|---|---|---|
| API integration | `node:test` + `supertest` + testcontainers Postgres | Any route behaviour, auth gate, transaction, or SQL constraint |
| Web static invariant | `node:test` + filesystem walk | Any rule about the *shape* of source (CSS tokens, modal singleton, no client-side holds) |
| Web pure function | `node:test` + `assert` | Phone normalisation, client helpers, error envelope |

**Conventions**:

- **Test naming**: `test('<thing> (<condition>) → <expected>', async () => {…})`.
  The arrow and expected status are part of the name — e.g.
  `GET /staff-catalog/doctors (bad ?branch_id) → 400 invalid_branch_id`.
- **Test structure**: a file-header JSDoc block that names the file, states
  what it covers, and explains *why* the surface exists; then `before()`
  (env setup + seed inside a transaction), `after()` (teardown), token
  helpers, `lookupIds()` helpers, then test bodies separated by `───`
  banners.
- **Mock strategy**: the API seeds a real database and calls the real app.
  The web tests either stub `globalThis.fetch` and `localStorage` (restored
  in a `finally`), or scan source files statically.
- **Fresh app per request**: `request(createApp()).get(...)` — a new app
  instance per call.

## Error Handling

**Pattern**: inline response emission. There is **no shared error class or
helper** — `apps/api/src/middleware/admin-scope.ts:14-15` states this
deliberately: *"error envelopes are emitted inline (matches the E0-S6
envelope shape)."*

**API errors** — a flat object with a snake_case `error` code:

```ts
res.status(401).json({ error: 'unauthenticated' });
res.status(403).json({ error: 'forbidden_role' });
res.status(403).json({ error: 'outside_branch_scope' });
res.status(404).json({ error: 'not_found' });
res.status(400).json({ error: 'invalid_branch_id' });
```

Some codes carry sibling fields when the client needs them — for example
`{ error: 'appointments_outside_hours', impact: { count_affected, … } }`
(409) and `{ error: 'otp_locked', retry_after_ms: N }` (429).

**Domain errors are typed discriminated unions, not exceptions.** The
availability engine returns them rather than throwing:

```ts
// apps/api/src/availability/engine.ts:179-192
export type AvailabilityError =
  | { kind: 'doctor_not_found' }
  | { kind: 'branch_not_found' }
  | { kind: 'doctor_not_at_branch' }
  | …;

export type AvailabilityOutcome =
  | { kind: 'ok'; result: AvailabilityResult }
  | { kind: 'err'; error: AvailabilityError };
```

The route maps them to HTTP through an **exhaustive `switch`**
(`availability.ts:177-207`) — adding a new `kind` will then fail to
compile until it is mapped.

**Thrown exceptions** are reserved for:

1. **Invariant violations** — `throw new Error('clinic_row_missing')`.
   These escape to the 500 handler.
2. **Typed domain errors** — e.g. `PasswordError` with a `.code`, caught
   locally and converted to a 400.
3. **JSON parse failures** — special-cased to `400 invalid_json`.

**Two response idioms coexist.** Most routes call `res.status().json()`
directly. `bookings.ts` uses a local `respond()` closure that also
increments a metric counter. Either is acceptable; do not mix them within
one file.

**Async rejections must reach `next(err)`.** Express 4 does not await
handlers, and an unhandled rejection exits the process. That is what
`wrapRouter()` exists for. Any new router must be registered in the wrap
loop at `apps/api/src/app.ts:82-119`.

## Logging

**Tool**: pino 9.5 + pino-http 10.3. **Format**: structured JSON.

**The logger is obtained by calling `getLogger()` at the call site** —
never by importing a `logger` binding. `apps/api/src/middleware/log.ts:61-71`
explains why: a module-level `const logger` would freeze the binding and
the test-time swap would not propagate.

**Levels**:

| Level | Usage |
|---|---|
| `error` | Server-side failures — DB errors, invariant violations, CHECK violations. The dominant level in route code. |
| `warn` | Retryable conflicts, 4xx responses, degraded-but-handled conditions. |
| `info` | **Audit events** — OTP attempts, staff password sets, successful sign-ins. |
| `debug` / `trace` | Not used in routes. |

`customLogLevel` (`log.ts:98-102`) maps HTTP status to level: ≥500 → error,
≥400 → warn, else info.

**Event names** are snake_case and domain-namespaced:
`availability_*`, `bookings_*`, `booking_insert_*`, `mock_otp_*`,
`staff_password_*`, `request_failed`.

Two styles coexist:

```ts
// (a) message-as-event-name — used for errors
getLogger().error({ err: … }, 'bookings_create_failed');

// (b) event key + distinct message — used for audit/outcome logs
getLogger().info({ event: 'staff_password_set', outcome: 'success', role, email: redactEmail(email) },
  'staff_password_set');
```

**Rules**:

- Always include a `request_id` — it is emitted at the top level of every
  line by pino-http, and echoed as the `x-request-id` response header.
- `err` is **always a string**: `err instanceof Error ? err.message : String(err)`.
  Never pass the raw Error object.
- Attach actor context via `attachLogContext(req, { actor_role, actor_id })`.
- **Never log** an authorization header, cookie, password, phone number, or
  OTP code. These are redacted centrally by `REDACT_PATHS`
  (`middleware/log-contract.ts:35-43`, seven exact-key paths); phone
  numbers and emails are additionally redacted manually at the call site
  (`redactPhone`, `redactEmail`).
- The log line's contract fields (`request_id`, `actor_role`, `actor_id`,
  `appointment_id`) are declared once in
  `middleware/log-contract.ts:17-22` as `CONTRACT_FIELDS` and consumed
  by `log.ts` — never re-declared inline.

## Enforced invariants

These are the rules with a test that fails when they break. Respect them
absolutely — a change that violates one is a regression, not a style
preference.

1. **Token-only CSS.** No hex, `rgb()`, `rgba()`, `hsl()`, or named colour
   outside `apps/web/src/styles/tokens.css`.
   Test: `apps/web/test/token-only-css.test.ts` (`pnpm --filter @clinic/web run test:e7-s1`).
2. **`ConflictModal` is the only conflict modal.** No second
   conflict-shaped dialog may be introduced.
   Test: `apps/web/test/conflict-modal-singleton.test.ts` (`test:e7-s4`).
3. **No tentative client-side slot holds.** The UI may display slots; it may
   not assume a slot is bookable, and it may not hold one outside the
   server's booking transaction.
   Test: `apps/web/test/no-tentative-holds.test.ts` (`test:e7-s7`).
4. **Global focus ring, colour-independent status pills, touch targets and
   reduced-motion** are global rules, not per-page ones.
   Tests: `test:e7-s5-focus`, `test:e7-s5-pills`, `test:e7-s5-touch`.
5. **The API is the only thing that may grant or release a slot.** The UI
   never decides availability.
