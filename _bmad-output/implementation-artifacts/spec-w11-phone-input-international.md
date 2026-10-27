---
title: 'W11 — Patient can type a full international phone number'
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

**Approach:** Make the input the source of truth. A number the patient
types is accepted as-is if it carries its own `+CC` prefix; the chip
then *follows* what they typed instead of overriding it. A bare national
number still gets the chip's dial code prepended. The API contract is
untouched — the client still submits one E.164 string.

## Boundaries & Constraints

**Always:**
- The API contract is unchanged. Every phone the client submits is still E.164 (`^\+[1-9]\d{6,14}$`), which is what `availability.ts`, `bookings-helpers.ts`, `patient-otp.ts`, `sms-otp.ts`, `patient-profile.ts`, `patient-reschedule.ts` and `recurring-helpers.ts` all validate against.
- A typed `+CC…` number wins over the chip. The chip is a convenience for typing a national number, not an override of a number the patient already qualified.
- The chip **auto-syncs** to the country the patient typed, so the UI stays truthful about what will be submitted.
- A `+CC` prefix that is not in the catalogue is still a valid international number: it splits as `OTHER` (the existing escape hatch) rather than being rejected. `splitPhone` no longer returns `null` for an unknown country code — only for a value with no `+` at all.
- `+880` (Bangladesh) is added to the catalogue, so the chip can display it.
- The country chip is **not** a required interaction. The field's placeholder and hint now show a full international number (`+966 5XX XXX 5555`) and say the chip follows what you type.
- The shared behaviour lives in one hook (`usePhoneField`) used by both the public booking flow (`PatientBooking`) and the receptionist walk-in form (`ReceptionistCreate`), so the two cannot drift.
- The value in the input is never rewritten under the patient — the app does not reformat what they typed.
- Changing the chip still clears a bare national number (it belonged to the old country), but **keeps** a number that carries its own `+CC` prefix (it is not country-bound).

**Ask First:**
- **A1 — Auto-detect-and-sync vs. ignore the chip entirely.** (i) Auto-detect and sync the chip to the typed country (chosen) — the chip stays truthful, the patient can still override it, and the UI never shows "SA +966" for a Bangladeshi number. (ii) Ignore the chip whenever the value has a `+` — simpler, but the chip would then display a country that contradicts the number. (iii) Drop the chip entirely and require a full international number — the most explicit, but it breaks the one-tap Gulf presets that P-03/SC-04 specify and makes the common Saudi case slower.
- **A2 — Where to put the sync logic.** (i) A shared `usePhoneField` hook (chosen) — one implementation, both pages identical, and the pure parts (`joinPhone`/`splitPhone`/`detectCountryCode`) stay unit-testable without a React testing library. (ii) Duplicate the logic in each page — rejected, the two would drift. (iii) Push the detection into `PhoneCountryPicker` — rejected, the picker is presentational; it does not own the input's value.

## I/O & Edge-Case Matrix

