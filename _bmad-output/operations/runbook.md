# Local Development Runbook

> **Audience:** anyone who wants to run the clinic-scheduling app on `localhost` to verify the implemented features end-to-end. This document is the *single source of truth* for the dev-loop. Each step cites the file the command originates from.

---

## 0. Prerequisites (one-time, per developer machine)

| Prereq | Version | Why |
|---|---|---|
| Node.js | ≥ 20.0.0 | `engines.node` in `package.json` |
| pnpm | 12.3.4 | `packageManager` in `package.json` (`npm i -g pnpm@12.3.4`) |
| Postgres | 16+ | `DATABASE_URL` in `apps/api/.env.example` |
| Docker (optional) | latest | Required only if you use a container for Postgres instead of a local install |

---

## 1. Install dependencies

```bash
cd "C:\Users\BS01719\Desktop\appoinment managment system"
pnpm install
```

This installs every workspace dep including `apps/api`, `apps/web`, and `node_modules/.pnpm/...`.

---

## 2. Provision the database

### Option A — Local Postgres install
Install Postgres 13+ locally, create a database, and note the connection string:

```
postgres://postgres:postgres@localhost:5432/clinic_dev
```

### Option B — Docker container
```bash
docker run --name clinic-postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_DB=clinic_dev \
  -p 5432:5432 \
  -d postgres:16
```

Connection string: `postgres://postgres:postgres@localhost:5432/clinic_dev`.

The API requires `pgcrypto` available — migrations `0011_pgcrypto_grants.sql` install it into a dedicated schema. Local Docker `postgres:16` image includes it; some stripped `postgres:alpine` images do not (E0-S3 review W7).

---

## 4. Configure the API env

```bash
cp apps/api/.env.example apps/api/.env
```

Edit `apps/api/.env` and set the minimum required vars:

```env
# Auth (E0-S3)
AUTH_SECRET=<base64url of 48 random bytes; see generator below>
AUTH_TOKEN_TTL_SECONDS=3600
MOCK_OTP_CODE=123456

# OTP gateway (E0-S4) — dev mode writes the raw code to stdout
OTP_PROVIDER=log
OTP_TTL_SECONDS=300
OTP_LOCKOUT_THRESHOLD=3
OTP_LOCKOUT_SECONDS=600
OTP_COOLDOWN_SECONDS=30
OTP_CODE_LENGTH=6

# Database
DATABASE_URL=postgres://postgres:postgres@localhost:5432/clinic_dev

# Logging
LOG_LEVEL=info

# Server
PORT=3001
NODE_ENV=development
```

Generate `AUTH_SECRET`:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

The API boot guards (`apps/api/src/server.ts`) will **fail fast** if:
- `AUTH_SECRET` is missing or < 32 bytes (`auth_secret_too_short`)
- `NODE_ENV=production` and `OTP_PROVIDER=log` (`otp_provider_log_in_production`)

---

## 5. Migrate + seed the database

```bash
pnpm db:migrate
pnpm db:seed
```

These scripts are defined at `package.json:22-23` and proxy to `apps/api/package.json`:
- `db:migrate` → `node-pg-migrate -m db/migrations -j sql --env DATABASE_URL up`
- `db:seed` → `tsx db/seeds/01_minimum.ts`

The seed (`apps/api/db/seeds/01_minimum.ts`) is **idempotent**: re-running does not duplicate rows. It populates:
- 1 clinic (singleton anchor — E1-S0a)
- 2 branches (East, West; distinct timezones — E7-S6)
- 3 doctors (`dr.-east-lead`, `dr.-east-support`, `dr.-west-lead`)
- 2 receptionists (one per branch — BR-004 single-branch invariant)
- 1 admin (`admin-main`)
- 5 patients (`+15550000001` … `+15550000005`)
- 3 appointment types (General Consultation / Follow-up / Specialist Consult)
- 1 future appointment for `+15550000001`

Dev seed hint block (per `spec-w10-staff-login-patient-otp.md`):
```
admin-main@clinic.local
dr.-east-lead@clinic.local
receptionist-east@clinic.local
```

---

## 6. Run the dev servers (TWO terminals)

### Terminal 1 — API on `:3001`
```bash
pnpm --filter @clinic/api dev
```
This runs `tsx watch src/server.ts` (`apps/api/package.json:8`). The `tsx` watcher hot-reloads on file change. The server logs `api_listening` and `service_started` (`apps/api/src/server.ts:85-91`).

Verify it's up:
```bash
curl http://localhost:3001/healthz
# → {"status":"ok"}
curl http://localhost:3001/metrics
# → prom-client exposition (counters + histograms)
```

### Terminal 2 — Web on `:5173`
```bash
pnpm --filter @clinic/web dev
```
This runs `vite --port 5173 --strictPort` (`apps/web/package.json:4`). The proxy table (`apps/web/vite.config.ts:14-21`) forwards `/admin`, `/patient`, `/availability`, `/bookings`, `/health`, `/metrics` to `http://localhost:3001` — no CORS in dev.

