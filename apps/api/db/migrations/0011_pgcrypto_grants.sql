-- E0-S3: 0011 — pgcrypto USAGE grant.
--
-- Closes deferred-work W7 from the E0-S2 spec review. Without this grant,
-- a future non-superuser role cannot call `pgcrypto.gen_random_bytes(...)`
-- or `digest(...)` from a non-`public` schema.
--
-- IMPORTANT: different Postgres distributions place pgcrypto in different
-- schemas. On `postgres:16-alpine` (the testcontainer image), the
-- extension's control file installs into `public`; on stock Debian/Ubuntu
-- and most managed Postgres services, it installs into a `pgcrypto` schema.
-- To handle both, this migration:
--   1. Creates the `pgcrypto` schema if missing (no-op on stock Postgres).
--   2. Re-locates pgcrypto into that schema if it ended up elsewhere
--      (DROP + CREATE; `ALTER EXTENSION ... SET SCHEMA` is forbidden when
--      the extension has objects transitively used by other objects).
--   3. Grants USAGE on the schema to PUBLIC so future low-privilege
--      roles can call pgcrypto functions.
--
-- The down migration drops the extension and the schema. Re-running the
-- up migration after a down is fine (extensions and schemas are
-- idempotent on IF EXISTS / IF NOT EXISTS).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'pgcrypto') THEN
    CREATE SCHEMA pgcrypto;
  END IF;
END$$;

-- If pgcrypto is currently installed in a different schema (typically
-- `public` on `postgres:16-alpine`), re-install it into the freshly
-- created `pgcrypto` schema. Otherwise just ensure it exists.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_extension
    WHERE extname = 'pgcrypto'
      AND extnamespace::regnamespace::text <> 'pgcrypto'
  ) THEN
    EXECUTE 'DROP EXTENSION pgcrypto';
    EXECUTE 'CREATE EXTENSION pgcrypto WITH SCHEMA pgcrypto';
  ELSIF NOT EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto'
  ) THEN
    EXECUTE 'CREATE EXTENSION pgcrypto WITH SCHEMA pgcrypto';
  END IF;
END$$;

GRANT USAGE ON SCHEMA pgcrypto TO PUBLIC;
-- USAGE on a schema lets a role *resolve* the names inside it, but does not
-- grant EXECUTE on its functions. Without EXECUTE, a low-privilege role
-- that has USAGE on pgcrypto still gets `function does not exist` when
-- calling `gen_random_bytes(...)`. Grant EXECUTE on the three functions
-- the rest of the schema depends on so future low-priv roles can use them.
GRANT EXECUTE ON FUNCTION pgcrypto.gen_random_bytes(integer) TO PUBLIC;
GRANT EXECUTE ON FUNCTION pgcrypto.gen_random_uuid() TO PUBLIC;
GRANT EXECUTE ON FUNCTION pgcrypto.digest(text, text) TO PUBLIC;

-- Add pgcrypto to the database default search_path so unqualified calls
-- like `gen_random_uuid()` resolve to the pgcrypto schema functions
-- instead of being silently invisible. Without this, a low-privilege
-- role that has USAGE+EXECUTE on pgcrypto still gets "function does
-- not exist" for unqualified calls. Prepending pgcrypto to the default
-- preserves `public` as the primary resolution schema so existing
-- tables / types are unaffected.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET search_path = public, pgcrypto', current_database());
END$$;
