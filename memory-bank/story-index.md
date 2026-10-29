# Story Index

<!--
  Single-file story index (memory-bank mode: single-file).

  This repository predates the AI-DLC flow: the story catalogue was
  created under BMAD, in
  `_bmad-output/implementation-artifacts/sprint-status.yaml`, and its
  specs live beside it as `spec-<key>.md`.

  This index mirrors that catalogue so an AI-DLC agent can find the
  story list without knowing about BMAD. It is a *pointer*, not a
  replacement — sprint-status.yaml remains the source of truth for
  status, and the `spec-*.md` files remain the source of truth for
  intent.

  When a story moves through the AI-DLC flow (intent → unit → story →
  bolt), add a row here under the matching epic, with the memory-bank
  path in the "Memory bank" column.
-->

## Summary

| Status | Count |
|---|---|
| `done` | 71 |
| `in-progress` | 2 |
| `ready-for-dev` | 3 |
| `optional` (retrospectives) | 3 |
| **Total** | **79** |

The 7 `epic-N` keys in `sprint-status.yaml` are epic-level status
entries, not stories; they are not counted above.

Two spec files exist on disk but have **no `sprint-status.yaml` key** —
they were drafted but never registered as stories:

| Spec | Note |
|---|---|
| `spec-w10a-staff-password-auth.md` | The password half of the W10 staff-auth workstream. The password check it describes **is** implemented (`auth-staff.ts` verifies against the stored bcrypt hash); only the status bookkeeping is missing. |
| `spec-w11-phone-input-international.md` | International phone input. The E.164 validation it describes **is** implemented (`E164_PHONE_RE`); only the status bookkeeping is missing. |

---

## Epic 0 — Foundation

*Repo skeleton, data model, auth provider, SMS gateway, seeds,
observability.*

Epic status: **done**

| Story | Status | Spec | Memory bank |
|---|---|---|---|
| `0-1-repo-skeleton-starter-template` | done | `spec-0-1-repo-skeleton-starter-template.md` | — |
| `0-2-data-model-migrations` | done | `spec-0-2-data-model-migrations.md` | — |
| `0-3-auth-provider-wiring` | done | `spec-0-3-auth-provider-wiring.md` | — |
| `0-4-sms-otp-gateway` | done | `spec-0-4-sms-otp-gateway.md` | — |
| `0-5-seed-data-role-fixtures` | done | `spec-0-5-seed-data-role-fixtures.md` | — |
| `0-6-observability-baseline` | done | `spec-0-6-observability-baseline.md` | — |
| `epic-0-retrospective` | optional | — | — |

## Epic 1 — Clinic & Branch Administration

*Singleton clinic anchor, branches, operating hours, doctors,
receptionists.*

Epic status: **done**

| Story | Status | Spec | Memory bank |
|---|---|---|---|
| `1-0a-clinic-singleton-enforcement` | done | `spec-1-0-clinic-management-single-clinic-anchor.md` | — |
| `1-0b-admin-clinic-api` | done | `spec-1-0-admin-clinic-api.md` | — |
| `1-0-ui-clinic-settings` | done | `spec-1-0-ui-clinic-settings.md` | — |
| `1-0-ui-remaining` | done | `spec-1-0-ui-remaining.md` | — |
| `1-0-ui-router` | done | `spec-1-0-ui-router.md` | — |
| `1-1-create-edit-deactivate-branches` | done | `spec-1-1-create-edit-deactivate-branches.md` | — |
| `1-1-ui-admin-branches` | done | `spec-1-1-ui-admin-branches.md` | — |
| `1-2-change-branch-operating-hours` | done | `spec-1-2-change-branch-operating-hours.md` | — |
| `1-2-ui-admin-branch-hours` | done | `spec-1-2-ui-admin-branch-hours.md` | — |
| `1-3-create-deactivate-assign-branch-doctors` | done | `spec-1-3-create-deactivate-assign-branch-doctors.md` | — |
| `1-3-ui-admin-doctors` | done | `spec-1-3-ui-admin-doctors.md` | — |
| `1-4-create-deactivate-assign-branch-receptionists` | done | `spec-1-4-create-deactivate-assign-branch-receptionists.md` | — |
| `1-4-ui-admin-receptionists` | done | `spec-1-4-ui-admin-receptionists.md` | — |
| `epic-1-retrospective` | optional | — | — |

