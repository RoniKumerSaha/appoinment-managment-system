---
title: 'W11 — Single-input phone field (no country picker)'
type: 'bugfix'
created: '2026-10-27'
status: 'done'
review_loop_iteration: 0
baseline_commit: '7a172f2'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/spec-w10-staff-login-patient-otp.md'
  - '{project-root}/docs/design/DESIGN-SYSTEM.md'
  - '{project-root}/docs/design/mockups/v1/mockups/21-patient-otp-modal.html'
---

## Intent

**Problem:** The booking flow's phone field is a country chip + a number
input, and the two were glued together blindly. `joinPhone(countryCode,
nationalNumber)` stripped the *selected* country's dial code from the
typed value and nothing else. A patient who typed their whole
international number — the normal thing to do — got a corrupted string:

```
chip: SA +966     typed: +8801684960808
→ joinPhone → "+9668801684960808"   (16 digits)
→ E.164 regex /^\+[1-9]\d{6,14}$/ → INVALID
```

The field never validated, so the wizard could not advance past step 4.
The same defect silently rewrote legitimate numbers: the e2e journey
suite was booking as `+96615550000002` when the patient had signed in as
`+15550000002`, so `GET /patient/appointments` (which binds the phone
from the JWT claim) returned an empty list and the whole
`complete-user-journey` spec failed at step 2.

Compounding it, `+880` (Bangladesh) was not in the country catalogue at
all, so the chip could never reflect a Bangladeshi number even when the
patient picked "Other country".

**Approach:** Delete the country picker. The phone field is ONE input
and the patient types the whole international number — the country code
is part of the number, the way it is in every other booking app. The
field normalises what was typed (separators, a longhand `00` prefix,
leading zeros) into the single E.164 string the API expects. We never
guess a country code for the patient: a bare national number is
rejected, and the field says what is missing.

The API contract is untouched — the client still submits one E.164
string.

> **Note (2026-10-27, later the same day):** this story first shipped a
> *single-input* fix that kept the chip and made it follow what the
> patient typed. The user then asked for the country-code field to be
> removed outright, so the chip, the country catalogue and the
> join/split helpers are gone. The final design is the one described
> above. The intermediate design is recorded in the Change Log below
> for the record.

## Boundaries & Constraints

**Always:**
- The API contract is unchanged. Every phone the client submits is still E.164 (`^\+[1-9]\d{6,14}$`), which is what `availability.ts`, `bookings-helpers.ts`, `patient-otp.ts`, `sms-otp.ts`, `patient-profile.ts`, `patient-reschedule.ts` and `recurring-helpers.ts` all validate against.
- **There is one phone input and no country picker.** The country code is part of the number the patient types.
- The field **never guesses a country code**. A bare national number (`512345678`) is not given a `+966`; it is rejected and the patient is told what is missing. Guessing wrong would book the appointment under a phone that belongs to nobody.
- Cosmetic separators are stripped before validation: `+966 512 345 678`, `+1 (555) 123-4567` and `+880.1684.960808` are all accepted.
- The longhand international prefix `00` is treated as `+`: `00966512345678` → `+966512345678`.
- A leading zero immediately after the `+` is dropped, because E.164 forbids it: `+00966…` → `+966…`.
- The value in the input is never rewritten under the patient — the app does not reformat what they typed.
- The shared behaviour lives in one hook (`usePhoneField`) used by both the public booking flow (`PatientBooking`) and the receptionist walk-in form (`ReceptionistCreate`), so the two cannot drift.
- The placeholder and hint show a full international number (`+966 5XX XXX 5555`), matching the format the design system already documents.

