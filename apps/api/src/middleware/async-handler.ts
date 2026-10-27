/**
 * Async route-handler rejection forwarding.
 *
 * Express 4 does not await route handlers. A handler that `throw`s after
 * an `await` produces a rejected promise that Express never sees — it
 * escapes to `process.on('unhandledRejection')`, which in this codebase
 * calls `process.exit(1)`. The result is that one failed request
 * terminates the whole API.
 *
 * `wrapAsyncHandler` forwards a rejection to `next(err)` so the app's
 * error middleware answers 500 for that request alone.
 *
 * `wrapRouter` applies the wrapper to every handler registered on a
 * router. Express exposes the handler list on `router.stack` as
 * `layer.route.stack`, each entry carrying a `handle` function; the
 * wrapper replaces `handle` in place, so route paths, methods and
 * middleware ordering are untouched.
 */
import type { NextFunction, Request, RequestHandler, Response, Router } from 'express';

/** Marker set on a wrapped handler so `wrapRouter` can skip it. */
const WRAPPED = Symbol.for('clinic.async_handler_wrapped');

type MarkedHandler = RequestHandler & { [WRAPPED]?: true };

/** Wrap a single handler so a rejected promise is forwarded to `next`. */
export function wrapAsyncHandler(handler: RequestHandler): RequestHandler {
  const wrapped: MarkedHandler = (req: Request, res: Response, next: NextFunction): void => {
    try {
      // Express 4 types `RequestHandler` as returning `void`, but async
      // handlers actually return a promise — the runtime value is what
      // matters here, so the cast is deliberate.
      const result: unknown = (handler as unknown as (
        ...args: [Request, Response, NextFunction]
      ) => unknown)(req, res, next);
      if (result instanceof Promise) {
        result.catch(next);
      }
    } catch (err) {
      next(err);
    }
  };
  wrapped[WRAPPED] = true;
  return wrapped;
}

/**
 * Re-wrap every handler registered on `router` so async rejections reach
 * the error middleware. Idempotent — an already-wrapped handler is
 * detected and left alone, so calling this twice is harmless.
 */
export function wrapRouter(router: Router): Router {
  for (const layer of router.stack) {
    const route = (
      layer as unknown as {
        route?: { stack: { handle: RequestHandler }[] };
      }
    ).route;
    if (!route) continue;
    for (const entry of route.stack) {
      const handle = entry.handle as MarkedHandler;
      if (handle[WRAPPED] !== true) {
        entry.handle = wrapAsyncHandler(handle);
      }
    }
  }
  return router;
}