## Epic 2 — Doctor Configuration

*Weekly schedule, blocks, appointment types, negative capability.*

Epic status: **done**

| Story | Status | Spec | Memory bank |
|---|---|---|---|
| `2-1-configure-weekly-schedule-multi-period-days` | done | `spec-2-1-configure-doctor-weekly-schedule.md` | — |
| `2-1-ui-doctor-weekly-schedule` | done | `spec-2-1-ui-doctor-weekly-schedule.md` | — |
| `2-2-block-time-single-date-range-multi-day` | done | `spec-2-2-block-time.md` | — |
| `2-2-ui-doctor-block-time` | done | `spec-2-2-ui-doctor-block-time.md` | — |
| `2-3-manage-appointment-types-create-edit-deactivate` | done | `spec-2-3-manage-appointment-types.md` | — |
| `2-3-ui-admin-appointment-types` | done | `spec-2-3-ui-admin-appointment-types.md` | — |
| `2-4-negative-capability-doctor-cannot-reschedule` | done | `spec-2-4-doctor-cannot-reschedule.md` | — |
| `epic-2-retrospective` | optional | — | — |

## Epic 3 — Availability & Booking

*The availability engine and the four booking paths.*

Epic status: **done**

| Story | Status | Spec | Memory bank |
|---|---|---|---|
| `3-1-availability-engine` | done | `spec-3-1-availability-engine.md` | — |
| `3-2-guest-booking-first-time` | done | `spec-3-2-guest-booking-first-time.md` | — |
| `3-3-returning-patient-booking-known-phone` | done | `spec-3-3-returning-patient-booking-known-phone.md` | — |
| `3-4-receptionist-booking-on-behalf-of-patient` | done | `spec-3-4-receptionist-booking-on-behalf-of-patient.md` | — |
| `3-5-receptionist-reads-doctor-availability` | done | `spec-3-5-receptionist-reads-doctor-availability.md` | — |
| `3-ui-patient-booking` | done | `spec-3-ui-patient-booking.md` | — |
| `epic-3-retrospective` | done | — | — |

## Epic 4 — Patient Self-Service

*OTP, appointments list, cancel, reschedule, deep link.*

Epic status: **done**

| Story | Status | Spec | Memory bank |
|---|---|---|---|
| `4-1-patient-otp-verification` | done | `spec-4-1-patient-otp-verification-upcoming-appointments.md` | — |
| `4-2-patient-cancellation` | done | `spec-4-2-patient-cancellation.md` | — |
| `4-3-patient-rescheduling` | done | `spec-4-3-patient-rescheduling.md` | — |
| `4-4-deep-link-entry-to-cancel-reschedule` | done | `spec-4-4-deep-link-entry-cancel-reschedule.md` | — |
| `4-1-2-3-4-ui-patient-self-service` | done | `spec-4-1-2-3-4-ui-patient-self-service.md` | — |
| `epic-4-retrospective` | done | — | — |

## Epic 5 — Staff Appointment Lifecycle

*Mark status, cancel with reason, today view, no-deletion rule.*

Epic status: **done**

| Story | Status | Spec | Memory bank |
|---|---|---|---|
| `5-1-mark-completed-no-show` | done | `spec-5-1-mark-completed-no-show.md` | — |
| `5-2-doctor-cancellation-with-reason` | done | `spec-5-2-doctor-cancellation.md` | — |
| `5-3-receptionist-cancellation-with-reason` | done | `spec-5-3-receptionist-cancellation.md` | — |
| `5-4-todays-branch-view-receptionist-dashboard` | done | `spec-5-4-todays-branch-view.md` | — |
| `5-5-no-deletion-negative-test` | done | `spec-5-5-no-deletion.md` | — |
| `5-1-2-ui-doctor-mark-cancel` | done | `spec-5-1-2-ui-doctor-mark-cancel.md` | — |
| `5-3-5-4-ui-receptionist-today-cancel` | done | `spec-5-3-5-4-ui-receptionist-today-cancel.md` | — |
| `epic-5-retrospective` | done | — | — |

