/**
 * Error types that the HTTP layer knows how to turn into a response.
 *
 * The point of a small typed hierarchy is that a handler can only produce a 4xx
 * by accident if it throws one of these deliberately. Anything else that escapes
 * a handler is treated as an unexpected fault and answered with a 500 - which is
 * exactly what the test suite asserts never happens for bad caller input.
 */

export class AppError extends Error {
  /**
   * @param {number} status HTTP status code to send.
   * @param {string} code Stable machine-readable token, e.g. `validation_failed`.
   * @param {string} message Human-readable summary. Must not contain a raw
   *   newline or backtick, so it can be embedded in JSON and in SQL safely.
   * @param {object} [options]
   * @param {object} [options.details] Extra fields merged into the response body.
   * @param {Error} [options.cause] Underlying error, for logging only.
   */
  constructor(status, code, message, { details = {}, cause } = {}) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    this.details = details;
    this.isAppError = true;
    if (cause !== undefined) this.cause = cause;
  }

  /**
   * Identifies an error as deliberately produced by this service.
   *
   * A brand check rather than `instanceof`, so the test suite can drive the HTTP
   * layer with errors built in a different realm and still have them handled.
   *
   * @param {unknown} value
   * @returns {value is AppError}
   */
  static isAppError(value) {
    return (
      value instanceof AppError ||
      (typeof value === 'object' &&
        value !== null &&
        value.isAppError === true &&
        Number.isInteger(value.status) &&
        value.status >= 400 &&
        value.status <= 599)
    );
  }
}

/** 400 - the request is syntactically fine but the content is not acceptable. */
export class ValidationError extends AppError {
  constructor(message, details) {
    super(400, 'validation_failed', message, { details: { problems: details ?? [] } });
  }
}

/** 400 - the request body could not be parsed as the declared media type. */
export class MalformedJsonError extends AppError {
  constructor(message, details) {
    super(400, 'malformed_json', message, { details });
  }
}

/** 404 - the addressed bookmark does not exist for this caller. */
export class NotFoundError extends AppError {
  constructor(message, details) {
    super(404, 'not_found', message, { details });
  }
}

/** 409 - the request is well-formed but conflicts with the current state. */
export class ConflictError extends AppError {
  constructor(message, details) {
    super(409, 'conflict', message, { details });
  }
}

/** 413 - the request is well-formed but too large or the owner is at capacity. */
export class PayloadTooLargeError extends AppError {
  constructor(message, details) {
    super(413, 'payload_too_large', message, { details });
  }
}
