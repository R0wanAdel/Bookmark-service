/**
 * Endpoint behaviour and documented status codes.
 *
 * One test per documented status code per endpoint, so the contract in the
 * README is executable rather than aspirational.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { assertNamesField, OWNER, startTestServer } from './helpers.js';

describe('endpoint contract', () => {
  let ctx;

  before(async () => {
    ctx = await startTestServer();
  });

  after(async () => {
    await ctx.close();
  });

  describe('GET /health', () => {
    it('returns 200 with no owner header required', async () => {
      const response = await ctx.request('GET', '/health');
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, { status: 'ok' });
    });
  });

  describe('POST /bookmarks', () => {
    it('returns 201 with the created bookmark and a Location header', async () => {
      const response = await ctx.as(OWNER, 'POST', '/bookmarks', {
        body: { url: 'https://example.com/created', title: 'Created' },
      });

      assert.equal(response.status, 201);
      assert.equal(response.headers.get('location'), `/bookmarks/${response.body.bookmark.id}`);
      assert.equal(response.body.bookmark.url, 'https://example.com/created');
      assert.equal(response.body.bookmark.title, 'Created');
      assert.match(response.body.bookmark.id, /^[0-9a-f-]{36}$/);
      assert.match(response.body.bookmark.createdAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
      assert.equal(response.body.bookmark.updatedAt, response.body.bookmark.createdAt);
    });

    it('never leaks internal fields in the response', async () => {
      const response = await ctx.as(OWNER, 'POST', '/bookmarks', {
        body: { url: 'https://example.com/opaque' },
      });

      assert.deepEqual(Object.keys(response.body.bookmark).sort(), [
        'createdAt',
        'id',
        'title',
        'updatedAt',
        'url',
      ]);
      // url_normalized and owner_id are internal to the repeat rule.
      assert.equal(response.body.bookmark.url_normalized, undefined);
      assert.equal(response.body.bookmark.owner_id, undefined);
    });

    it('returns 400 for a malformed field', async () => {
      const response = await ctx.as(OWNER, 'POST', '/bookmarks', { body: { url: 7 } });
      assertNamesField(response, 'url');
    });

    it('returns 409 for a repeat', async () => {
      const body = { url: 'https://example.com/repeat-409' };
      assert.equal((await ctx.as(OWNER, 'POST', '/bookmarks', { body })).status, 201);

      const response = await ctx.as(OWNER, 'POST', '/bookmarks', { body });
      assert.equal(response.status, 409);
      assert.equal(response.body.error.code, 'conflict');
    });
  });

  describe('GET /bookmarks', () => {
    it('returns only the calling owner\'s bookmarks, newest first', async () => {
      const owner = 'user-listing';
      await ctx.as(owner, 'POST', '/bookmarks', { body: { url: 'https://example.com/l-1' } });
      await ctx.as(owner, 'POST', '/bookmarks', { body: { url: 'https://example.com/l-2' } });
      await ctx.as('user-other', 'POST', '/bookmarks', {
        body: { url: 'https://example.com/other-only' },
      });

      const response = await ctx.as(owner, 'GET', '/bookmarks');

      assert.equal(response.status, 200);
      assert.equal(response.body.bookmarks.length, 2);
      assert.equal(response.body.pagination.total, 2);
      assert.deepEqual(
        response.body.bookmarks.map((bookmark) => bookmark.url),
        ['https://example.com/l-2', 'https://example.com/l-1'],
      );
      assert.ok(
        response.body.bookmarks.every((bookmark) => !bookmark.url.includes('other-only')),
        "another owner's bookmark must not appear",
      );
    });

    it('returns an empty list for an owner with no bookmarks', async () => {
      const response = await ctx.as('user-nobody', 'GET', '/bookmarks');
      assert.equal(response.status, 200);
      assert.deepEqual(response.body.bookmarks, []);
      assert.equal(response.body.pagination.total, 0);
    });

    it('returns 400 for a missing owner header', async () => {
      const response = await ctx.request('GET', '/bookmarks');
      assertNamesField(response, 'x-owner-id');
    });

    it('returns 400 naming limit for a non-numeric limit', async () => {
      const response = await ctx.as(OWNER, 'GET', '/bookmarks?limit=many');
      assertNamesField(response, 'limit', 'wrong_type');
    });

    it('returns 400 naming limit for an out-of-range limit', async () => {
      const response = await ctx.as(OWNER, 'GET', '/bookmarks?limit=0');
      assertNamesField(response, 'limit', 'out_of_range');
    });

    it('returns 400 naming offset for a negative offset', async () => {
      const response = await ctx.as(OWNER, 'GET', '/bookmarks?offset=-1');
      assertNamesField(response, 'offset', 'out_of_range');
    });

    it('reports limit and offset problems together', async () => {
      const response = await ctx.as(OWNER, 'GET', '/bookmarks?limit=x&offset=y');
      assert.equal(response.status, 400);
      assert.deepEqual(
        response.body.error.problems.map((problem) => problem.field).sort(),
        ['limit', 'offset'],
      );
    });

    it('treats an empty limit as absent', async () => {
      const response = await ctx.as(OWNER, 'GET', '/bookmarks?limit=&offset=');
      assert.equal(response.status, 200);
      assert.equal(response.body.pagination.limit, 50);
      assert.equal(response.body.pagination.offset, 0);
    });

    it('applies limit and offset', async () => {
      const owner = 'user-paging';
      for (const n of [1, 2, 3, 4, 5]) {
        await ctx.as(owner, 'POST', '/bookmarks', {
          body: { url: `https://example.com/page-${n}` },
        });
      }

      const page = await ctx.as(owner, 'GET', '/bookmarks?limit=2&offset=2');

      assert.equal(page.status, 200);
      assert.equal(page.body.pagination.limit, 2);
      assert.equal(page.body.pagination.offset, 2);
      assert.equal(page.body.pagination.total, 5);
      assert.equal(page.body.pagination.count, 2);
      assert.deepEqual(
        page.body.bookmarks.map((bookmark) => bookmark.url),
        ['https://example.com/page-3', 'https://example.com/page-2'],
      );
    });
  });

  describe('GET /bookmarks/:id', () => {
    it('returns 200 with the requested bookmark', async () => {
      const created = await ctx.as(OWNER, 'POST', '/bookmarks', {
        body: { url: 'https://example.com/fetchable', title: 'Fetchable' },
      });
      const id = created.body.bookmark.id;

      const response = await ctx.as(OWNER, 'GET', `/bookmarks/${id}`);

      assert.equal(response.status, 200);
      assert.equal(response.body.bookmark.id, id);
      assert.equal(response.body.bookmark.title, 'Fetchable');
    });

    it('returns 404 for an id that does not exist', async () => {
      const response = await ctx.as(OWNER, 'GET', '/bookmarks/00000000-0000-4000-8000-000000000000');
      assert.equal(response.status, 404);
      assert.equal(response.body.error.code, 'not_found');
      assert.equal(response.body.error.field, 'id');
    });

    it("returns 404, not 403, for another owner's id", async () => {
      const created = await ctx.as('user-secret', 'POST', '/bookmarks', {
        body: { url: 'https://example.com/secret' },
      });

      const response = await ctx.as(OWNER, 'GET', `/bookmarks/${created.body.bookmark.id}`);

      // 404 for both "absent" and "not yours" so the endpoint cannot be used to
      // discover which ids exist.
      assert.equal(response.status, 404);
    });

    it('returns 400 naming id for a malformed id', async () => {
      const response = await ctx.as(OWNER, 'GET', '/bookmarks/not%20a%20valid%20id');
      assertNamesField(response, 'id', 'invalid_characters');
    });

    it('returns 400 naming id for an over-long id', async () => {
      const response = await ctx.as(OWNER, 'GET', `/bookmarks/${'a'.repeat(500)}`);
      assertNamesField(response, 'id', 'too_long');
    });

    it('returns 400 naming x-owner-id when the header is missing', async () => {
      const response = await ctx.request('GET', '/bookmarks/anything');
      assertNamesField(response, 'x-owner-id');
    });
  });

  describe('DELETE /bookmarks/:id', () => {
    it('returns 204 with an empty body', async () => {
      const created = await ctx.as(OWNER, 'POST', '/bookmarks', {
        body: { url: 'https://example.com/deletable' },
      });

      const response = await ctx.as(OWNER, 'DELETE', `/bookmarks/${created.body.bookmark.id}`);

      assert.equal(response.status, 204);
      assert.equal(response.body, null);

      const afterDelete = await ctx.as(OWNER, 'GET', `/bookmarks/${created.body.bookmark.id}`);
      assert.equal(afterDelete.status, 404);
    });

    it('returns 404 on a second delete of the same id', async () => {
      const created = await ctx.as(OWNER, 'POST', '/bookmarks', {
        body: { url: 'https://example.com/delete-twice' },
      });
      const id = created.body.bookmark.id;

      assert.equal((await ctx.as(OWNER, 'DELETE', `/bookmarks/${id}`)).status, 204);
      const second = await ctx.as(OWNER, 'DELETE', `/bookmarks/${id}`);
      assert.equal(second.status, 404);
    });

    it("cannot delete another owner's bookmark", async () => {
      const created = await ctx.as('user-victim', 'POST', '/bookmarks', {
        body: { url: 'https://example.com/protected' },
      });

      const response = await ctx.as('user-attacker', 'DELETE', `/bookmarks/${created.body.bookmark.id}`);
      assert.equal(response.status, 404);

      // Still there, untouched.
      const still = await ctx.as('user-victim', 'GET', `/bookmarks/${created.body.bookmark.id}`);
      assert.equal(still.status, 200);
    });

    it('returns 400 naming id for a malformed id', async () => {
      const response = await ctx.as(OWNER, 'DELETE', '/bookmarks/has%2Fslash');
      assertNamesField(response, 'id', 'invalid_characters');
    });
  });

  describe('unrouted paths', () => {
    it('returns a JSON 404 rather than Express\'s HTML page', async () => {
      const response = await ctx.as(OWNER, 'GET', '/not-a-route');

      assert.equal(response.status, 404);
      assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
      assert.equal(response.body.error.code, 'route_not_found');
    });

    it('returns 404 for an unsupported method on a known path', async () => {
      const response = await ctx.as(OWNER, 'PATCH', '/bookmarks');
      assert.equal(response.status, 404);
      assert.equal(response.body.error.code, 'route_not_found');
    });
  });

  it('does not advertise the framework', async () => {
    const response = await ctx.as(OWNER, 'GET', '/health');
    assert.equal(response.headers.get('x-powered-by'), null);
  });
});