## Epic 6 — Recurring & Conflict Resolution

*Recurring preview/create, per-occurrence independence, doctor conflict
move, branch-hours impact flag.*

Epic status: **done**

| Story | Status | Spec | Memory bank |
|---|---|---|---|
| `6-1-recurring-appointment-preview-partial-success-create` | done | `spec-6-1-recurring-preview-create.md` | — |
| `6-2-resolve-affected-appointments-doctor` | done | `spec-6-2-doctor-conflict-move.md` | — |
| `6-2-ui-doctor-conflict-move` | done | `spec-6-2-ui-doctor-conflict-move.md` | — |
| `6-3-branch-hours-impact-flag-admin` | done | `spec-6-3-doctor-affected-queue.md` | — |
| `6-4-per-occurrence-recurring-cancel-reschedule` | done | `spec-6-4-recurring-occurrence-cancel-reschedule.md` | — |
| `epic-6-retrospective` | done | — | — |

## Epic 7 — Design System, A11y & Hardening

*Tokens, conflict modal, audit reads, privacy filter, accessibility,
timezone support, no client-side holds.*

Epic status: **in-progress** (three stories still `ready-for-dev`, the
retro is open)

| Story | Status | Spec | Memory bank |
|---|---|---|---|
| `7-1-design-system-tokens` | done | `spec-7-1-design-system-tokens.md` | — |
| `7-1-design-system-token-wiring` | done | `spec-7-1-design-system-token-wiring.md` | — |
| `7-2-appointment-audit` | done | `spec-7-2-appointment-audit-reads.md` | — |
| `7-2-ui-audit-drawers` | done | `spec-7-2-ui-audit-drawers.md` | — |
| `7-3-patient-privacy-filter` | done | `spec-7-3-patient-privacy-filter.md` | — |
| `7-4-conflict-modal-global-component` | done | `spec-7-4-conflict-modal-global-component.md` | — |
| `7-5-accessibility-baseline-wcag-2-1-aa` | done | `spec-7-5-accessibility-baseline-wcag-2-1-aa.md` | — |
| `7-6-branch-timezone-support` | done | `spec-7-6-branch-timezone-support.md` | — |
| `7-7-no-tentative-client-side-slot-holds` | done | `spec-7-7-no-tentative-client-side-slot-holds.md` | — |
| `7-8-performance-availability-slas` | ready-for-dev | `spec-7-8-performance-availability-slas.md` | — |
| `7-9-product-metrics-instrumentation` | ready-for-dev | `spec-7-9-product-metrics-instrumentation.md` | — |
| `7-10-design-open-questions-parking-lot` | ready-for-dev | `spec-7-10-design-open-questions-parking-lot.md` | — |
| `epic-7-retrospective` | in-progress | — | — |

## Workstream stories

*Cross-epic work tracked outside the epics.*

| Story | Status | Spec | Memory bank |
|---|---|---|---|
| `w10-staff-login-patient-otp` | done | `spec-w10-staff-login-patient-otp.md` | — |
| `w10a-staff-password-auth` | done | `spec-w10a-staff-password-auth.md` | — |
| `w11-phone-input-international` | done | `spec-w11-phone-input-international.md` | — |
| `w12-login-split-staff-catalog-audit-drawer` | done | `spec-w12-login-split-staff-catalog-audit-drawer.md` | — |

---

## Where the specifications live

| What | Path |
|---|---|
| Story catalogue + status (source of truth) | `_bmad-output/implementation-artifacts/sprint-status.yaml` |
| Per-story specs | `_bmad-output/implementation-artifacts/spec-<key>.md` |
| Epic 7 build-order index | `_bmad-output/implementation-artifacts/epic-7-backlog-specs-index.md` |
| Deferred work register | `_bmad-output/implementation-artifacts/deferred-work.md` |
| Planning (epics, PRD, UX) | `docs/specs/`, `_bmad-output/planning-artifacts/` |
| Design system + mockups | `docs/design/` |

**Spec files are not renumbered.** `FR-xxx`, `BR-xxx` and `F-xx`
identifiers are stable forever; only `§N` section numbers are
structural and may shift — and when they do, every inbound reference
must be repaired in the same change.
