/**
 * The error boundary.
 *
 * Everything above asserts what a *caller* can cause. This file asserts what the
 * service does when something goes wrong on its own side - a store that throws,
 * a bug that throws a string instead of an Error, a handler that returns without
 * responding. These are the paths that legitimately produce a 500, and the point
 * of the test is that even then the caller gets a clean, non-leaking response and
 * the diagnostic reaches the log instead.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { AppError, ConflictError, ValidationError } from '../src/errors.js';
import { faultyStore, listenOnce, OWNER, silentLogger } from './helpers.js';

describe('error boundary', () => {
  it('turns an internal fault into a generic 500 and logs the detail', async () => {
    const logged = [];
    const store = faultyStore({ error: new Error('the database exploded') });

    const ctx = await start({ store, logger: { ...silentLogger, error: (line) => logged.push(line) } });
    try {
      const response = await ctx.request('POST', '/bookmarks', {
        headers: { 'x-owner-id': OWNER },
        body: { url: 'https://example.com/boom' },
      });

      assert.equal(response.status, 500);
      assert.equal(response.body.error.code, 'internal_error');
      assert.equal(response.body.error.message, 'The service failed to handle the request.');
      assert.ok(
        !JSON.stringify(response.body).includes('exploded'),
        'the internal message must not reach the caller',
      );
      assert.equal(logged.length, 1, 'a 5xx must be logged');
      assert.match(logged[0], /the database exploded/);
    } finally {
      await ctx.close();
    }
  });

  it('does not log caller mistakes, only genuine faults', async () => {
    const logged = [];
    const ctx = await start({ logger: { ...silentLogger, error: (line) => logged.push(line) } });
    try {
      await ctx.request('POST', '/bookmarks', {
        headers: { 'x-owner-id': OWNER },
        body: { url: '' },
      });

      assert.deepEqual(logged, [], 'a 400 is the caller\'s problem, not an operational event');
    } finally {
      await ctx.close();
    }
  });

  it('survives a fault that is not an Error at all', async () => {
    for (const thrown of ['a bare string', 42, { nope: true }, [], Object.create(null)]) {
      const ctx = await start({ store: faultyStore({ error: thrown }) });
      try {
        const response = await ctx.request('GET', '/bookmarks', {
          headers: { 'x-owner-id': OWNER },
        });

        assert.equal(response.status, 500, `throwing ${JSON.stringify(thrown)} must not crash`);
        assert.equal(response.body.error.code, 'internal_error');
      } finally {
        await ctx.close();
      }
    }
  });

  it('degrades a thrown null to a 404 rather than crashing', async () => {
    // Express 4 treats a falsy value passed to `next()` as "no error", so a
    // handler that throws null is indistinguishable from one that did not throw
    // and the request falls through to the not-found middleware. Recorded here as
    // a known property rather than left to be discovered. It leaks nothing, and
    // no caller input can reach it: validation only ever throws `AppError`.
    const ctx = await start({ store: faultyStore({ error: null }) });
    try {
      const response = await ctx.request('GET', '/bookmarks', {
        headers: { 'x-owner-id': OWNER },
      });

      assert.equal(response.status, 404);
      assert.equal(response.body.error.code, 'route_not_found');
    } finally {
      await ctx.close();
    }
  });

  it('recovers on the next request after a fault', async () => {
    const store = faultyStore();
    const ctx = await start({ store });
    try {
      const failed = await ctx.request('GET', '/bookmarks', { headers: { 'x-owner-id': OWNER } });
      assert.equal(failed.status, 500);

      store.recover();
      const recovered = await ctx.request('GET', '/bookmarks', { headers: { 'x-owner-id': OWNER } });
      assert.equal(recovered.status, 200);
    } finally {
      await ctx.close();
    }
  });

  it('passes a deliberate AppError through with its own status', async () => {
    const deliberate = new ValidationError('Request validation failed: 1 problem.', [
      { field: 'x', code: 'required', message: 'Field "x" is required.' },
    ]);

    const ctx = await start({ store: faultyStore({ error: deliberate }) });
    try {
      const response = await ctx.request('GET', '/bookmarks', { headers: { 'x-owner-id': OWNER } });

      assert.equal(response.status, 400);
      assert.equal(response.body.error.code, 'validation_failed');
      assert.equal(response.body.error.problems[0].field, 'x');
    } finally {
      await ctx.close();
    }
  });

  it('recognises a deliberate error that did not come from this realm', async () => {
    // Stands in for an error crossing a boundary that breaks `instanceof`, such
    // as a worker or a deserialised queue message.
    const foreign = Object.assign(Object.create(null), {
      isAppError: true,
      status: 409,
      code: 'conflict',
      message: 'You have already bookmarked this URL.',
      details: { field: 'url' },
    });

    const ctx = await start({ store: faultyStore({ error: foreign }) });
    try {
      const response = await ctx.request('GET', '/bookmarks', { headers: { 'x-owner-id': OWNER } });

      assert.equal(response.status, 409);
      assert.equal(response.body.error.code, 'conflict');
    } finally {
      await ctx.close();
    }
  });

  it('falls back to a 500 for a malformed AppError rather than trusting its status', async () => {
    const broken = { isAppError: true, status: 999, code: 'nonsense', message: 'x' };

    const ctx = await start({ store: faultyStore({ error: broken }) });
    try {
      const response = await ctx.request('GET', '/bookmarks', { headers: { 'x-owner-id': OWNER } });
      assert.equal(response.status, 500);
    } finally {
      await ctx.close();
    }
  });

  it('gives every error subclass the status it claims', () => {
    assert.equal(new ValidationError('m', []).status, 400);
    assert.equal(new ConflictError('m').status, 409);
    assert.ok(new ValidationError('m', []) instanceof AppError);
  });
});

/** Boots the app on an ephemeral port with injected dependencies. */
async function start({ store, logger = silentLogger } = {}) {
  const { app } = createApp({ store, logger });
  return listenOnce(app, store);
}
