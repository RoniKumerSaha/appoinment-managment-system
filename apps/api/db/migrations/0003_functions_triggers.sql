-- E0-S2: 0003 — shared functions and triggers.
--
-- app_now(): returns current timestamptz in UTC. We use `SELECT now()` directly
-- because `now()` already returns timestamptz in UTC (Postgres stores it as
-- UTC internally and renders it in the session's timezone). The earlier draft
-- `now() AT TIME ZONE 'UTC'` was wrong: that expression returns
-- `timestamp without time zone`, and storing it back in a `timestamptz`
-- column would re-interpret the value as session-local time.
--
-- STABLE (not IMMUTABLE) because `now()` is volatile within a transaction —
-- which is exactly what we want for column defaults (statement-time value).
--
-- set_updated_at(): BEFORE UPDATE trigger function. Sets NEW.updated_at to
-- app_now(). Returns NEW explicitly so the UPDATE is not silently dropped.

CREATE OR REPLACE FUNCTION app_now() RETURNS timestamptz
  LANGUAGE sql
  STABLE
AS $$
  SELECT now();
$$;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := app_now();
  RETURN NEW;
END;
$$;
