/**
 * Error boundary.
 *
 * The single place that turns a thrown value into a status code. Because
 * everything a handler can deliberately reject with is an `AppError`, and
 * because this function has a total fallback, there is no input for which the
 * service can fail to produce a response - which is what "no input produces a
 * 500" means in practice.
 */

import { AppError } from './errors.js';

/**
 * Builds the single Express error-handling middleware.
 *
 * Express identifies error middleware by arity, so all four parameters must
 * stay declared even though the first three are unused by the logic. Marking
 * them as intentionally-unused keeps a linter from removing them, which would
 * silently turn this into ordinary middleware and break error handling.
 *
 * @returns {import('express').ErrorRequestHandler}
 */
export function createErrorHandler({ logger = console } = {}) {
  // eslint-disable-next-line no-unused-vars
  return function errorHandler(error, req, res, next) {
    const appError = AppError.isAppError(error) ? error : null;
    const status = appError?.status ?? 500;

    // 5xx means the service is at fault, so the detail belongs in the log. 4xx
    // means the caller is at fault, so the response already told them
    // everything and logging it in full would only add noise.
    if (status >= 500) {
      logger.error(
        `[${req.method} ${req.path}] unhandled error: ${describe(error)}`,
      );
    }

    const code = appError?.code ?? 'internal_error';
    const message =
      status >= 500 ? 'The service failed to handle the request.' : appError.message;

    res.status(status).json({
      error: {
        code,
        message,
        ...errorBodyDetails(appError),
      },
    });
  };
}

/**
 * Extracts the caller-facing detail from an `AppError`.
 *
 * Validation errors carry `problems`, an array that names the offending field.
 * Other errors carry a flat context object, which is spread in so fields such as
 * `field` and `limit` stay machine-readable.
 */
function errorBodyDetails(appError) {
  if (!appError) return {};
  const { details = {} } = appError;
  const problems = Array.isArray(details.problems) ? details.problems : null;

  if (problems) return { problems, ...withoutProblems(details) };
  return { ...details };
}

function withoutProblems(details) {
  const { problems, ...rest } = details;
  return rest;
}

/**
 * Renders a thrown value for the log without ever throwing itself.
 *
 * A handler that throws something exotic - `Object.create(null)`, a Proxy whose
 * traps fail - would otherwise make the error handler throw, and the caller
 * would receive Express's default HTML error page instead of this service's
 * documented JSON shape. Anything reaching this function is already a 5xx, so
 * the fallback text costs nothing.
 *
 * @param {unknown} value
 * @returns {string}
 */
function describe(value) {
  if (typeof value === 'string') return value;
  const stack = value?.stack;
  if (typeof stack === 'string' && stack !== '') return stack;

  try {
    return String(value);
  } catch {
    // `Object.prototype.toString` works on objects that have no prototype and so
    // inherit no `toString` of their own.
    return Object.prototype.toString.call(value);
  }
}

/**
 * Terminal middleware for unmatched routes.
 *
 * Kept last so that an unknown path produces the same documented JSON error
 * shape as every other failure, including one that names the field it could not
 * match. Registered as `app.use`, not `app.all`, so it does not shadow the
 * routes above it.
 */
export function createNotFoundHandler() {
  return function notFound(req, res) {
    res.status(404).json({
      error: {
        code: 'route_not_found',
        message: 'No route matches the requested method and path.',
        method: req.method,
        path: req.path,
      },
    });
  };
}
