/**
 * Single source of truth for the structured-log contract.
 *
 * `CONTRACT_FIELDS` is the list of keys every pino log line carries (under
 * `customProps` in `log.ts`). Adding a new contract field is a typed edit
 * here — `LogContext` in `log.ts` mirrors this tuple so handlers, middleware,
 * and tests all reference the same list.
 *
 * `REDACT_PATHS` is the exact-key pino redact list. Pino walks ONLY these
 * paths; deeper occurrences of the same key in unrelated objects are NOT
 * redacted, so a new sensitive field requires a code edit + a test asserting
 * the new path is present.
 *
 * The 4 contract fields and 7 redaction paths are the public contract;
 * downstream stories import the tuples by name, never re-declare them.
 */
export const CONTRACT_FIELDS = [
  'request_id',
  'actor_role',
  'actor_id',
  'appointment_id',
] as const;

export type ContractField = (typeof CONTRACT_FIELDS)[number];

/**
 * Pino redact paths. Typed as `readonly string[]` (not a narrow literal
 * tuple) so downstream `.includes(string)` calls compile against an open
 * string type — keeping `log.test.ts`'s `redactPaths.includes(p)` happy
 * where `p: string`.
 *
 * The 7 paths are still the public contract; changing this list is an
 * explicit code edit + a test addition.
 */
export const REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.body.password',
  'req.body.phone_number',
  'req.body.code',
  'req.headers["x-auth-claim"]',
  'res.headers["set-cookie"]',
];

export type RedactPath = (typeof REDACT_PATHS)[number];
