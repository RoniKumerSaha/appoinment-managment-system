# Persona 01 — The Patient

> *A guest. No account. Phone is identity.*

---

## Snapshot

**Name:** Maya (representative; not a literal user)
**Age:** 34
**Lives:** mid-sized city, owns a smartphone, uses WhatsApp and a browser interchangeably, often on mobile data.
**Work:** part-time professional with two kids and a parent she sometimes books for.
**Tech comfort:** high for chat and maps; low for portals, accounts, and password resets.

---

## The role, in one line

> *I need to book a real appointment at a real time, fast — and I need to trust it will still be mine when I show up.*

She is a **guest**. She does not want to register, set a password, verify an email, or remember a username. The product's BR-028 promise — *"patients do not require passwords or traditional accounts"* — is built for her.

---

## Context — when she shows up

- She's worried about a child's rash, a parent's blood pressure, her own checkup she keeps postponing.
- She's on her phone in a waiting room, on a smoke break, in the car, between meetings.
- She may have done this before at a different clinic — and remembers it as "I had to call, they put me on hold, they asked for my name three times."
- She's often booking for someone else. The number she types in might not be the patient's number.

---

## Goals — positive (what pulls her in)

| # | Positive goal | What it feels like |
|---|---|---|
| **PG-P1** | Find a doctor I trust, near me, soon | "I want to see *this* doctor, at *this* branch, before the weekend." |
| **PG-P2** | Book without friction | "Don't make me sign up. Don't make me call." |
| **PG-P3** | Get a real confirmation | "I want a screen I can come back to. Something I can show my husband." |
| **PG-P4** | See my appointment any time, on my phone | "Where am I booked? What time? Do I need to do anything before?" |
| **PG-P5** | Change my mind without guilt | "I can't come Tuesday. Move me." |

## Goals — negative (what she fears)

| # | Negative goal | What it feels like |
|---|---|---|
| **NG-P1** | A silent change to my appointment | "I showed up and they said I wasn't on the list." |
| **NG-P2** | A slot that turns out to be fake | "I picked 3pm. They gave me 4pm and said that's what I picked." |
| **NG-P3** | Having to call back to verify | "I just gave you my number. Why are you calling me?" |
| **NG-P4** | Carrying the doctor's information in my head | "Which doctor was it? The one on Maps or the one my friend recommended?" |
| **NG-P5** | Atying up a relative's number to my booking | "I used my dad's phone because he wasn't with me. Now he can't get his OTP." |

---

## Behavior patterns

- **Searches by symptom and location before doctor.** She often doesn't know *which* doctor she wants until she sees who's available.
- **Books while doing something else.** One-handed, in motion, distracted. Any flow over ~90 seconds loses her.
- **Won't read your marketing copy.** She reads the next button, the time, the doctor's name. That's it.
- **Reads every error message, slowly.** Errors are where she decides whether the site is trustworthy. If the error is vague, she gives up. If the error is specific, she trusts the system.
- **Returns by going to her last confirmation.** She doesn't bookmark; she scrolls her chat or her browser history.

---

## Technology comfort

- High for: WhatsApp, SMS, Google search, Google Maps, photo screenshots.
- Medium for: browser-based forms, calendar apps, email.
- Low for: portals, account creation, password resets, anything that requires a desktop browser.

**Implication:** the OTP confirmation flow must work without email. The patient dashboard must work on mobile first, in the browser, without an app install.

---

## Quote

> *"Just tell me when and where. Don't make me prove who I am to see what's already mine."*

---

## What this persona demands of the design

1. **Phone is identity, OTP is the key.** Don't ask for an email. Don't offer a "create account for faster booking" — it breaks the BR-028 promise.
2. **The confirmation screen is the product.** It must look like a receipt: time, branch, doctor, appointment type, what to bring, a clear "view anytime" path.
3. **The "your appointment" view must work on mobile, in the browser, without an account.** This is the *visibility* half of the product promise.
4. **Errors must be specific and resolvable.** "This slot is no longer available — choose another." Not "Booking failed."
5. **Booking for someone else must be supported.** If the phone number on file is not the patient's phone, we need a path — currently out of scope (BR-029 is phone-on-file), so the design must surface this limitation gracefully, not pretend it doesn't exist.
6. **No last-moment surprises.** If anything in her appointment changes between booking and arrival, she must see it before she leaves the house. (This is the trigger for NG-P1.)
