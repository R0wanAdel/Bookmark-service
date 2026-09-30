/**
 * Request validation.
 *
 * Every function here is total: for any input whatsoever it either returns a
 * normalised value or returns/throws a `ValidationError` whose problems each
 * name the offending field. Nothing in this module can throw a non-`AppError`
 * exception, which is what makes "bad input returns 400, never 500" a structural
 * property of the service rather than a hope. `test/no-500.test.js` fuzzes that
 * claim across every endpoint.
 *
 * Messages are constrained to a single line with control characters removed,
 * because they are also written verbatim into SQL statements (as bound values)
 * and into the response body.
 */

import {
  MAX_BODY_BYTES,
  MAX_ID_LENGTH,
  MAX_TITLE_LENGTH,
  MAX_URL_LENGTH,
} from './config.js';
import { ValidationError } from './errors.js';

/** Matches an explicit http/https scheme delimiter. */
const SCHEME_PATTERN = /^(https?):\/\//i;

/** Non-global so `.test()` carries no `lastIndex` state between calls. */
const HAS_CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/** Global form, used only with `String.prototype.replace`. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

/** Owner ids and bookmark ids share a shape: opaque, bounded, URL-safe. */
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]+$/;

/** An owner id longer than this is refused before any storage lookup. */
const MAX_OWNER_ID_LENGTH = 128;

/**
 * Builds one field-scoped problem.
 *
 * @param {string} field Name of the request field at fault. Always appears in
 *   the message so a caller never has to guess which field was rejected.
 * @param {string} code Stable machine-readable token for this specific fault.
 * @param {string} detail Sentence appended after the field name.
 * @param {object} [extra] Additional context (limit, actual, expected).
 */
function problem(field, code, detail, extra = {}) {
  return {
    field,
    code,
    message: `Field "${field}" ${detail}`,
    ...extra,
  };
}

/** Renders a JS value's type for use in an error message. */
function describeType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** Collapses to a single line so a message is safe to embed in JSON and SQL. */
function oneLine(text) {
  return String(text).replace(CONTROL_CHARACTERS, ' ').trim();
}

/** Bounds an echoed value so an error body cannot be used to flood the caller. */
function truncate(text, max = 120) {
  const flat = oneLine(text);
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

/** Builds the top-level message for a problem list. */
function summary(problems) {
  return problems.length === 1
    ? 'Request validation failed: 1 problem.'
    : `Request validation failed: ${problems.length} problems.`;
}

/**
 * Collects the structural faults in a string field.
 *
 * Returns a problem array rather than throwing so a caller can accumulate every
 * fault in one response instead of fixing them one round-trip at a time.
 *
 * @param {unknown} value
 * @param {object} options
 * @param {string} options.field Field name to report under.
 * @param {number} options.max Maximum accepted length.
 * @param {boolean} [options.required] When false, undefined and null are not faults.
 * @returns {Array<object>} Zero or more field-scoped problems.
 */
function stringProblems(value, { field, max, required = true }) {
  if (value === undefined || value === null) {
    return required
      ? [problem(field, 'required', 'is required but was missing or null.')]
      : [];
  }

  const type = describeType(value);
  if (type !== 'string') {
    return [
      problem(field, 'wrong_type', `must be a string, received ${type}.`, {
        expected: 'string',
        actual: type,
      }),
    ];
  }

  if (value.trim() === '') {
    return [problem(field, 'empty', 'must be a non-empty string.')];
  }

  if (value.length > max) {
    return [
      problem(
        field,
        'too_long',
        `must be at most ${max} characters; received ${value.length}.`,
        { limit: max, actual: value.length },
      ),
    ];
  }

  if (HAS_CONTROL_CHARACTER.test(value)) {
    return [problem(field, 'invalid_characters', 'must not contain control characters.')];
  }

  return [];
}

/** Collects `url` faults. @returns {Array<object>} */
function urlProblems(value) {
  const structural = stringProblems(value, { field: 'url', max: MAX_URL_LENGTH });
  if (structural.length > 0) return structural;

  const url = value.trim();

  if (!SCHEME_PATTERN.test(url)) {
    return [
      problem('url', 'invalid_scheme', 'must be an absolute http:// or https:// URL.', {
        expected: 'http:// or https://',
      }),
    ];
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return [
      problem('url', 'invalid_format', 'is not a parseable URL.', {
        received: truncate(url),
      }),
    ];
  }

  if (parsed.hostname === '') {
    return [problem('url', 'missing_host', 'must include a host.', { received: truncate(url) })];
  }

  // Storing credentials would leak them into every later read and list.
  if (parsed.username !== '' || parsed.password !== '') {
    return [problem('url', 'contains_credentials', 'must not embed a username or password.')];
  }

  return [];
}

/** Collects `title` faults. A missing title is fine; an empty one is not. */
function titleProblems(value) {
  return stringProblems(value, { field: 'title', max: MAX_TITLE_LENGTH, required: false });
}

/**
 * Validates an opaque identifier used in a path or header.
 *
 * @returns {string}
 * @throws {ValidationError}
 */
function validateIdentifier(value, field, max = MAX_ID_LENGTH) {
  const problems = stringProblems(value, { field, max });
  if (problems.length > 0) throw new ValidationError(summary(problems), problems);

  const id = value.trim();
  if (!IDENTIFIER_PATTERN.test(id)) {
    return throwIdentifierShape(field, id);
  }
  return id;
}

/** @returns {never} */
function throwIdentifierShape(field, id) {
  throw new ValidationError('Request validation failed: 1 problem.', [
    problem(field, 'invalid_characters', 'may only contain letters, digits, hyphen and underscore.', {
      received: truncate(id),
    }),
  ]);
}

/**
 * Parses one query parameter as a bounded integer, accumulating a problem rather
 * than throwing so `limit` and `offset` are reported together.
 *
 * `?limit=` (present but empty) is treated as absent, which is the forgiving
 * reading of a browser submitting an untouched form control. `?limit=abc` or
 * `?limit=1.5` is a genuine fault and is reported.
 */
function readBoundedInteger(raw, field, min, max, fallback, problems) {
  if (raw === undefined || raw === null) return fallback;
  if (Array.isArray(raw)) {
    problems.push(problem(field, 'repeated', 'must be supplied at most once.'));
    return fallback;
  }
  const text = String(raw).trim();
  if (text === '') return fallback;

  if (!/^[+-]?\d+$/.test(text)) {
    problems.push(
      problem(field, 'wrong_type', 'must be a base-10 integer.', { received: truncate(text) }),
    );
    return fallback;
  }

  const value = Number.parseInt(text, 10);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    problems.push(
      problem(field, 'out_of_range', `must be between ${min} and ${max}; received ${value}.`, {
        min,
        max,
        actual: value,
      }),
    );
    return fallback;
  }
  return value;
}

