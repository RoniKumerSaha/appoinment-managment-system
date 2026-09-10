-- E0-S2: 0002 — extensions.
--
-- Creates the three extensions the schema depends on:
--   - pgcrypto: gen_random_uuid() — required because every primary key uses it.
--   - citext: case-insensitive text — used by receptionist.email and admin_user.email
--     UNIQUE constraints so mixed-case duplicates collapse.
--   - btree_gist: provides the equality operator classes for uuid/text inside
--     a GIST index, which the EXCLUDE USING gist constraint on appointment
--     (0008) needs for (doctor_id WITH =, branch_id WITH =).
--
-- All three use IF NOT EXISTS so a re-run on an environment where one is
-- already present is a no-op.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS btree_gist;
