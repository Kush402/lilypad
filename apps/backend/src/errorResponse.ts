/**
 * What an unhandled exception is allowed to tell a stranger.
 *
 * Fastify's default error handler puts `err.message` straight into the
 * response body. Proved against the version this repo pins:
 *
 * ```
 * status 500
 * {"statusCode":500,"error":"Internal Server Error",
 *  "message":"relation \"devices_secret\" does not exist at /repo/apps/backend/dist/db/client.js:42"}
 * ```
 *
 * No `setErrorHandler` was registered, so that was this API's behaviour on
 * every route: a Postgres error hands out table and constraint names, a driver
 * error hands out the container's filesystem layout, and a library error hands
 * out its internals — to anyone, unauthenticated, over the internet. It is the
 * same class as the raw `(HTTP 429): {"statusCode":429,…}` that reached the
 * desktop's linking screen (L-34), one layer lower down: there the client was
 * rendering what the server said, here the server should not have said it.
 *
 * The rule below is deliberately narrow, because most 4xx bodies in this API
 * are authored rather than incidental — `reply.code(400).send({error: …})`
 * never reaches an error handler at all, and the ones that DO arrive here with
 * a status under 500 are Fastify's own schema validation and the rate
 * limiter's 429, both of which say something a caller can act on.
 *
 * A 5xx says nothing except an id. That id is the point: it is the request id
 * already in every log line, so a person who reports "it said something went
 * wrong, the id was req-4f" can be answered from the logs without guessing.
 */

export interface SafeErrorResponse {
  status: number;
  body: Record<string, unknown>;
  /** Whether the original error should be logged at error level. Client
   * mistakes are already counted by `observeResponse`; logging every 400 as an
   * error is how a log stops being read. */
  logAsServerError: boolean;
}

interface ErrorLike {
  statusCode?: unknown;
  code?: unknown;
  message?: unknown;
  validation?: unknown;
}

export function safeErrorResponse(err: unknown, requestId: string): SafeErrorResponse {
  const e = (err ?? {}) as ErrorLike;
  const status = typeof e.statusCode === 'number' ? e.statusCode : 500;

  if (status >= 400 && status < 500) {
    // Authored, and useful: `FST_ERR_VALIDATION` names the field, the rate
    // limiter names the window. Passed through unchanged so nothing that
    // already works starts answering differently.
    return {
      status,
      body: {
        error: typeof e.code === 'string' ? e.code : 'bad_request',
        message: typeof e.message === 'string' ? e.message : 'The request could not be processed.',
      },
      logAsServerError: false,
    };
  }

  return {
    status: status >= 500 && status <= 599 ? status : 500,
    body: {
      error: 'internal_error',
      message: 'Something went wrong on our end. Try again in a moment.',
      requestId,
    },
    logAsServerError: true,
  };
}
