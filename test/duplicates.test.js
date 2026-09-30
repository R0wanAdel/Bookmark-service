/**
 * Duplicate detection.
 *
 * The guarantee under test: the same create request, sent twice, leaves one row.
 * Most of this file is about *which* pairs of URLs count as the same bookmark,
 * because that is a decision someone has to make deliberately rather than inherit
 * from string comparison.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { normalizeUrl } from '../src/normalize-url.js';
import { BookmarkStore } from '../src/store.js';
import { OWNER, startTestServer, tempDirectory } from './helpers.js';

describe('duplicate detection', () => {
  describe('over HTTP', () => {
    let ctx;

    before(async () => {
      ctx = await startTestServer();
    });

    after(async () => {
      await ctx.close();
    });

    it('leaves one row when the identical request is sent twice', async () => {
      const body = { url: 'https://example.com/exact-repeat', title: 'first' };

      const first = await ctx.as(OWNER, 'POST', '/bookmarks', { body });
      assert.equal(first.status, 201);
      assert.equal(ctx.store.countAll(), 1);

      const second = await ctx.as(OWNER, 'POST', '/bookmarks', { body });
      assert.equal(second.status, 409);
      assert.equal(second.body.error.code, 'conflict');
      assert.equal(second.body.error.field, 'url');
      assert.equal(ctx.store.countAll(), 1, 'the second request must not add a row');
    });

    it('names the existing row in the 409 so a retry can converge', async () => {
      const first = await ctx.as(OWNER, 'POST', '/bookmarks', {
        body: { url: 'https://example.com/idempotent' },
      });
      const second = await ctx.as(OWNER, 'POST', '/bookmarks', {
        body: { url: 'https://example.com/idempotent' },
      });

      assert.equal(second.status, 409);
      assert.equal(second.body.error.existingId, first.body.bookmark.id);
      assert.equal(second.body.error.existing.url, first.body.bookmark.url);
    });

    it('sends the repeat as 409, not as a misleading 200', async () => {
      const body = { url: 'https://example.com/not-200' };
      await ctx.as(OWNER, 'POST', '/bookmarks', { body });

      const repeat = await ctx.as(OWNER, 'POST', '/bookmarks', { body });
      // A 200 here would claim the write happened. It did not.
      assert.notEqual(repeat.status, 200);
      assert.notEqual(repeat.status, 201);
      assert.equal(repeat.status, 409);
      assert.equal(repeat.body.bookmark, undefined, 'a 409 must not carry a bookmark body');
    });

    it('treats a differing title as the same bookmark, not a new one', async () => {
      const rowsBefore = ctx.store.countAll();
      const first = await ctx.as(OWNER, 'POST', '/bookmarks', {
        body: { url: 'https://example.com/retitle', title: 'typo' },
      });
      const second = await ctx.as(OWNER, 'POST', '/bookmarks', {
        body: { url: 'https://example.com/retitle', title: 'corrected' },
      });

      assert.equal(first.status, 201);
      assert.equal(second.status, 409);
      assert.equal(ctx.store.countAll(), rowsBefore + 1, 'only the first request may add a row');
    });

    it('does not conflate two different owners', async () => {
      const body = { url: 'https://example.com/shared' };
      const aliceBefore = (await ctx.as('user-alice', 'GET', '/bookmarks?limit=100')).body.pagination.total;
      const bobBefore = (await ctx.as('user-bob', 'GET', '/bookmarks?limit=100')).body.pagination.total;

      const alice = await ctx.as('user-alice', 'POST', '/bookmarks', { body });
      const bob = await ctx.as('user-bob', 'POST', '/bookmarks', { body });

      assert.equal(alice.status, 201);
      assert.equal(bob.status, 201, 'the same URL for a different owner is not a repeat');
      assert.notEqual(alice.body.bookmark.id, bob.body.bookmark.id);

      const aliceList = await ctx.as('user-alice', 'GET', '/bookmarks?limit=100');
      const bobList = await ctx.as('user-bob', 'GET', '/bookmarks?limit=100');
      assert.equal(aliceList.body.pagination.total, aliceBefore + 1);
      assert.equal(bobList.body.pagination.total, bobBefore + 1);
    });

    it('survives many concurrent identical creates with a single row', async () => {
      const body = { url: 'https://example.com/race' };
      const rowsBefore = ctx.store.countAll();

      const responses = await Promise.all(
        Array.from({ length: 12 }, () => ctx.as(OWNER, 'POST', '/bookmarks', { body })),
      );

      const created = responses.filter((response) => response.status === 201);
      const conflicted = responses.filter((response) => response.status === 409);

      assert.equal(created.length, 1, 'exactly one request may create the row');
      assert.equal(conflicted.length, 11, 'every other request must be told it is a repeat');
      assert.equal(
        ctx.store.countAll(),
        rowsBefore + 1,
        'twelve identical requests must add exactly one row',
      );
    });

    it('keeps distinct URLs distinct, including near-misses', async () => {
      const distinct = [
        'https://example.com/list',
        'https://example.com/list/', // trailing slash
        'https://example.com/List', // path case
        'https://example.com/list?page=2', // query
        'http://example.com/list', // scheme
      ];

      for (const url of distinct) {
        const response = await ctx.as(OWNER, 'POST', '/bookmarks', { body: { url } });
        assert.equal(response.status, 201, `${url} should be its own bookmark`);
      }

      const list = await ctx.as(OWNER, 'GET', '/bookmarks?limit=100');
      const urls = list.body.bookmarks.map((bookmark) => bookmark.url);
      for (const url of distinct) {
        assert.ok(urls.includes(url), `${url} is missing from the listing`);
      }
    });

    it('collapses variants that mean the same page', async () => {
      const variants = [
        'https://EXAMPLE.com/collapse',
        'http://example.com/collapse', // different scheme: NOT the same
        'https://example.com:443/collapse', // implied port
        'https://example.com/collapse#section-1', // fragment
        'https://example.com/collapse#section-2', // fragment
      ];

      const first = await ctx.as(OWNER, 'POST', '/bookmarks', {
        body: { url: variants[0] },
      });
      assert.equal(first.status, 201);

      for (const variant of variants.slice(2)) {
        const repeat = await ctx.as(OWNER, 'POST', '/bookmarks', { body: { url: variant } });
        assert.equal(repeat.status, 409, `${variant} should be recognised as the same bookmark`);
      }

      // http:// is a different resource and must not be swallowed.
      const differentScheme = await ctx.as(OWNER, 'POST', '/bookmarks', {
        body: { url: variants[1] },
      });
      assert.equal(differentScheme.status, 201);
    });

    it('serves the URL as the caller sent it, not the normalised form', async () => {
      const response = await ctx.as(OWNER, 'POST', '/bookmarks', {
        body: { url: 'https://example.com/as-sent#fragment' },
      });
      assert.equal(response.status, 201);
      assert.equal(response.body.bookmark.url, 'https://example.com/as-sent#fragment');
    });

    it('lets a bookmark be re-created after it is deleted', async () => {
      const body = { url: 'https://example.com/recycle' };

      const first = await ctx.as(OWNER, 'POST', '/bookmarks', { body });
      const repeat = await ctx.as(OWNER, 'POST', '/bookmarks', { body });
      assert.equal(repeat.status, 409);

      const removed = await ctx.as(OWNER, 'DELETE', `/bookmarks/${first.body.bookmark.id}`);
      assert.equal(removed.status, 204);

      const recreated = await ctx.as(OWNER, 'POST', '/bookmarks', { body });
      assert.equal(recreated.status, 201, 'the freed slot must be reusable');
    });
  });

  describe('at the storage layer', () => {
    let directory;

    before(async () => {
      directory = await tempDirectory();
    });

    after(async () => {
      await directory.cleanup();
    });

    it('is enforced by the database, not by process-local state', () => {
      // Two independent connections to the same file share nothing in JavaScript.
      // If duplicate detection relied on anything in the application, this second
      // store would happily insert a second row. It does not, which locates the
      // guarantee in the schema rather than in a check that could be bypassed.
      const path = `${directory.path}/shared.db`;
      const first = new BookmarkStore({ filename: path });
      const second = new BookmarkStore({ filename: path });

      try {
        const one = first.create({ ownerId: 'alice', url: 'https://example.com/db-level', title: null });
        const two = second.create({ ownerId: 'alice', url: 'https://example.com/db-level', title: null });

        assert.equal(one.created, true);
        assert.equal(two.created, false, 'a second connection must still see the conflict');
        assert.equal(two.bookmark.id, one.bookmark.id);
        assert.equal(first.countAll(), 1);
      } finally {
        first.close();
        second.close();
      }
    });
  });

  describe('the normalisation rule itself', () => {
    const same = [
      ['http://example.com', 'HTTP://EXAMPLE.COM'],
      ['https://example.com/', 'https://example.com:443/'],
      ['http://example.com/', 'http://example.com:80/'],
      ['https://example.com/a#one', 'https://example.com/a#two'],
      ['https://example.com/a', 'https://example.com/a#'],
      ['https://example.com', 'https://example.com/'],
    ];

    for (const [left, right] of same) {
      it(`${left} and ${right} normalise to the same key`, () => {
        assert.equal(normalizeUrl(left), normalizeUrl(right));
      });
    }

    const different = [
      ['https://example.com/', 'http://example.com/'],
      ['https://example.com/Data', 'https://example.com/data'],
      ['https://example.com/list', 'https://example.com/list/'],
      ['https://example.com/?id=1', 'https://example.com/?id=2'],
      ['https://example.com/?id=1', 'https://example.com/'],
      ['https://example.com:8443/', 'https://example.com/'],
      ['https://example.com/a', 'https://example.com/b'],
    ];

    for (const [left, right] of different) {
      it(`${left} and ${right} stay distinct`, () => {
        assert.notEqual(normalizeUrl(left), normalizeUrl(right));
      });
    }

    it('is idempotent', () => {
      for (const url of ['https://example.com/a?b=c#d', 'http://example.com:80/', 'https://ex.com/p']) {
        const once = normalizeUrl(url);
        assert.equal(normalizeUrl(once), once);
      }
    });

    it('agrees with WHATWG parsing, so normalisation introduces no surprises', () => {
      // Pinning the delegated behaviour means an unexpected Node change shows up
      // as a failing test here rather than as silently different de-duplication.
      assert.equal(normalizeUrl('https://example.com/a b'), 'https://example.com/a%20b');
      assert.equal(normalizeUrl('https://example.com/'), 'https://example.com/');
      assert.equal(normalizeUrl('https://例え.jp/'), 'https://xn--r8jz45g.jp/');
    });
  });
});
