/**
 * Structured-log middleware.
 *
 * Contract fields every log line carries:
 *   request_id, actor_role, actor_id, appointment_id (when in scope)
 *
 * Redaction (exact-key): password, phone_number, code. These keys are removed
 * before pino serializes the log line; a value containing them in a deeper
 * path is a reviewer-blocker because pino redact only walks the exact paths
 * listed. We list the dotted paths the API surface actually emits today.
 *
 * The log middleware also exposes a tiny test-only endpoint behaviour: any
 * handler can call `req.log.info({ appointment_id, ... }, 'msg')` and the four
 * fields will be present in the JSON line.
 *
 * The 4 contract fields and 7 redaction paths live in `log-contract.ts` as
 * the single source of truth; this module imports them so callers (tests,
 * future handlers) reference the contract by import rather than by
 * re-declaring literals.
 */
import type { Request, RequestHandler } from 'express';
import pino from 'pino';
import pinoHttp from 'pino-http';
import type { DestinationStream } from 'pino';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { REDACT_PATHS, CONTRACT_FIELDS } from './log-contract.js';

/**
 * Re-export so the existing test (`log.test.ts`) can keep importing
 * `redactPaths` from this module — the contract module owns the canonical
 * array, this module owns the wire-up (pino redact config, genReqId,
 * customProps). Both consumers reference the same array reference.
 */
export { REDACT_PATHS as redactPaths } from './log-contract.js';
/**
 * Marker re-export so consumers (tests, future modules) can pull the typed
 * tuple directly from this module without learning a second path.
 */
export { CONTRACT_FIELDS } from './log-contract.js';

/**
 * Build the base pino logger. Production code calls this with no arguments;
 * tests pass an explicit `destination` so the emitted JSON line can be
 * captured without depending on stdout interception (which is unreliable on
 * Windows where SonicBoom writes via the fd-1 path directly).
 */
export function createBaseLogger(destination?: DestinationStream): pino.Logger {
  return pino(
    {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: { paths: [...REDACT_PATHS], censor: '[REDACTED]' },
      base: { service: 'clinic-api' },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    destination,
  );
}

const baseLogger = createBaseLogger();

/**
 * Module-level logger. Reads via `getLogger()` so tests can swap the
 * destination via `__redirectBaseLoggerForTests(stream)`. Direct exports
 * of `const logger` would freeze the binding at module-load time and the
 * swap would not propagate to consumers.
 */
let activeLogger: pino.Logger = baseLogger;

export function getLogger(): pino.Logger {
  return activeLogger;
}

/**
 * Test-only: swap the module-level logger's destination. The route handlers
 * (`patient-otp.ts`, etc.) read via `getLogger()` so this swap propagates.
 * Pass `undefined` to restore the original stdout-bound logger.
 *
 * Production code never calls this.
 */
export function __redirectBaseLoggerForTests(
  stream?: DestinationStream,
): void {
  activeLogger = stream === undefined ? baseLogger : createBaseLogger(stream);
}

/**
 * Build a `pinoHttp()` middleware honouring the production contract:
 *   - request_id from x-request-id (with charset/length guard)
 *   - actor_role / actor_id / appointment_id from req.logCtx via attachLogContext
 *
 * Production code calls this with no args. Tests pass an explicit `logger`
 * to redirect emission to a captured destination without changing any other
 * behaviour.
 */
export function createRequestLogger(opts: { logger?: pino.Logger } = {}): RequestHandler {
  return pinoHttp({
    logger: opts.logger ?? baseLogger,
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    // Attach request_id on every line so structured-log contract holds even
    // before any handler logs explicitly. Incoming x-request-id is validated
    // against a strict charset+length cap so a malicious caller cannot inject
    // CRLF into the response header or pollute log lines.
    genReqId: (req: IncomingMessage, res: ServerResponse) => {
      const incoming = (req.headers['x-request-id'] as string | undefined) ?? '';
      const id = isValidRequestId(incoming) ? incoming : cryptoRandom();
      res.setHeader('x-request-id', id);
      return id;
    },
    customProps: (req: IncomingMessage) => {
      // request_id surfaces at the top level (not nested in req.id) so log
      // consumers can rely on a flat shape. actor_role / actor_id /
      // appointment_id populate when the handler sets them on the request via
      // attachLogContext(); the fields are always present in the JSON
      // envelope (null when unset) so log consumers can rely on shape.
      //
      // The four keys emitted here are derived from `CONTRACT_FIELDS` in
      // `log-contract.ts`, NOT from inline literals: `CONTRACT_FIELDS[0]`
      // is always `request_id`, and `[1]..[3]` are `actor_role`,
      // `actor_id`, `appointment_id` respectively. A small mapping fixes
      // each contract field to its source (req.id for request_id, ctx for
      // the rest) so the wire shape stays identical while the key NAMES
      // remain the single source of truth.
      const ctx = (req as Request & { logCtx?: LogContext }).logCtx ?? {};
      const requestId =
        (req as IncomingMessage & { id?: unknown }).id ?? null;
      const sources: Record<(typeof CONTRACT_FIELDS)[number], unknown> = {
        [CONTRACT_FIELDS[0]]:
          typeof requestId === 'string' ? requestId : null,
        [CONTRACT_FIELDS[1]]: ctx.actor_role ?? null,
        [CONTRACT_FIELDS[2]]: ctx.actor_id ?? null,
        [CONTRACT_FIELDS[3]]: ctx.appointment_id ?? null,
      };
      return sources;
    },
  }) as unknown as RequestHandler;
}

export const requestLogger = createRequestLogger();

export interface LogContext {
  actor_role?: string | null;
  actor_id?: string | null;
  appointment_id?: string | null;
}

/**
 * Attach mutable log context to a request so subsequent logs in the same
 * request carry the same actor_role / actor_id / appointment_id values.
 * Auth middleware calls this once the claim is parsed.
 */
export function attachLogContext(
  req: Request,
  ctx: Partial<LogContext>,
): void {
  const r = req as Request & { logCtx?: LogContext };
  r.logCtx = { ...(r.logCtx ?? {}), ...ctx };
}

function cryptoRandom(): string {
  // Node 20 has globalThis.crypto.randomUUID.
  return globalThis.crypto.randomUUID();
}

/**
 * Strict charset+length cap for caller-supplied x-request-id. Anything else
 * (CRLF, whitespace, non-ASCII, oversize) is replaced with a fresh UUID so it
 * cannot be used to inject response-header bytes or log-line escapes.
 */
function isValidRequestId(value: string): boolean {
  return /^[A-Za-z0-9-]{1,128}$/.test(value);
}