/**
 * @param {object} query Parsed query parameters.
 * @returns {{ limit: number, offset: number }}
 * @throws {ValidationError}
 */
export function validateListQuery(query = {}) {
  const problems = [];
  const limit = readBoundedInteger(query.limit, 'limit', 1, 100, 50, problems);
  const offset = readBoundedInteger(query.offset, 'offset', 0, 100_000, 0, problems);
  if (problems.length > 0) throw new ValidationError(summary(problems), problems);
  return { limit, offset };
}

/**
 * Resolves the owning caller.
 *
 * This service has no authentication, so ownership is a declared header. It is
 * still validated to the same standard as every other input: an unauthenticated
 * deployment must not be able to reach a 500 with a pathological header.
 *
 * @param {object} headers Lower-cased request headers.
 * @returns {string}
 * @throws {ValidationError}
 */
export function validateOwnerId(headers) {
  const raw = headers['x-owner-id'];
  if (Array.isArray(raw)) {
    throw new ValidationError('Request validation failed: 1 problem.', [
      problem('x-owner-id', 'repeated', 'must be sent exactly once.'),
    ]);
  }
  return validateIdentifier(raw, 'x-owner-id', MAX_OWNER_ID_LENGTH);
}

/**
 * Validates the `id` path segment.
 *
 * @returns {string}
 * @throws {ValidationError}
 */
export function validateBookmarkId(value) {
  return validateIdentifier(value, 'id', MAX_ID_LENGTH);
}

/**
 * Validates a decoded request body.
 *
 * Every problem is collected before throwing, so a caller sending both an empty
 * `url` and an oversized `title` gets one response naming both.
 *
 * Returns the caller's URL as sent, minus surrounding whitespace. Normalisation
 * for duplicate detection is deliberately not done here: `normalizeUrl` is the
 * single place that decision lives, and having validation compute a second,
 * possibly divergent, form of it is how the two drift apart.
 *
 * @param {unknown} body
 * @returns {{ url: string, title: string|null }}
 * @throws {ValidationError}
 */
export function validateCreateBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('Request validation failed: 1 problem.', [
      problem(
        'body',
        'wrong_type',
        `must be a JSON object, received ${describeType(body)}.`,
        { expected: 'object' },
      ),
    ]);
  }

  const problems = urlProblems(body.url).concat(titleProblems(body.title));
  if (problems.length > 0) throw new ValidationError(summary(problems), problems);

  return {
    url: body.url.trim(),
    title: body.title === undefined || body.title === null ? null : body.title.trim(),
  };
}
