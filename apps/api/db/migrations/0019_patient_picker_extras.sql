-- E7-UX: patient picker extras — doctor.specialty + appointment_type.description.
--
-- The patient booking flow renders branch / type / doctor cards that mirror
-- the v1 design mockups (docs/design/mockups/v1/mockups/02-doctor-picker.html,
-- 34-patient-branch-picker.html, 35-patient-type-picker.html, 36-confirmation-
-- receipt.html). The mockups assume each doctor card can show a specialty
-- ("Cardiology", "Family Medicine") and each appointment-type card can show a
-- one-line description ("Standard visit for new or ongoing heart-related
-- concerns."). Today the public DTOs only carry `full_name` and
-- `duration_minutes` respectively; the picker renders an empty line.
--
-- This migration adds two new columns. Both are additive and nullable, so it
-- is safe to run against a live DB without a backfill. The seed
-- (`apps/api/db/seeds/01_minimum.ts`) UPDATE-on-reseed fills the values for
-- the 3 fixture doctors + 3 fixture types. Pre-existing customer data stays
-- NULL until an admin edits the doctor's profile or the appointment type —
-- the UI gracefully degrades to a fallback string (e.g. "General practice").
--
-- Schema after this migration:
--   doctor(
--     ...existing columns...,
--     specialty    text  -- NEW (E7-UX); nullable
--   )
--   appointment_type(
--     ...existing columns...,
--     description  text  -- NEW (E7-UX); nullable
--   )
--
-- Idempotent: ADD COLUMN IF NOT EXISTS is a no-op on a re-apply.

-- ===== doctor.specialty =====
ALTER TABLE doctor
  ADD COLUMN IF NOT EXISTS specialty text;

-- ===== appointment_type.description =====
ALTER TABLE appointment_type
  ADD COLUMN IF NOT EXISTS description text;