**Ask First:**
- **A1 — Keep the chip (auto-syncing) vs. remove it.** (i) **Remove the chip entirely** (chosen — the user's explicit instruction, and the behaviour every mainstream booking app has). The cost is that the one-tap Gulf presets from P-03/SC-04 are gone; the patient types `+966` instead of tapping it. (ii) Keep the chip and sync it to what the patient types — this was the intermediate design shipped earlier the same day, and it is strictly more UI for the same result. (iii) Keep the chip as a display-only label (no dropdown) — rejected, it would still be a second thing to look at for no benefit.
- **A2 — Where to put the normalisation logic.** (i) A shared `usePhoneField` hook plus a pure `normalizePhone` in `booking-utils` (chosen) — one implementation, both pages identical, and the pure function stays unit-testable without a React testing library. (ii) Duplicate the logic in each page — rejected, the two would drift. (iii) Put it inside the input component — rejected, there is no dedicated input component; the pages own the field.

## I/O & Edge-Case Matrix

| # | Trigger | Behaviour |
|---|---------|-----------|
| 1 | Type `+966512345678` | `+966512345678` — valid, the wizard advances |
| 2 | Type `+8801684960808` | `+8801684960808` — valid (Bangladesh is not special-cased) |
| 3 | Type `+1 555 123 4567` | `+15551234567` — separators stripped, valid |
| 4 | Type `+81123456789` | `+81123456789` — valid (no country catalogue, so no code is unknown) |
| 5 | Type `00966512345678` | `+966512345678` — the longhand `00` prefix is understood |
| 6 | Type `+00966512345678` | `+966512345678` — the leading zero is dropped |
| 7 | Type `512345678` | `512345678` — **invalid**, no country code is guessed; the continue button stays disabled |
| 8 | Type `966512345678` | `966512345678` — invalid, same reason |
| 9 | Type `+0123` | `+123` — invalid, E.164 forbids a zero country code |
| 10 | Type `+9665123456789012` | invalid — more than 15 digits |
| 11 | Empty input | `''` — invalid |
| 12 | `reset()` (start over / book another) | the field is cleared |

## Code Map

**Web (new / edited):**
- `apps/web/src/pages/usePhoneField.ts` (NEW) — the shared hook: `phone` (the raw input), `e164` (the normalised string the API receives), `isValid`, `onPhoneChange`, `reset`.
- `apps/web/src/pages/booking-utils.ts` (EDIT) — new `normalizePhone(raw)`; `joinPhone` / `splitPhone` / `detectCountryCode` are gone.
- `apps/web/src/pages/PhoneCountryPicker.tsx` (DELETED) — the chip + searchable listbox.
- `apps/web/src/pages/PhoneCountryPicker.module.css` (DELETED).
- `apps/web/src/pages/phone-countries.ts` (DELETED) — the country catalogue; with the chip gone it had no remaining consumer.
- `apps/web/src/pages/PatientBooking.tsx` (EDIT) — one input; the placeholder and hint show a full international number.
- `apps/web/src/pages/ReceptionistCreate.tsx` (EDIT) — one input; the hint asks for the country code instead of naming one.
- `apps/web/src/pages/PatientBooking.module.css` (EDIT) — the dead `.phone-row` / `.cc-chip` rules removed.
- `apps/web/src/pages/ReceptionistCreate.module.css` (EDIT) — the dead `.phone-row` rules removed.

**Tests:**
- `apps/web/test/phone-country.test.ts` → `apps/web/test/phone-number.test.ts` (RENAMED + REWRITTEN) — pins `normalizePhone` and `isValidPhone`. 10 tests.
- `apps/web/test/run-phone-country.mjs` → `apps/web/test/run-phone-number.mjs` (RENAMED).
- `apps/web/package.json` (EDIT) — the script is now `test:phone-number`.
- `apps/web/e2e/flows/phone-country-picker.spec.ts` → `apps/web/e2e/flows/phone-number.spec.ts` (RENAMED + REWRITTEN) — five browser tests: there is no picker, a full international number is accepted, separators are tolerated, a country-less number is rejected, and the submitted phone is what the patient typed.
- `apps/web/e2e/pages/patient.page.ts` (EDIT) — `confirmBooking()` waits for the receipt (see below).
- `apps/web/e2e/flows/complete-user-journey.spec.ts` (EDIT) — `signOut()` selects by accessible name.

**API:**
- `apps/api/test/19-staff-password-auth.test.ts` (EDIT) — the `setPassword` helper's return type was `request.Response` (the callback type) instead of `request.Test`; the API typecheck was failing on it.

## The e2e race this uncovered

The `complete-user-journey` spec failed at step 2 ("patient has at least
one future appointment") for two independent reasons, both fixed here:

1. **The phone bug above** — the booking was created with the wrong
   phone, so the claim-bound list could not see it.
2. **A race in the test** — `confirmBooking()` clicked the confirm button
   and returned immediately, so the spec queried the appointments list
   *before* `POST /bookings` had resolved. The API log shows the
   ordering plainly: `GET /patient/appointments` at `09:26:22.770`,
   `POST /bookings` completing at `09:26:23.287`. The helper now waits
   for `patient-booking-receipt`, which the app renders only after the
   POST resolves.

A third, unrelated defect: `signOut()` selected `button.nav__signout`
(the staff `AppShell` class) while the patient app renders its own
`PatientFrame` nav. It now selects by accessible name, which both
share.

Before this change the e2e suite was **1 passed / 6 failed / 8 not
run**. It is now **15 passed**.

## Reuse of existing code

- `apps/web/src/pages/booking-utils.ts` `isValidPhone` — the E.164 regex was already there and is unchanged; `normalizePhone` is new and sits beside it.
- `apps/web/src/styles/tokens.css` — no new tokens; the hint text and placeholder reuse the existing field styles.
- `docs/design/DESIGN-SYSTEM.md` §3.4 — already specified the phone format as `+966 5XX XXX 5555`, which is exactly what the single input now asks for. The design system did not need to change; the implementation caught up with it.

## Verification

1. `pnpm --filter @clinic/web typecheck` — 0 errors.
2. `pnpm --filter @clinic/web lint` — 0 errors, 0 warnings.
3. `pnpm --filter @clinic/api typecheck` — 0 errors.
4. `pnpm --filter @clinic/api lint` — unchanged (0 errors).
5. API suite — **394 pass / 0 fail**.
6. Web unit runners — all 10 green; `test:phone-number` is **10 pass** (was `phone-country`, 18).
7. `pnpm --filter @clinic/web test:e2e` — **15 passed** (was 1 passed / 6 failed / 8 not run).
8. E7-S1 invariant (no hex literals outside `tokens.css`) — green.
9. Dead-code sweep — a grep for `PhoneCountryPicker|phone-countries|joinPhone|splitPhone|detectCountryCode|searchCountries|findCountry|DEFAULT_COUNTRY_CODE|OTHER_COUNTRY|countryCode|nationalNumber|onCountryChange|onNumberChange|phone-row|cc-chip` across `apps/web/src`, `apps/web/e2e`, `apps/web/test`, `apps/api/src`, `apps/api/test` and `docs/design` returns **zero hits**.
10. Manual: type `+8801684960808` in the booking phone field → the field validates and the wizard advances. Type `512345678` → the continue button stays disabled and the hint says the country code is missing.

## Spec Change Log

- 2026-10-27 — initial spec. Done.
- 2026-10-27 (later the same day) — **the country picker was removed outright.** The first implementation kept the chip and made it follow what the patient typed. The user then asked for the country-code field to be removed, so the chip, the country catalogue (`phone-countries.ts`) and the join/split helpers are gone; the field is one input and the normaliser is `normalizePhone`. The API contract never changed. The intermediate design is recorded in the note under **Intent**.

## Deferrals

- **Formatting the number as the patient types (e.g. `+880 1684 960808`).** The app normalises separators away before validating but does not re-insert them, so the value shown is what the patient typed. Grouping is a cosmetic follow-up.
- **Live formatting as the patient types** (regrouping on each keystroke). Deliberately not done: rewriting the input under the patient is the behaviour this story was opened to remove, and it breaks cursor position mid-edit.
- **Guessing a country code from a national number.** Not a deferral but a decision — a bare national number is rejected rather than assumed to be `+966`, because guessing wrong books the appointment under a phone that belongs to nobody.
- **A one-tap country preset / dialling-code shortcut.** Dropped along with the chip. The patient types `+966` instead of tapping it — one extra keystroke, no second control to understand.
- **Deriving the country from the request IP or locale.** Not attempted, and moot now that the app has no notion of a selected country.

## Cross-References

- `spec-w10-staff-login-patient-otp.md` — the auth surface that fronts the booking flow.
- `docs/design/DESIGN-SYSTEM.md` §3.4 (phone format) — the E.164 rule the client must satisfy.
- `apps/api/src/routes/bookings-helpers.ts` `isValidE164Phone` — the server-side contract.
- `apps/web/src/pages/booking-utils.ts` — `normalizePhone` / `isValidPhone`.
- `apps/web/src/pages/usePhoneField.ts` — the shared hook both phone fields use.
- `apps/web/test/phone-number.test.ts` — the unit tests for the normaliser.
- `apps/web/e2e/flows/phone-number.spec.ts` — the browser tests for the single input.
