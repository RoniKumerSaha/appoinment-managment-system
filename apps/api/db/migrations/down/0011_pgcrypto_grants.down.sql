-- E0-S3: 0011 down — revoke pgcrypto grants, drop the extension and schema.
--
-- The forward migration may have re-located pgcrypto from `public` into a
-- dedicated `pgcrypto` schema. The down migration reverses that by
-- re-locating it back to `public` (the default on the testcontainer
-- image) and dropping the now-empty `pgcrypto` schema.

REVOKE EXECUTE ON FUNCTION pgcrypto.gen_random_bytes(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pgcrypto.gen_random_uuid() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pgcrypto.digest(text, text) FROM PUBLIC;
REVOKE USAGE ON SCHEMA pgcrypto FROM PUBLIC;

-- If pgcrypto is currently installed in the `pgcrypto` schema, re-locate
-- it back to `public` (the original location on `postgres:16-alpine`).
-- Without this, dropping the `pgcrypto` schema below would fail because
-- pgcrypto owns objects inside it.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_extension
    WHERE extname = 'pgcrypto'
      AND extnamespace::regnamespace::text = 'pgcrypto'
  ) THEN
    EXECUTE 'DROP EXTENSION pgcrypto';
    EXECUTE 'CREATE EXTENSION pgcrypto';
  END IF;
END$$;

DROP SCHEMA IF EXISTS pgcrypto;
