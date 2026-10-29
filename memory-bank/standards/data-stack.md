# Data Stack

## Overview

PostgreSQL accessed through the `pg` driver directly — raw SQL, hand-written
transactions, no ORM and no query builder. The schema carries the two
invariants that matter most (no double-booking, per-occurrence appointment
independence) as **database constraints**, not as application checks, so they
hold even under concurrency.

## Database

**PostgreSQL 16** (`postgres:16-alpine` in the test container).

Rationale: the core correctness requirement is that two concurrent bookings
cannot claim the same slot. That is enforced by a **GIST exclusion
constraint**, which is a PostgreSQL feature with no portable equivalent:

```sql
-- apps/api/db/migrations/0008_appointment.sql:66-75
ALTER TABLE appointment
  ADD CONSTRAINT appointment_no_overlap
  EXCLUDE USING gist (doctor_id WITH =, branch_id WITH =,
    tstzrange(start_datetime, end_datetime, '[)') WITH &&)
  WHERE (status = 'Scheduled');
```

The range is half-open (`'[)'`) so that back-to-back appointments do not
collide — matching the no-buffer rule (BR-017 / FR-016).

A second constraint, a **partial unique index**, prevents a patient holding
two future appointments with the same doctor:

```sql
-- 0008_appointment.sql:57-59
CREATE UNIQUE INDEX idx_appointment_patient_doctor_scheduled
  ON appointment (patient_phone, doctor_id)
  WHERE status = 'Scheduled';
```

Both surface as SQLSTATE codes the routes translate into 409s:
`23P01` (GIST violation) → `slot_raced`, `23505` (unique violation) →
`patient_has_future_with_doctor`, `40P01`/`40001` (deadlock /
serialization failure) → also `slot_raced`, `23514` (CHECK violation) →
500, because a CHECK violation is a server defect, not a user error.

Self-hosted in development; a managed instance in any real deployment.

## ORM / Database Client

**`pg` 8.13** — no ORM, no query builder, no repository layer.

Rationale: the availability engine and the slot-race guards depend on exact
query shapes and on transaction boundaries. An ORM would abstract away
precisely the things that must be exact. It would also obscure the
difference between "no row" and "row that failed a predicate", which
changes the HTTP response.

### The data-access conventions that follow from that choice

**SQL lives in named module-level constants.** One `SCREAMING_SNAKE_CASE`
constant per query, at the top of the file:

```ts
// apps/api/src/availability/engine.ts:53-145
const SELECT_CLINIC_ID_SQL = `SELECT id FROM clinic LIMIT 1`;

const SELECT_DOCTOR_AT_BRANCH_SQL = `
  SELECT d.id, d.full_name, d.active, b.active AS branch_active, b.tz
    FROM doctor d
    JOIN doctor_branch db ON db.doctor_id = d.id
    JOIN branch b ON b.id = db.branch_id
   WHERE d.id = $1 AND db.branch_id = $2 AND d.clinic_id = $3;
`;
```

SQL keywords are indented two spaces from the backtick, columns are aligned,
and the statement ends with a semicolon **inside** the string.

**Parameters are always placeholders**, never interpolation:
`$1`, `$2`, … with the values in a separate array. Explicit casts are
written out — `$1::uuid`, `$2::timestamptz`, `$3::date`. The one place a
table name is interpolated (`admin-staff-password.ts:155`) takes the value
from a fixed `ROLE_TABLE` allowlist.

**Rows are typed** with the `pg` generic parameter:

```ts
const { rows } = await client.query<{ id: string }>(SELECT_CLINIC_ID_SQL);
```

`noUncheckedIndexedAccess` is on, so `rows[0]` is `T | undefined`. The
dominant idiom in this codebase is the non-null assertion — `rows[0]!.id` —
which is used *after* the code has already established the row exists. Where
it has not, the code checks explicitly. Prefer an explicit check in new
code.

### Transactions

The canonical shape, repeated across the API:

```ts
const pool = await getPool();
let client: PoolClient;
try {
  client = await pool.connect();
} catch (err) {
  getLogger().error({ err: ... }, 'availability_connect_failed');
  throw err;
}
try {
  await client.query('BEGIN');
  // work
  await client.query('COMMIT');
} catch (err) {
  try {
    await client.query('ROLLBACK');
  } catch {
    // ignore rollback failure
  }
  getLogger().error({ err: ... }, 'availability_engine_failed');
  throw err;
} finally {
  client.release();
}
```

Two details that matter:

1. **`pool.connect()` is caught separately** from the transaction body,
   because `client` would be unassigned in the `finally` if the connect
   itself failed.
2. **A read-only failure inside a transaction still COMMITs.** The engine
   returns `{ kind: 'err', error: ... }` after a `COMMIT`, not a
   `ROLLBACK` — there is nothing to undo. `ROLLBACK` is reserved for genuine
   aborts.

The pool is always obtained through `getPool()`
(`apps/api/src/db/pool.ts`), a lazy singleton that throws
`'DATABASE_URL is not set'` when the variable is missing.

## Migrations and seeds

**Migrations** are forward-only SQL files, `NNNN_name.sql`, applied by
`node-pg-migrate` in SQL mode.

Two ledgers, and it matters which is which:

- **`pgmigrations` (a table in the database)** is the schema of record.
  `db-reset.ts` configures `migrationsTable: 'pgmigrations'`.
- **`.applied.json`** is node-pg-migrate's *file-based* local ledger,
  written to `dist/db/migrations/.applied.json` — inside `dist/`, so
  it is a **build artifact, not a source file**. It is not in git.

Because the table is the schema of record, a migration can be applied
by hand (see `scripts/db-apply-0019-direct.ts`, which inserts the
`pgmigrations` row directly) without the file ledger knowing about it.

There are **no `.down` migrations applied automatically** — the runner
matches `/^\d{4}_.*\.sql$/` and excludes `.down.` files. Rollback is
manual.

**Seeds** are TypeScript, and there are three:

| Seed | What it provides |
|---|---|
| `01_minimum.ts` | The baseline: clinic, branches, doctors, receptionists, an admin, appointment types, schedules, five patients. Exports `seedWith(client)`. |
| `02_role_ids.ts` | Role id constants shared by the other seeds. |
| `03_rich_operations.ts` | The rich operational seed: staff `password_hash` credentials, doctor blocks, full-status appointment history, a recurring series, an audit trail. |

`db:reset` runs the baseline **and** the rich seed. The baseline alone
leaves `password_hash` NULL on every staff account, which keeps the
dev-only email-only login path reachable.

## Decision Relationships

- **No ORM** ⇒ every query is hand-written ⇒ the SQL-constant convention
  and the transaction template exist to keep that manageable.
- **Constraints over checks** ⇒ the double-booking and same-doctor rules
  hold under concurrency without a read-check-write race in application
  code. The application still pre-validates, to give a *useful* error
  message; the constraint is what makes the rule actually true.
- **Raw SQL** ⇒ schema changes are migration files, and the seed's
  idempotency contract (same email derived from the same `full_name`, via
  the same `regexp_replace` rule migration 0016 used) must be maintained by
  hand.
