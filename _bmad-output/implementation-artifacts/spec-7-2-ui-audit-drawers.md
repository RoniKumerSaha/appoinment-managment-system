---
id: spec-7-2-ui-audit-drawers
title: E7-S2 UI — Doctor audit drawer (mock 30)
epic: epic-7
status: done
review_loop_iteration: 0
created: 2026-10-06
last_updated: 2026-10-06
---

# E7-S2 UI — Doctor audit drawer (mock 30)

## Intent

Ship the doctor-facing audit drawer that consumes the E7-S2
back-end route:

- `GET /doctor/appointments/:id/audit` returns the audit
  trail for a single appointment the doctor owns. Doubly-bound
  scope: `claim.role === 'doctor'` AND
  `appointment.doctor_id === claim.doctor_id`. Capped at
  `MAX_AUDIT_ROWS = 200` rows.
- The same envelope (`404 not_found`) is returned for both
  "doesn't exist" and "exists but not yours" — the E7-S3
  privacy filter (E7-S3 invariant).

The UI half (mock 30): a right-side slide-in drawer (480px
wide), summary banner (count + scope), filter chips (All /
Status changes / Cancellations / Block / Resolve), and a
scrollable list of rows. The doctor triggers the drawer from
the affected-queue kanban card via a new "View audit log"
affordance.

This story ships only the **doctor** audit drawer. The
receptionist drawer (same back-end surface, different
trigger) and the admin policy envelope (rejected_per_role_policy)
are wired in the API but have no UI in this pass.

## Approach

1. **API client** — already in place from the previous pass:
   `getDoctorAppointmentAudit(id)`, `getReceptionistAppointmentAudit(id)`,
   and `getAdminAudit()` (the admin policy envelope).
2. **`DoctorAuditDrawer`** — the right-side 480px slide-in.
3. **`DoctorApp`** — wires the drawer; DoctorAffected exposes
   an `onOpenAudit` callback. Today only the affected queue
   triggers the drawer; future surfaces (today queue mock 12,
   weekly schedule mock 09) reuse the same callback.
4. **`DoctorAffected`** — adds an "Audit log" / "View audit log →"
   button on every kanban card (To do, In progress, Resolved).
5. **Spec + sprint-status** — this doc + a `done` marker.

### 1. API client — doctor audit endpoint (already in place)

**File:** `apps/web/src/api/client.ts` (EDIT, last pass).

```ts
export interface DoctorAuditRow {
  id: string;
  appointment_id: string | null;
  actor_role: string;
  actor_id: string;
  event: string;
  payload: Record<string, unknown> | null;
  created_at: string; // ISO UTC
}

export interface DoctorAuditResponse {
  appointment_id: string;
  patient_phone: string;
  count: number;
  audit: DoctorAuditRow[];
}

export function getDoctorAppointmentAudit(
  appointmentId: string,
): Promise<DoctorAuditResponse>;
```

Same shape for `getReceptionistAppointmentAudit` (E7-S2
receptionist). The admin endpoint is a policy envelope
(`getAdminAudit`) because per PRD §2.4 the admin never sees
appointment-audit.

### 2. `DoctorAuditDrawer` — right-side slide-in

**File:** `apps/web/src/pages/DoctorAuditDrawer.tsx` (NEW),
**File:** `apps/web/src/pages/DoctorAuditDrawer.module.css` (NEW).

Token-only CSS (E7-S1 invariant). 480px wide, anchored right,
`box-shadow: var(--elev-3)`, scrim `var(--scrim)`. Slide-in
animation respects `prefers-reduced-motion` (the global rule
in `tokens.css` strips it).

Structure:
- **Head**: crumb "Audit log" + h2 with the appointment label
  (e.g. "Patient ···3456") + sublabel "Per-appointment trail ·
  doctor scope" + close button (×).
- **Summary banner** (`var(--brand-light-50)`): `N events · M
  today · scope: your appointments only`.
- **Filter chips**: All / Status changes / Cancellations / Block
  / Resolve. Active chip uses `var(--brand-primary)` background.
