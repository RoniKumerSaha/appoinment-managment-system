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
 */
import type { Request, RequestHandler } from 'express';
import pino from 'pino';
import pinoHttp from 'pino-http';
import type { DestinationStream } from 'pino';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.body.password',
  'req.body.phone_number',
  'req.body.code',
  'req.headers["x-auth-claim"]',
  'res.headers["set-cookie"]',
];

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
      redact: { paths: redactPaths, censor: '[REDACTED]' },
      base: { service: 'clinic-api' },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    destination,
  );
}

const baseLogger = createBaseLogger();

export const logger = baseLogger;

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
      const ctx = (req as Request & { logCtx?: LogContext }).logCtx ?? {};
      const requestId =
        (req as IncomingMessage & { id?: unknown }).id ?? null;
      return {
        request_id: typeof requestId === 'string' ? requestId : null,
        actor_role: ctx.actor_role ?? null,
        actor_id: ctx.actor_id ?? null,
        appointment_id: ctx.appointment_id ?? null,
      };
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
