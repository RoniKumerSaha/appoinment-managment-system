---
title: 'E2-S2 — Doctor block time (single date / range / multi-day)'
type: 'feature'
created: '2026-10-04'
status: 'done'
context:
  - '_bmad-output/planning-artifacts/epics-and-stories.md'
  - '_bmad-output/planning-artifacts/architecture.md'
  - '_bmad-output/implementation-artifacts/epic-1-context.md'
  - '_bmad-output/implementation-artifacts/spec-2-1-configure-doctor-weekly-schedule.md'
  - '_bmad-output/implementation-artifacts/spec-1-3-create-deactivate-assign-branch-doctors.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The `doctor_block` table exists from `0007_doctor_block.sql` (E0-S2) with `(doctor_id, branch_id, start_datetime, end_datetime, reason, created_by, created_at, updated_at)`. There is no admin/doctor surface to create, list, or delete blocks. The BR-010/BR-011/BR-054/FR-012/FR-013 conflict semantics are not encoded anywhere. Per FR-013, block-vs-block overlap and block-vs-Scheduled-appointment overlap are both app-layer concerns.

**Approach:** Add a new route family `routes/admin-doctor-block.ts` exposing `GET /admin/doctors/:id/blocks` (list all blocks for a doctor in a date window with `?from=` and `?to=` query filters), `POST /admin/doctors/:id/blocks-impact` (preview: count future Scheduled appointments the proposed block would invalidate + return masked list), `POST /admin/doctors/:id/blocks` (create a block, gated by the impact check: 409 when ≥1 future Scheduled appointment overlaps the proposed block), `DELETE /admin/doctors/:id/blocks/:block_id` (admin-only — delete a block; no audit row per E1-S2/E1-S3/E1-S4 precedent). All routes gated by `adminScope`.

**Boundaries & Constraints**