| # | Trigger | Behaviour |
|---|---------|-----------|
| 1 | Chip `SA`, type `512345678` | `+966512345678` (national number, chip prefixes) |
| 2 | Chip `SA`, type `+8801684960808` | `+8801684960808`; chip auto-switches to `BD` |
| 3 | Chip `SA`, type `+1 555 123 4567` | `+15551234567`; chip auto-switches to `US` |
| 4 | Chip `SA`, type `+81123456789` (unknown code) | `+81123456789`; chip auto-switches to `OTHER` |
| 5 | Chip `SA`, type `+966 512 345 678` | `+966512345678`; chip stays `SA` |
| 6 | Chip `SA`, type `+966512345678` | `+966512345678` (no double prefix) |
| 7 | Chip `SA`, type `966512345678` (no `+`) | `+966512345678` (the chip's own code is stripped) |
| 8 | Chip `OTHER`, type `+15551234567` | `+15551234567` |
| 9 | Chip `OTHER`, type `15551234567` | `+15551234567` |
| 10 | Empty input | `''` |
| 11 | Chip changed while a bare national number is typed | the number is cleared (it belonged to the old country) |
| 12 | Chip changed while a `+CC…` number is typed | the number is kept (it is not country-bound) |
| 13 | `reset()` (start over / book another) | back to the initial country and an empty number |

## Code Map

**Web (new / edited):**
- `apps/web/src/pages/usePhoneField.ts` (NEW) — the shared hook: `countryCode`, `nationalNumber`, `phone`, `onCountryChange`, `onNumberChange`, `reset`, `countryName`.
- `apps/web/src/pages/booking-utils.ts` (EDIT) — `joinPhone` keeps a typed `+CC…` number intact; `splitPhone` falls back to `OTHER` for an unknown country code; new `detectCountryCode(typed)`.
- `apps/web/src/pages/phone-countries.ts` (EDIT) — `+880` (Bangladesh) added to `INTERNATIONAL_COUNTRIES`.
- `apps/web/src/pages/PatientBooking.tsx` (EDIT) — uses the hook; the placeholder and hint now show a full international number.
- `apps/web/src/pages/ReceptionistCreate.tsx` (EDIT) — uses the hook; same placeholder.

**Tests:**
- `apps/web/test/phone-country.test.ts` (EDIT) — pins the typed-international-number behaviour, the `OTHER` fallback, Bangladesh, and `detectCountryCode`. 18 tests.
- `apps/web/e2e/flows/phone-country-picker.spec.ts` (EDIT) — two new browser tests: a patient can type the whole number without touching the chip, and the value is not rewritten under them.
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

- `apps/web/src/pages/booking-utils.ts` `joinPhone` / `splitPhone` — extended in place; the join/split contract is unchanged for national numbers.
- `apps/web/src/pages/phone-countries.ts` `OTHER_COUNTRY` — the existing escape hatch is now the fallback for an unrecognised `+CC`, so no new concept was introduced.
- `apps/web/src/pages/PhoneCountryPicker.tsx` — unchanged. It already renders the `OTHER` sentinel as a bare `+` and accepts any country code as a prop, so the auto-sync needed no change there.
- `apps/web/src/styles/tokens.css` — no new tokens; the hint text and placeholder reuse the existing field styles.

## Verification

1. `pnpm --filter @clinic/web typecheck` — 0 errors.
2. `pnpm --filter @clinic/web lint` — 0 errors, 0 warnings.
3. `pnpm --filter @clinic/api typecheck` — 0 errors.
4. `pnpm --filter @clinic/api lint` — unchanged (0 errors).
5. API suite — **394 pass / 0 fail**.
6. Web unit runners — all 10 green (52 tests); `phone-country` is 18.
7. `pnpm --filter @clinic/web test:e2e` — **15 passed** (was 1 passed / 6 failed / 8 not run).
8. E7-S1 invariant (no hex literals outside `tokens.css`) — green.
9. Manual: type `+8801684960808` in the booking phone field → the chip flips to `🇧🇩 +880`, the field validates, and the wizard advances.

## Spec Change Log

- 2026-10-27 — initial spec. Done.

## Deferrals

- **Formatting the number as the patient types (e.g. `+880 1684 960808`).** The app normalises separators away before validating but does not re-insert them, so the value shown is what the patient typed. Grouping is a cosmetic follow-up.
- **A country catalogue covering every ITU dial code.** The catalogue is a convenience list (Gulf presets + common international destinations). Anything else works through `OTHER` — the country code is simply not guessed.
- **Persisting the patient's country preference.** The chip resets to `SA` on a new booking. Storing it against the patient profile is a separate story.
- **Deriving the country from the request IP or locale.** Not attempted; the chip follows what the patient types.

## Cross-References

- `spec-w10-staff-login-patient-otp.md` — the auth surface that fronts the booking flow.
- `docs/design/DESIGN-SYSTEM.md` §3.4 (phone format) — the E.164 rule the client must satisfy.
- `apps/api/src/routes/bookings-helpers.ts` `isValidE164Phone` — the server-side contract.
- `apps/web/src/pages/booking-utils.ts` — the join/split/detect helpers.
