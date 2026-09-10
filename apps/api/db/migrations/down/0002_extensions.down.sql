-- E0-S2: 0002 — extensions (down).
--
-- Reverse the create-extension steps. Note: IF EXISTS clauses protect against
-- the extension already being absent. Drop in reverse order.

DROP EXTENSION IF EXISTS btree_gist;
DROP EXTENSION IF EXISTS citext;
DROP EXTENSION IF EXISTS pgcrypto;