**Always:**
- `GET /admin/doctors/:id/blocks` accepts optional `?from=<ISO>` and `?to=<ISO>` query filters. Returns `200 {blocks: [{id, doctor_id, branch_id, start_datetime, end_datetime, reason, created_by, created_at, updated_at}, ...]}`.
- `POST .../blocks-impact` accepts `{branch_id, start_datetime, end_datetime, reason}`. Returns `200 {future_appointment_count: N, affected_appointments: [...]}` with masked patient_phone. Returns `400 invalid_doctor_id / 404 doctor_not_found / 400 invalid_branch_id / 400 branch_not_in_doctor_branches / 400 invalid_time_range / 400 invalid_reason`. NO DB write — preview only.
- `POST .../blocks` accepts the same body. Behavior: verify the doctor exists + is at the branch → check impact → if N ≥ 1 return 409 with masked list → otherwise INSERT row + 201. Returns `201 {id, ...}` on success.
- `DELETE .../blocks/:block_id` deletes the block by id. Returns `204` on success, `404 block_not_found` if missing, `400 invalid_block_id` for malformed UUID.
- Validation order: UUID parse → body shape → per-field validators (start_datetime/end_datetime ISO + `end > start`, reason 1..500 chars, branch_id UUID + in doctor's branches) → DB-level doctor lookup → branch verified.
- Reason is optional (null allowed); max 500 chars if provided.
- Patient privacy: `patient_phone` masked to `+1XXXXXXXXXX` on impact preview AND on 409 response. Matches E1-S2/E2-S1 invariant.
- The block must NOT be in the past entirely (`start_datetime > now()`). Past-rejection matches the "future only" semantics from E2-S1's `effective_from` rule.
- No partial overlap allowed (BR-011): any tstzrange intersection with a Scheduled appointment → 409.

**Ask First:**
- (none — scope resolved at plan-time via epic-1-context.md + epics-and-stories.md E2-S2.)

**Never:**
- No audit row written (E7-S2 lands audit later; E1-S2/E1-S3/E1-S4/E2-S1 set the no-audit precedent).
- No PATCH/rename — blocks are immutable once created. To "edit" a block, the admin deletes and re-creates. (Future story could add PATCH.)
- No block-vs-block conflict check at creation time — blocks can overlap each other. (Documented in D1 as a deliberate non-feature.)
- No recurring/multi-day block support via this endpoint — single block per POST. Recurring blocks live in a future story.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| `GET .../blocks` happy | admin JWT + valid doctor id with 0 blocks | `200 {blocks: []}` | N/A |
| `GET .../blocks` unknown doctor | random UUID | `404 {error: 'doctor_not_found'}` | Route |
| `GET .../blocks` non-UUID id | `not-a-uuid` | `400 {error: 'invalid_doctor_id'}` | Route |
| `GET .../blocks` no auth | unauthenticated | `401` | auth middleware |
| `GET .../blocks` patient JWT | patient role | `403` | adminScope |
| `POST .../blocks-impact` clean | admin JWT + proposed block that does NOT overlap any future Scheduled appt | `200 {future_appointment_count: 0, affected_appointments: []}` | N/A |
| `POST .../blocks-impact` with overlap | admin JWT + proposed block that overlaps ≥1 future Scheduled appt | `200 {future_appointment_count: N, affected_appointments: [{id, patient_phone_masked: '+1XXXXXXXXXX', ...}]}` | N/A |
| `POST .../blocks-impact` invalid branch | branch_id not in doctor's branches | `400 {error: 'branch_not_in_doctor_branches'}` | Route |
| `POST .../blocks` clean | admin JWT + valid body + no future appt overlap | `201 {id, ...}` | N/A |
| `POST .../blocks` with overlap | admin JWT + valid body + ≥1 future Scheduled appt overlap | `409 {error: 'block_overlaps_future_appointments', future_appointment_count: N, affected_appointments: [...]}` | transaction rolls back |
| `POST .../blocks` past start | `start_datetime < now()` | `400 {error: 'start_in_past'}` | validate first |
| `POST .../blocks` end <= start | `end_datetime <= start_datetime` | `400 {error: 'invalid_time_range'}` | validate first |
| `POST .../blocks` no auth | unauthenticated | `401` | auth middleware |
| `DELETE .../blocks/:block_id` happy | admin JWT + valid block id | `204` (no body) | N/A |
| `DELETE .../blocks/:block_id` unknown id | random UUID | `404 {error: 'block_not_found'}` | Route |
| `DELETE .../blocks/:block_id` non-UUID id | `not-a-uuid` | `400 {error: 'invalid_block_id'}` | Route |
| `DELETE .../blocks/:block_id` no auth | unauthenticated | `401` | auth middleware |

</frozen-after-approval>

## Code Map

- `apps/api/src/routes/admin-doctor-block-helpers.ts` (NEW) — pure validators: `isValidUuid`, `isValidDateTimeString`, `validateCreateBlockBody` (tagged union).
- `apps/api/src/routes/admin-doctor-block.ts` (NEW) — 4 routes:
  - `GET /admin/doctors/:id/blocks` — UUID validate → SELECT doctor → if doctor not found 404 → SELECT blocks (with optional `?from=` / `?to=` filters applied to `start_datetime`) → 200 with masked response.
  - `POST /admin/doctors/:id/blocks-impact` — UUID validate → validate body → SELECT doctor → if doctor not found 404 → verify branch in doctor_branch → SELECT future Scheduled appointments for this doctor that overlap the proposed tstzrange → 200 with masked list.
  - `POST /admin/doctors/:id/blocks` — UUID validate → validate body → SELECT doctor FOR UPDATE → if doctor not found 404 → verify branch → run impact check → if future_appointment_count > 0 ROLLBACK + 409 → INSERT block → 201.
  - `DELETE /admin/doctors/:id/blocks/:block_id` — UUID validate → DELETE → 204 or 404.
- `apps/api/src/app.ts` (MODIFIED) — chain `adminDoctorBlockRouter` into the existing `app.use('/admin', adminScope, ...)` mount.
- `apps/api/test/admin-doctor-block.test.ts` (NEW) — full I/O matrix (~16 tests).

**No new migration.** `0007` already has every column; no `active` column needed because blocks are immutable (delete to remove).

**Block-vs-appointment overlap query (preview + inside commit transaction):**

```sql
SELECT a.id::text AS id,
       a.patient_phone,
       a.doctor_id::text AS doctor_id,
       a.branch_id::text AS branch_id,
       a.start_datetime, a.end_datetime, a.status
  FROM appointment a
 WHERE a.doctor_id = $1
   AND a.branch_id = $2
   AND a.start_datetime > now()
   AND a.status = 'Scheduled'
   -- tstzrange overlap, half-open [start, end) on both sides
   AND tstzrange(a.start_datetime, a.end_datetime, '[)')
       && tstzrange($3::timestamptz, $4::timestamptz, '[)')
 ORDER BY a.start_datetime ASC;
```

## Tasks & Acceptance

**Execution:**
- [ ] `apps/api/src/routes/admin-doctor-block-helpers.ts` — pure validators.
- [ ] `apps/api/src/routes/admin-doctor-block.ts` — 4 routes.
- [ ] `apps/api/src/app.ts` — chain adminDoctorBlockRouter.
- [ ] `apps/api/test/admin-doctor-block.test.ts` — full I/O matrix.

**Acceptance Criteria:**
- Given a valid admin JWT + valid doctor id with 0 blocks, when `GET /admin/doctors/:id/blocks` is called, then response is `200 {blocks: []}`.
- Given a valid admin JWT + unknown / non-UUID doctor id, when `GET ...` is called, then 404 / 400 envelopes match the matrix.
- Given a valid admin JWT + a proposed block that does NOT overlap any future Scheduled appointment, when `POST .../blocks-impact` is called, then response is `200 {future_appointment_count: 0, affected_appointments: []}`.
- Given a proposed block that overlaps ≥1 future Scheduled appointment, when `POST .../blocks-impact` is called, then response is `200 {future_appointment_count: N, affected_appointments: [{id, patient_phone_masked: '+1XXXXXXXXXX', ...}]}`.
- Given a valid admin JWT + valid clean block, when `POST .../blocks` is called, then `201 {id, ...}` is returned; the DB has exactly 1 new block row.
- Given a proposed block that overlaps ≥1 future Scheduled appointment, when `POST .../blocks` is called, then `409 {error: 'block_overlaps_future_appointments', future_appointment_count: N, affected_appointments: [...]}` is returned; no DB write.
- Given past `start_datetime` or `end_datetime <= start_datetime`, when validated, then `400 {error: 'start_in_past'}` (past start) or `400 {error: 'invalid_time_range'}` (end ≤ start).
- Given `branch_id` not in the doctor's branch set, when validated, then `400 {error: 'branch_not_in_doctor_branches'}`.
- Given a valid block id, when `DELETE /admin/doctors/:id/blocks/:block_id` is called, then 204; the DB row is removed.
- Given unknown / non-UUID block id, when `DELETE ...` is called, then 404 / 400 envelopes match the matrix.
- Given the new code, when the existing test suites run, then no regression.

## Spec Change Log

**SC1 — 2026-10-04, plan-step. (No pre-issue.)

This is the initial spec; no amendments yet.

**SC2 — 2026-10-04, post-implementation review (code-review-loop-1).

- **Past `start_datetime` envelope changed from `invalid_time_range` → `start_in_past`** (matrix row 58, acceptance criterion line 115): the original spec conflated "past start" with "end ≤ start" under the same `invalid_time_range` code. Review identified that E2-S1's precedent uses distinct per-field codes (`invalid_effective_from`) for similar past-rejection cases. Implementation + helpers (`validateCreateBlockBody`) already emit `start_in_past`; the spec is amended to match. The enum (`CreateBlockError`) is unchanged — the code was already declared. Tests unchanged (already asserted `start_in_past`). Rationale: a more specific envelope gives the admin UI a clearer signal to render "start must be in the future" vs. "end must be after start".

- **Test fixture fix: `isoOffsetDays` now pins midnight UTC** (admin-doctor-block.test.ts: `isoOffsetDays`): the original helper returned `new Date(Date.now() + N days).toISOString()` which only lands at `T00:00:00.000Z` when `Date.now()` happens to be midnight UTC. Callers used `.replace('T00:00:00', 'T01:00:00')` to bump end by 1 hour; if the test ran mid-day UTC, the replace was a no-op and end_datetime equaled start_datetime, triggering `invalid_time_range` instead of the asserted `200/201/204`. Fix: floor the Date to midnight UTC. No production behavior change — pure test fixture.

## Verification

**Commands:**
- `pnpm --filter @clinic/api exec node --import tsx --test --test-global-setup=test/setup/globalSetup.cjs --test-concurrency=1 test/admin-doctor-block.test.ts` — expected: all green.
- `pnpm --filter @clinic/api run typecheck` — expected: 0 new errors.
- `pnpm --filter @clinic/api run lint` — expected: 0 new warnings.

**Manual checks (if no CLI):**
- After `POST /admin/doctors/<east_lead>/blocks {branch_id: <east>, start_datetime: <next Tuesday 10:00>, end_datetime: <next Tuesday 11:00>, reason: 'lunch'}`, the response is 201; the DB has 1 new row in `doctor_block`.
- After `POST /admin/doctors/<east_lead>/blocks-impact {branch_id: <east>, start_datetime: <next Tuesday 10:00>, end_datetime: <next Tuesday 11:00>, reason: 'lunch'}` (block overlaps the seeded future appointment), the response is `200 {future_appointment_count: 1, affected_appointments: [{id, patient_phone_masked: '+1XXXXXXXXXX', ...}]}`.
- After `DELETE /admin/doctors/<east_lead>/blocks/<block_id>`, the DB row is removed.