- **Body** (scrollable): rows, each with
  - Time (`var(--font-mono)`, today highlighted in teal);
  - Action line (e.g. "moved this appointment", "cancelled this
    appointment"), with target span in
    `var(--brand-primary)`;
  - Actor ("you · doctor", "patient", "receptionist", "admin");
  - Meta line (e.g. "reason: Patient requested · slot released",
    "branch ··A3D7 → branch ··82F1 · to Aug 22 · 10:30 · atomic");
  - Pill on the right (status / block / resolve / cancel / create
    tones).
- **Foot**: "Showing N of M · newer events at the top" + Export
  CSV button (disabled, deferral D-E7-S-UI-2).
- **Privacy note** (warning-bg): doctors see their own, reception
  sees branch, admin sees policy envelope, patients never see
  audit.

Behaviour:
- `useEffect` calls `getDoctorAppointmentAudit(appointmentId)`
  on mount + whenever the id changes. Cancellable on close.
- `useEffect` listens for the Escape key → onClose.
- Click on the backdrop (outside the drawer) → onClose.
- Filter is client-side over the loaded rows (the server
  returns the full 200-row window).
- Empty state: "No audit events for this appointment yet." (or
  "No events match the current filter." when filtered out).
- Error state: 401 / 403 / 404 / 5xx mapped to friendly strings
  (mirrors the rest of the doctor surface).

### 3. `DoctorApp` — wires the drawer

**File:** `apps/web/src/pages/DoctorApp.tsx` (EDIT).

Adds an `auditTarget` state; renders `<DoctorAffected
onOpenAudit={…} />` plus the `<DoctorAuditDrawer />` overlay
when the target is non-null. Mirrors the move-flow pattern
(DoctorAffected + DoctorResolve + DoctorResolutionSaved).

### 4. `DoctorAffected` — "View audit log" affordance

**File:** `apps/web/src/pages/DoctorAffected.tsx` (EDIT).

New optional prop `onOpenAudit: (t: { appointmentId;
appointmentLabel; branchTz }) => void`. Each kanban card now
renders two buttons:
- **To do / In progress**: primary teal "Move →" / "Continue →"
  + secondary outline "Audit log".
- **Resolved**: secondary outline "View audit log →" (the move
  is already done; the audit trail is the doctor's only
  post-action reference).

New CSS variant `.doc-aff__card-btn--primary` (filled teal) in
`DoctorAffected.module.css`. The default `.doc-aff__card-btn`
stays a ghost outline.

Bug fix: the `card-actions` div was gated on `!r.resolved` —
that's wrong now that resolved rows render the audit-log
button. Removed the gate; the column only renders the
`card-actions` div if `renderAction` is provided.

### 5. Spec + sprint-status

**File:** `_bmad-output/implementation-artifacts/spec-7-2-ui-audit-drawers.md` (NEW, this doc).
**File:** `_bmad-output/implementation-artifacts/sprint-status.yaml` (EDIT).

Story → `done`. Three deferrals logged: D-E7-S-UI-1 (admin
audit log / mock 27), D-E7-S-UI-2 (CSV export), D-E7-S-UI-3
(receptionist audit drawer UI).

## Files to change

| Path | Kind | What |
|------|------|------|
| `apps/web/src/pages/DoctorAuditDrawer.tsx` | NEW | Right-side 480px slide-in |
| `apps/web/src/pages/DoctorAuditDrawer.module.css` | NEW | Token-only CSS |
| `apps/web/src/pages/DoctorApp.tsx` | EDIT | Wire drawer via `onOpenAudit` |
| `apps/web/src/pages/DoctorAffected.tsx` | EDIT | `onOpenAudit` prop + audit-log button per card |
| `apps/web/src/pages/DoctorAffected.module.css` | EDIT | Add `--primary` variant for the Move/Continue button |
| `_bmad-output/implementation-artifacts/spec-7-2-ui-audit-drawers.md` | NEW | Spec |
| `_bmad-output/implementation-artifacts/sprint-status.yaml` | EDIT | Story → done + deferrals |

## I/O & Edge-Case Matrix

| Surface | Input | API | UI |
|---------|-------|-----|---|
| Open drawer | appointmentId | 200 `{count, audit}` | Drawer renders; rows displayed; summary shows `N events` |
| Open drawer | — | 401 | "Session expired. Please sign in again." (banner replaces rows) |
| Open drawer | — | 403 | "You do not have access to this audit log." |
| Open drawer | — | 404 | "That appointment no longer exists." (same envelope for "not yours" — E7-S3) |
| Open drawer | — | 5xx / network | "Could not load the audit log." / "Connection failed. Is the API running on :3001?" |
| Filter | 'all' | (client-side) | All rows |
| Filter | 'status' | (client-side) | Only `pillTone === 'status'` |
| Filter | 'cancel' | (client-side) | Only `pillTone === 'cancel'` |
| Filter | 'block' | (client-side) | Only `pillTone === 'block'` |
| Filter | 'resolve' | (client-side) | Only `pillTone === 'resolve' \|\| === 'create'` |
| Empty data | count=0 | 200 | "No audit events for this appointment yet." |
| Empty filter | filtered.length=0 | (client-side) | "No events match the current filter." |
| Escape | keydown | — | onClose |
| Backdrop click | click target === currentTarget | — | onClose |

## Audit-event → UI mapping

| Server `event` | Action line | Pill | Tone | Meta (when present) |
|----------------|-------------|------|------|---------------------|
| `cancelled` | "cancelled this appointment" | Cancel | danger | `payload.reason` + `payload.cancelled_by_actor` + "· slot released" |
| `rescheduled` | "rescheduled this appointment" | Resolve | success | from→to dates (payload.from_start_datetime, to_start_datetime) |
| `moved_by_doctor` | "moved this appointment" | Resolve | success | from/to branch `··xxxx`, to date+time, "· atomic" |
| `status_marked` | "marked status · {new_status}" | Status | info | — |
| `recurring_created` | "created in a recurring series" | Create | brand | recurring_series_id tail |
| `blocked` | "blocked this slot" | Block | warning | `payload.reason` |
| `created` | "created this appointment" | Create | brand | first 3 payload keys |
| (other) | raw event name | Event | resolve | — |

The "actor" cell is "you · doctor" for the doctor, "patient"
for patient-driven events, "receptionist" for receptionist
events, "admin" for admin events. E7-S2 is doubly-bound; the
UI never renders cross-doctor rows.

## Verification

Manual (no tests in this pass per user instruction):

1. DB up; `pnpm --filter @clinic/api dev` (API on :3001);
   `pnpm --filter @clinic/web dev` (Vite on :5173).
2. Sign in as `dr.-east-lead@clinic.local` (role=doctor).
   Land on DoctorApp → DoctorAffected kanban.
3. Open an affected card's "Audit log" button. Drawer slides in
   from the right. Header reads "Patient ···3456" (or whatever
   the row is for). Summary shows "0 events · 0 today · scope:
   your appointments only" for a freshly-created appointment.
4. Seed an audit trail by:
   - creating a booking as a patient (`E3-S1` flow);
   - rescheduling it (E4-S2);
   - moving it via the doctor's resolve flow (E6-S2);
   - cancelling it (E5-S1 / E5-S2).
   The drawer should show 4 rows: Create, Resolve, Resolve,
   Cancel. The time column reads HH:MM for today, "MMM D ·
   HH:MM" for older rows.
5. Filter chips: click "Cancellations" → only the cancel row
   shows. Click "Status changes" → empty state ("No events
   match the current filter."). Click "All" → full list.
6. Escape → drawer closes. Click on backdrop → drawer closes.
7. Cross-doctor privacy: open DevTools → Network, fire
   `GET /doctor/appointments/<id>/audit` for an appointment
   NOT owned by the signed-in doctor. Should return 403
   `outside_branch_scope` (or 404 not_found if the id doesn't
   exist). The drawer's error state renders the friendly
   string.
8. Privacy check: confirm the response carries `patient_phone`
   but no `patient_name` (E7-S3 invariant). The drawer title
   uses the synthetic "Patient ···{last4}" label.
9. Empty state: open the drawer for a brand-new appointment
   (count=0). Drawer body shows "No audit events for this
   appointment yet."
10. `pnpm --filter @clinic/web typecheck` — 0 new errors.
11. `pnpm --filter @clinic/web lint` — 0 new warnings.
12. Grep `apps/web/src` for hex literals outside `tokens.css`
    → 0 (E7-S1 invariant).

## Out of scope (deferred to later stories)

- **D-E7-S-UI-1** — Admin audit log (mock 27). The admin back-
  end returns a `rejected_per_role_policy` envelope per PRD
  §2.4; today the admin has no UI to render the policy. A
  future hardening pass exposes the policy envelope as a
  static "What admins don't see" card on the admin pages.
- **D-E7-S-UI-2** — CSV export. The drawer's "Export CSV"
  button is present but `disabled` with a tooltip explaining
  the deferral. A future story generates a CSV from the loaded
  rows.
- **D-E7-S-UI-3** — Receptionist audit drawer UI. The back-end
  endpoint is wired (`getReceptionistAppointmentAudit`), but
  no surface invokes it today. The receptionist's today view
  (E5-S3 UI, mock 13 / 15 / 26) doesn't yet have an
  appointment-detail affordance; that surface is a future
  story.
- **D-E7-S-UI-4** — Pagination / "load older" for the audit
  drawer. Today the server returns at most 200 rows; the
  drawer renders them all in a scrollable list. A future
  story adds cursor-based pagination.
- **D-E7-S-UI-5** — E7-S5 a11y baseline. The drawer uses
  `role="dialog"`, `aria-modal="true"`, `aria-label`, focus
  on the close button, and `aria-pressed` on filter chips —
  but the broader cross-cutting a11y work (keyboard trap, live
  region announcements, focus restoration) is a separate
  pass.

## Cross-references

- `apps/api/src/routes/doctor-appointment-audit.ts` (E7-S2 back-end)
- `apps/api/src/routes/reception-appointment-audit.ts` (E7-S2 reception)
- `apps/api/src/routes/admin-audit.ts` (E7-S2 admin policy envelope)
- `docs/design/mockups/v1/mockups/30-doctor-audit-drawer.html` (visual reference)
- `docs/design/DESIGN-SYSTEM.md` (token-only CSS invariant, E7-S1)
