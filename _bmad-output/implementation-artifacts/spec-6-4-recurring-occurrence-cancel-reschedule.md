---
title: 'E6-S4 — Per-occurrence recurring cancel / reschedule'
type: 'feature'
created: '2026-10-04'
status: 'in-progress'
context:
  - '_bmad-output/planning-artifacts/epics-and-stories.md'
  - '_bmad-output/implementation-artifacts/spec-6-1-recurring-preview-create.md'
  - '_bmad-output/implementation-artifacts/spec-4-2-patient-cancel.md'
  - '_bmad-output/implementation-artifacts/spec-4-3-patient-reschedule.md'
  - '_bmad-output/implementation-artifacts/spec-5-2-doctor-cancel.md'
  - '_bmad-output/implementation-artifacts/spec-5-3-receptionist-cancel.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Per PRD FR-049 ("individual occurrences shall
be independently cancellable or reschedulable") + FR-050
("cancelling one occurrence shall immediately release its
slot") + UX-FLOWS §4.7, when a recurring series is created
(E6-S1), each occurrence is an independent appointment
thereafter. Cancelling one occurrence must NOT cancel its
siblings; rescheduling one must NOT touch its siblings.

This is already true at the row level (E4-S2 cancel and
E4-S3 reschedule operate on a single appointment id; the
GIST exclusion scopes on `(branch_id, tstzrange)` —
siblings at different start times are independent). What is
still missing is the **audit metadata**: the audit row
written by E4-S2 / E4-S3 / E5-S2 / E5-S3 must carry a
`recurring_origin` pointer so a reporting query can
reconstruct "this appointment was originally occurrence #N
of series S".

Without `recurring_origin`, the series linkage is lost the
moment the user mutates an occurrence. A future audit-log
query (E7-S2) cannot answer "show me all mutations to series
X" — only "show me the original creation event".

**Approach:** Add a thin enrichment to the existing audit
INSERT calls in:

1. **`patient-cancel.ts`** — `POST /patient/appointments/:id/cancel`.
2. **`patient-reschedule.ts`** — `POST /patient/appointments/:id/reschedule`.
3. **`staff-doctor-cancel.ts`** — `POST /appointments/:id/cancel`.
4. **`staff-receptionist-cancel.ts`** — `POST /reception/appointments/:id/cancel`.

For each route:
- The SELECT FOR UPDATE on the source row already returns
  `recurring_series_id` (E6-S1's column). When the column is
  non-NULL, the audit payload now includes
  `recurring_origin: {series_id: <uuid>}`.
- For the reschedule routes, the audit payload already
  carries `{from, to, branch_change, type_change}` (E4-S3).
  E6-S4 adds `recurring_origin` to that object when the
  source row has a `recurring_series_id`.
- For the cancel routes, the audit payload currently carries
  either `{}` (patient) or `{reason: <trimmed>}` (staff).
  E6-S4 adds `recurring_origin` to that object when the
  source row has a `recurring_series_id`.
- The `recurring_series_id` is read from the SELECT FOR
  UPDATE; no schema change is required.

**No new migration.** The `recurring_series_id` column
already exists (0018_recurring_series.sql).

**No new route.** The mutation paths are E4-S2 / E4-S3 /
E5-S2 / E5-S3 — those are unchanged. E6-S4 enriches their
audit payloads.

## Boundaries & Constraints

**Always:**
- The `recurring_origin` field is present in the payload ONLY
  when the source row's `recurring_series_id IS NOT NULL`.
  Non-recurring appointments carry the existing payload
  shape unchanged.
- `recurring_origin.series_id` is the literal UUID string
  of the `recurring_series_id` column value.
- The payload field names are stable across reads — a
  reporting query can `WHERE payload ? 'recurring_origin'`
  to find mutated occurrences.
- The enrichment is purely additive: existing payload
  fields (`reason`, `from`, `to`, `branch_change`,
  `type_change`) keep their semantics; `recurring_origin`
  is appended as a sibling key.

**Ask First:**
- (none — scope resolved at plan-time via epics-and-stories.md
  E6-S4 + PRD FR-049 / FR-050 / UX-FLOWS §4.7.)

**Never:**
- Never include `occurrence_index` in the payload. The
  index is reconstructible from a join against the original
  creation audit row (`event='recurring_created'`,
  `payload.occurrence_index`) — the original creation event
  IS the source of truth for the index. Storing it on every
  mutation would denormalize the data and risk drift.
- Never include `recurring_origin` on the
  `event='recurring_created'` audit row — that audit row IS
  the origin event. E6-S4 only mutates the cancel +
  reschedule audit payloads.
- Never change the cancel / reschedule semantics. E6-S4
  preserves the existing E4-S2 / E4-S3 / E5-S2 / E5-S3
  contracts 1:1; the only diff is the audit payload shape.
- Never include the `recurring_series_id` as a top-level
  audit column. The audit table's `payload jsonb` column
  already carries rich metadata (per 0009); adding a new
  column would be a schema migration for no semantic gain.
- No mutation logic is shared with E4-S2 / E4-S3. E6-S4 is
  read-time enrichment only.

## I/O & Edge-Case Matrix

| Scenario | Source row | Audit payload shape | Notes |
|----------|------------|---------------------|-------|
| Patient cancels recurring occurrence | `recurring_series_id=XYZ` | `{..., recurring_origin: {series_id: 'XYZ'}}` | E4-S2 + E6-S4 |
| Patient cancels non-recurring appt | `recurring_series_id=NULL` | `{}` (unchanged) | E4-S2 baseline |
| Patient reschedules recurring | `recurring_series_id=XYZ` | `{from, to, branch_change, type_change, recurring_origin: {series_id: 'XYZ'}}` | E4-S3 + E6-S4 |
| Patient reschedules non-recurring | `recurring_series_id=NULL` | `{from, to, branch_change, type_change}` (unchanged) | E4-S3 baseline |
| Doctor cancels recurring | `recurring_series_id=XYZ` | `{reason, recurring_origin: {series_id: 'XYZ'}}` | E5-S2 + E6-S4 |
| Doctor cancels non-recurring | `recurring_series_id=NULL` | `{reason}` (unchanged) | E5-S2 baseline |
| Receptionist cancels recurring | `recurring_series_id=XYZ` | `{reason, recurring_origin: {series_id: 'XYZ'}}` | E5-S3 + E6-S4 |
| Receptionist cancels non-recurring | `recurring_series_id=NULL` | `{reason}` (unchanged) | E5-S3 baseline |
| Audit row query: WHERE payload ? 'recurring_origin' | — | returns all cancel/reschedule audit rows for recurring occurrences | E7-S2 reporting |
| Audit row query: WHERE NOT (payload ? 'recurring_origin') | — | returns all cancel/reschedule audit rows for non-recurring occurrences | E7-S2 reporting |
| Sibling occurrence unaffected | cancel one of 4 weekly | other 3 occurrences remain Scheduled, untouched | FR-049 |
| Slot released for recurring cancel | cancel one occurrence | the GIST exclusion releases (DROP the row's tstz range; sibling rows are at different tstz ranges, so unaffected) | FR-050 |

## Code Map

- `apps/api/src/routes/patient-cancel.ts` (MODIFIED) — add
  `recurring_series_id` to the SELECT FOR UPDATE column
  list; when non-NULL, append `recurring_origin` to the
  audit payload.
- `apps/api/src/routes/patient-reschedule.ts` (MODIFIED) —
  same enrichment on the audit payload.
- `apps/api/src/routes/staff-doctor-cancel.ts` (MODIFIED) —
  same enrichment.
- `apps/api/src/routes/staff-receptionist-cancel.ts`
  (MODIFIED) — same enrichment.
- `apps/api/test/per-occurrence-recurring.test.ts` (NEW) —
  integration tests covering each of the four routes'
  enriched payloads.

**No new migration.** Reads existing `recurring_series_id`
column from `0018_recurring_series.sql`.

**Audit payload shape after E6-S4:**

```ts
// Patient cancel (E4-S2 + E6-S4)
type PatientCancelPayload =
  | Record<string, never>                       // non-recurring
  | { recurring_origin: { series_id: string } }; // recurring

// Patient reschedule (E4-S3 + E6-S4)
interface PatientReschedulePayload {
  from: { branch_id: string; start_datetime: string; end_datetime: string };
  to:   { branch_id: string; start_datetime: string; end_datetime: string };
  branch_change: boolean;
  type_change: boolean;
  recurring_origin?: { series_id: string };  // present iff source row was recurring
}

// Doctor cancel (E5-S2 + E6-S4)
type DoctorCancelPayload =
  | { reason: string }
  | { reason: string; recurring_origin: { series_id: string } };

// Receptionist cancel (E5-S3 + E6-S4)
type ReceptionistCancelPayload =
  | { reason: string }
  | { reason: string; recurring_origin: { series_id: string } };
```

## Tasks & Acceptance

**Execution:**
- [ ] `apps/api/src/routes/patient-cancel.ts` — read
  `recurring_series_id`; append `recurring_origin` to
  payload when non-NULL.
- [ ] `apps/api/src/routes/patient-reschedule.ts` — same
  enrichment.
- [ ] `apps/api/src/routes/staff-doctor-cancel.ts` — same
  enrichment.
- [ ] `apps/api/src/routes/staff-receptionist-cancel.ts` —
  same enrichment.
- [ ] `apps/api/test/per-occurrence-recurring.test.ts` —
  integration tests.

**Acceptance Criteria:**
- Given a recurring Scheduled appointment at series S, when POST /patient/appointments/:id/cancel is invoked, then 200 with the existing payload shape AND `payload.recurring_origin.series_id === S`.
- Given a non-recurring Scheduled appointment, when POST /patient/appointments/:id/cancel is invoked, then 200 with the existing payload shape (`{}`).
- Given a recurring Scheduled appointment at series S, when POST /patient/appointments/:id/reschedule is invoked, then 200 with the existing payload shape AND `payload.recurring_origin.series_id === S`.
- Given a non-recurring Scheduled appointment, when POST /patient/appointments/:id/reschedule is invoked, then 200 with the existing payload shape (no `recurring_origin`).
- Given a recurring Scheduled appointment at series S, when POST /appointments/:id/cancel (doctor) is invoked, then 200 with `{reason, recurring_origin: {series_id: S}}`.
- Given a recurring Scheduled appointment at series S, when POST /reception/appointments/:id/cancel (receptionist) is invoked, then 200 with `{reason, recurring_origin: {series_id: S}}`.
- Given any cancellation / reschedule of an occurrence from a recurring series, the row's siblings remain Scheduled and untouched (FR-049).
- Given an audit row query `WHERE payload ? 'recurring_origin'`, the rows returned are all cancel / reschedule audit rows for recurring occurrences (E7-S2 reporting contract).

## Spec Change Log

**SC1 — 2026-10-04, plan-step. (No pre-issue.)

This is the initial spec; no amendments yet.

**SC2 — 2026-10-04, code-review. Patches:

- N1: The enrichment is purely additive — the existing
  payload fields (`reason`, `from`, `to`, `branch_change`,
  `type_change`) keep their semantics. `recurring_origin` is
  appended as a sibling key.
- N2: `recurring_series_id` is added to the SELECT FOR
  UPDATE column list on all four files. The interface
  `AppointmentRow` gains `recurring_series_id: string |
  null` in each.
- N3: For patient-cancel (which previously wrote `'{}'::jsonb`
  as a literal), the INSERT_AUDIT_SQL is rewritten to use a
  bound `$3::jsonb` parameter, so the payload can carry the
  enrichment dynamically.
- N4: For staff-doctor-cancel and staff-receptionist-cancel,
  the auditPayload JSON.stringify moves from BEFORE the
  BEGIN/SELECT (where it was static) to INSIDE the txn
  (after the SELECT FOR UPDATE returns recurring_series_id),
  so the E6-S4 enrichment can be applied conditionally.
- N5: For patient-reschedule, the existing payload object
  is built into a `basePayload: Record<string, unknown>`
  and then conditionally appended with
  `recurring_origin` when the source row has a
  `recurring_series_id`. The JSON.stringify still runs
  once at audit time.

## Design Notes

**Why no `occurrence_index` in `recurring_origin`:** The
index is reconstructible from a join against the original
creation audit row (`event='recurring_created'`,
`payload.occurrence_index`) — the original creation event
IS the source of truth. Storing the index on every mutation
would denormalize the data; a future correction to the
index (e.g. an analyst deletes a spurious occurrence) would
risk drift across all downstream audit rows.

**Why `recurring_origin.series_id` (not `series`):** The
field name preserves the `origin` pointer semantics — the
audit row points BACK to the series, not to the appointment.
A reporting query joins `appointment_audit.payload ->
'recurring_origin' -> 'series_id'` back to
`appointment.recurring_series_id`.

**Why no new column on `appointment_audit`:** The audit
table's `payload jsonb` column already carries rich metadata
(per 0009). Adding a new column would be a schema migration
for no semantic gain. The `payload ? 'recurring_origin'`
predicate on `jsonb` is indexed-friendly (the @> containment
operator works on the GIN index on `payload` if one exists;
otherwise seq-scan).

**Why no new route:** The mutation paths are E4-S2 / E4-S3
/ E5-S2 / E5-S3 — those are unchanged. E6-S4 enriches their
audit payloads in-place. No new surface area; no new auth
gates; no new role checks.

## Verification

**Commands:**
- `pnpm --filter @clinic/api exec node --import tsx --test --test-global-setup=test/setup/globalSetup.cjs --test-concurrency=1 test/per-occurrence-recurring.test.ts` — expected: all green.
- `pnpm --filter @clinic/api run typecheck` — expected: 0 new errors.
- `pnpm --filter @clinic/api run lint` — expected: 0 new warnings.