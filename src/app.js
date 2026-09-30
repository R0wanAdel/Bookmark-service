/**
 * Application assembly.
 *
 * `createApp` returns a configured Express app without binding a port, which is
 * what lets the tests drive it directly and lets the server start it for real.
 * The only Express behaviours in the chain are the ones with no built-in
 * equivalent: a JSON body parser, a raw-body size cap, the routes, and the error
 * boundary. Everything else is hand-written in `src/`, so the failure behaviour
 * is code we can read rather than framework behaviour we have to trust.
 */

import express from 'express';

import { MAX_BODY_BYTES } from './config.js';
import { MalformedJsonError, ValidationError } from './errors.js';
import { createErrorHandler, createNotFoundHandler } from './errors-middleware.js';
import { createBookmarkRouter } from './routes.js';
import { BookmarkStore } from './store.js';

/**
 * @param {object} [options]
 * @param {BookmarkStore} [options.store] Injectable store; an in-memory one is created otherwise.
 * @param {Console} [options.logger]
 * @param {string} [options.databaseFile] SQLite file path for the default store.
 * @returns {{ app: import('express').Express, store: BookmarkStore }}
 */
export function createApp({
  store,
  logger = console,
  databaseFile = ':memory:',
} = {}) {
  const resolvedStore = store ?? new BookmarkStore({ filename: databaseFile });
  const app = express();

  // `x-powered-by` advertises the framework and version to anyone probing the
  // service. Turning it off is free.
  app.disable('x-powered-by');

  // No CORS headers: this service is not designed for browser callers, and an
  // open policy on a state-changing API is a risk rather than a convenience.

  // The cap applies to the raw bytes, so an oversized request is refused on size
  // rather than after being fully materialised in memory.
  //
  // `strict: false` lets a bare JSON scalar parse. That is deliberate: a body of
  // `"hello"` then reaches `validateCreateBody`, which rejects it with a
  // field-scoped 400 naming `body`, instead of dying in the parser with a 400
  // that names nothing.
  app.use(express.json({ limit: MAX_BODY_BYTES, strict: false }));
  app.use(express.urlencoded({ extended: false, limit: MAX_BODY_BYTES }));

  // Body-parser failures arrive here before the routes run. Translating them
  // here means the error boundary only ever sees `AppError`, which is what keeps
  // it a four-line function instead of a pile of framework-specific cases.
  app.use((error, req, res, next) => {
    const translated = translateBodyParserError(error);
    next(translated ?? error);
  });

  /**
   * GET /health
   * 200 OK
   *
   * Deliberately free of any owner header, so a liveness probe needs no
   * credentials and cannot itself become a validation failure.
   */
  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.use('/bookmarks', createBookmarkRouter({ store: resolvedStore }));

  app.use(createNotFoundHandler());
  app.use(createErrorHandler({ logger }));

  return { app, store: resolvedStore };
}

/**
 * Maps a body-parser failure to an `AppError`, or returns null when the error is
 * something else entirely.
 *
 * @param {any} error
 * @returns {Error|null}
 */
function translateBodyParserError(error) {
  if (error?.type === 'entity.too.large') {
    const actual = Number.isInteger(error.length) ? error.length : null;
    return new ValidationError(
      actual === null
        ? `Field "body" must be at most ${MAX_BODY_BYTES} bytes.`
        : `Field "body" must be at most ${MAX_BODY_BYTES} bytes; received ${actual}.`,
      [
        {
          field: 'body',
          code: 'too_long',
          message: `Field "body" must be at most ${MAX_BODY_BYTES} bytes.`,
          limit: MAX_BODY_BYTES,
          ...(actual === null ? {} : { actual }),
        },
      ],
    );
  }

  if (error?.type === 'entity.parse.failed') {
    return new MalformedJsonError('Field "body" is not parseable JSON.', {
      field: 'body',
      reason: 'malformed_json',
    });
  }

  if (error?.type === 'encoding.unsupported' || error?.type === 'charset.unsupported') {
    return new ValidationError('Request validation failed: 1 problem.', [
      {
        field: 'content-type',
        code: 'unsupported',
        message: 'Field "Content-Type" uses an unsupported charset or encoding.',
      },
    ]);
  }

  return null;
}