Verify it's up:
```bash
curl -I http://localhost:5173
# → HTTP/1.1 200 OK
```

---

## 7. Smoke-test the implemented features

Open `http://localhost:5173` in a browser. The login page (`spec-w10-staff-login-patient-otp.md`) has two cards: **Staff sign-in** (left) and **Patient OTP** (right). The dev seed hint surfaces test emails.

### Patient booking flow (F-01)
1. Patient OTP card → enter phone `+15550000099` (or one of the seeded patient phones) → OTP `123456` → log in.
2. Browser routes to `/book`. The booking flow has 8 steps (E3-S1/S2/S3-ui): doctor list → branch picker → appointment type → slot picker → contact info → confirmation → OTP verify → dashboard.

### Admin clinic settings (F-16)
1. Staff card → role=`admin`, email=`admin-main@clinic.local` → log in.
2. Browser routes to `/admin/clinic` (`E1-S0-ui`). The ClinicSettings page renders the pixel-perfect port of mockup 32.
3. Quick links in the stat tiles route to: `/admin/branches` (mockup 17), `/admin/doctors` (mockup 18), `/admin/receptionists` (mockup 19-B), `/admin/types` (mockup 11), `/admin/branch-hours` (mockup 28), `/admin/audit` (mockup 27).

### Doctor dashboard (F-09, F-10, F-12)
1. Staff card → role=`doctor`, email=`dr.-east-lead@clinic.local` → log in.
2. Routes to doctor app: today queue (mock 12), affected queue (mock 06), resolve one (mock 24), audit drawer (mock 30).

### Receptionist today (F-13, F-14)
1. Staff card → role=`receptionist`, email=`receptionist-east@clinic.local` → log in.
2. Routes to today's branch view (mock 13), cancel (mock 15), walk-in create (mock 14).

### Curl-level smoke (no browser)
```bash
# Health
curl http://localhost:3001/healthz

# Public availability for a doctor
curl "http://localhost:3001/availability?doctor_id=<uuid>&branch_id=<uuid>&appointment_type_id=<uuid>&date=2026-10-15" \
  -H "Authorization: Bearer <patient-jwt>"

# Admin clinic counts (requires admin JWT)
curl http://localhost:3001/admin/clinic \
  -H "Authorization: Bearer <admin-jwt>"

# Metrics scrape
curl http://localhost:3001/metrics
```

The 30+ implemented stories pinned these surfaces; the 7 E7 backlog stories do **not** add new routes, they enforce invariants + add the 8 PRD §16 product metrics + a11y baseline + ConflictModal consolidation.

---

## 8. Run the test suite

```bash
# API tests (~265 cases; uses Testcontainers if Docker is available)
pnpm --filter @clinic/api test

# API typecheck
pnpm --filter @clinic/api typecheck

# API lint
pnpm --filter @clinic/api lint

# Web typecheck
pnpm --filter @clinic/web typecheck

# Web lint
pnpm --filter @clinic/web lint

# All workspaces
pnpm typecheck
pnpm lint
pnpm test
```

The test script (`apps/api/package.json:13`):
```
node --import tsx --test --test-global-setup=test/setup/globalSetup.cjs --test-concurrency=1 test/*.test.ts
```

Testcontainers runtime (`@testcontainers/postgresql: ^12.1.0` in `apps/api/package.json:25`) pulls a Postgres 16 image per test file. If Docker is missing, suite cannot run — every story from E0-S4 onward carries the audit note: *"Testcontainers runtime not available … status relies on spec audit trail."*

The 3 pre-existing baseline failures (carried since E0-S4 and documented in `deferred-work.md`):
1. `auth.test.ts` × 2 — `{staff,doctor}-empty-branch_ids` returns 404 instead of 403.
2. `log.test.ts` × 1 — `actor_role=null` regression.

These are **not regressions**; they're tracked deferrals. New code must not introduce additional failures.

---

## 9. Token-only-CSS invariant (E7-S1)

```bash
# Should only show matches inside apps/web/src/styles/tokens.css
rg '#[0-9a-fA-F]{3,8}' apps/web/src

# Should only show rgba/hsla literals inside tokens.css
rg 'rgba?\(' apps/web/src
```

The grep is the runtime check of the invariant. The 7 E7 backlog spec `7-1-design-system-token-wiring.md` turns this into a CI-enforced test (not yet shipped).

---

## 10. References

- Spec index for the 7 ready-for-dev stories: `_bmad-output/implementation-artifacts/epic-7-backlog-specs-index.md`
- Auth + OTP architecture: `_bmad-output/implementation-artifacts/spec-0-3-auth-provider-wiring.md`, `spec-0-4-sms-otp-gateway.md`
- All 30+ shipped stories: `_bmad-output/architecture.md` + `epics-and-stories.md`
- Mockups: `docs/design/mockups/v1/` (42 ports)
- Deferred items: `_bmad-output/implementation-artifacts/deferred-work.md`