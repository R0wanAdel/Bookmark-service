/**
 * HTTP routes for bookmarks.
 *
 * Every handler follows the same shape: validate, act, respond. Handlers contain
 * no conditionals that decide a status code from an unexpected value - every
 * rejection they can produce is an `AppError` thrown by validation or storage,
 * which the error boundary turns into a documented response. That is why "no
 * input produces a 500" holds by construction rather than by testing luck.
 */

import express from 'express';

import { ConflictError, NotFoundError } from './errors.js';
import {
  validateBookmarkId,
  validateCreateBody,
  validateListQuery,
  validateOwnerId,
} from './validation.js';

/**
 * Wraps a synchronous handler so a thrown `AppError` reaches the error boundary.
 *
 * Handlers here are synchronous because SQLite access through `node:sqlite` is
 * synchronous. The wrapper is still worth having: it documents the contract, and
 * it means a handler can be made async later without anyone having to remember
 * to add a `catch`.
 *
 * @param {(req: import('express').Request, res: import('express').Response) => void} handler
 */
function route(handler) {
  return (req, res, next) => {
    try {
      handler(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}

/**
 * @param {{ store: import('./store.js').BookmarkStore }} deps
 * @returns {import('express').Router}
 */
export function createBookmarkRouter({ store }) {
  const router = express.Router();

  /**
   * POST /bookmarks
   * 201 Created | 409 Conflict | 400 Bad Request
   *
   * A repeated create is answered 409, never 201 and never 200. Returning 200
   * would tell the caller their bookmark was created when nothing was written;
   * 409 names the conflict, points at the `url` field, and carries the id the
   * caller already holds so a retry can converge on the existing row.
   */
  router.post(
    '/',
    route((req, res) => {
      const ownerId = validateOwnerId(req.headers);
      const { url, title } = validateCreateBody(req.body);

      const { bookmark, created } = store.create({ ownerId, url, title });

      if (!created) {
        throw new ConflictError('You have already bookmarked this URL.', {
          field: 'url',
          existingId: bookmark.id,
          existing: bookmark,
        });
      }

      res
        .status(201)
        .location(`/bookmarks/${encodeURIComponent(bookmark.id)}`)
        .json({ bookmark });
    }),
  );

  /**
   * GET /bookmarks
   * 200 OK | 400 Bad Request
   */
  router.get(
    '/',
    route((req, res) => {
      const ownerId = validateOwnerId(req.headers);
      const { limit, offset } = validateListQuery(req.query);

      const page = store.listByOwner(ownerId, { limit, offset });

      res.status(200).json({
        bookmarks: page.items,
        pagination: {
          limit: page.limit,
          offset: page.offset,
          total: page.total,
          count: page.items.length,
          maxPerOwner: store.maxPerOwner,
        },
      });    }),
  );

  /**
   * GET /bookmarks/:id
   * 200 OK | 400 Bad Request | 404 Not Found
   */
  router.get(
    '/:id',
    route((req, res) => {
      const ownerId = validateOwnerId(req.headers);
      const id = validateBookmarkId(req.params.id);

      const bookmark = store.findById(ownerId, id);
      if (bookmark === null) {
        throw new NotFoundError(
          'No bookmark with that id exists for this owner.',
          { field: 'id', id },
        );
      }

      res.status(200).json({ bookmark });
    }),
  );

  /**
   * DELETE /bookmarks/:id
   * 204 No Content | 400 Bad Request | 404 Not Found
   */
  router.delete(
    '/:id',
    route((req, res) => {
      const ownerId = validateOwnerId(req.headers);
      const id = validateBookmarkId(req.params.id);

      if (!store.deleteById(ownerId, id)) {
        throw new NotFoundError(
          'No bookmark with that id exists for this owner.',
          { field: 'id', id },
        );
      }

      res.status(204).end();
    }),
  );

  return router;
}
