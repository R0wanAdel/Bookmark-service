/**
 * The malformed-input contract.
 *
 * These are the four cases the brief calls out - empty string, number, missing
 * field, and a 2 KB URL - plus the neighbouring shapes a caller will actually
 * send. Every one must be a 400 whose message names the field, and none may
 * leave a row behind.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { MAX_TITLE_LENGTH, MAX_URL_LENGTH } from '../src/config.js';
import { validateOwnerId } from '../src/validation.js';
import { assertNamesField, OWNER, startTestServer } from './helpers.js';

/** A URL that is comfortably over the documented 2048-byte scenario. */
const TWO_KILOBYTE_URL = `https://example.com/${'a'.repeat(2048)}`;

describe('POST /bookmarks rejects malformed input', () => {
  let ctx;

  before(async () => {
    ctx = await startTestServer();
  });

  after(async () => {
    await ctx.close();
  });

  it('rejects an empty string url, naming the field', async () => {
    const response = await ctx.as(OWNER, 'POST', '/bookmarks', { body: { url: '' } });
    assertNamesField(response, 'url', 'empty');
    assert.equal(ctx.store.countAll(), 0, 'no row may be written');
  });

  it('rejects a whitespace-only url, naming the field', async () => {
    const response = await ctx.as(OWNER, 'POST', '/bookmarks', { body: { url: '   ' } });
    assertNamesField(response, 'url', 'empty');
    assert.equal(ctx.store.countAll(), 0);
  });

  it('rejects a numeric url, naming the field and the type received', async () => {
    const response = await ctx.as(OWNER, 'POST', '/bookmarks', { body: { url: 12345 } });
    const problem = assertNamesField(response, 'url', 'wrong_type');
    assert.equal(problem.actual, 'number');
    assert.equal(problem.expected, 'string');
    assert.equal(ctx.store.countAll(), 0);
  });

  it('rejects a missing url, naming the field', async () => {
    const response = await ctx.as(OWNER, 'POST', '/bookmarks', { body: { title: 'no url here' } });
    assertNamesField(response, 'url', 'required');
    assert.equal(ctx.store.countAll(), 0);
  });

  it('rejects a two-kilobyte url, naming the field and both lengths', async () => {
    const response = await ctx.as(OWNER, 'POST', '/bookmarks', {
      body: { url: TWO_KILOBYTE_URL },
    });
    const problem = assertNamesField(response, 'url', 'too_long');
    assert.equal(problem.limit, MAX_URL_LENGTH);
    assert.equal(problem.actual, TWO_KILOBYTE_URL.length);
    assert.ok(problem.actual >= 2048, 'the test URL really is at least 2 KB');
    assert.equal(ctx.store.countAll(), 0);
  });

  it('reports the oversized url as too long rather than as unparseable', async () => {
    // The length check runs before parsing, so the caller is told the actionable
    // thing (it is too big) instead of the incidental thing (it did not parse).
    const response = await ctx.as(OWNER, 'POST', '/bookmarks', {
      body: { url: `https://example.com/${'%'.repeat(3000)}` },
    });
    assertNamesField(response, 'url', 'too_long');
  });

  it('pins the url length boundary exactly', async () => {
    const atLimit = `https://example.com/${'a'.repeat(MAX_URL_LENGTH - 'https://example.com/'.length)}`;
    assert.equal(atLimit.length, MAX_URL_LENGTH);

    const accepted = await ctx.as(OWNER, 'POST', '/bookmarks', { body: { url: atLimit } });
    assert.equal(accepted.status, 201);

    const overLimit = `${atLimit}a`;
    const rejected = await ctx.as(OWNER, 'POST', '/bookmarks', { body: { url: overLimit } });
    assertNamesField(rejected, 'url', 'too_long');
  });

  for (const [label, value] of [
    ['null', null],
    ['boolean', true],
    ['array', ['https://example.com']],
    ['object', { href: 'https://example.com' }],
    ['non-URL string', 'not a url at all'],
    ['scheme-less string', 'example.com'],
    ['ftp scheme', 'ftp://example.com/file'],
    ['protocol-relative', '//example.com'],
    ['embedded credentials', 'https://user:secret@example.com'],
    ['control character', 'https://example.com/\u0000path'],
  ]) {
    it(`rejects a url that is a ${label}, naming the field`, async () => {
      const rowsBefore = ctx.store.countAll();
      const response = await ctx.as(OWNER, 'POST', '/bookmarks', { body: { url: value } });
      assertNamesField(response, 'url');
      assert.equal(ctx.store.countAll(), rowsBefore, 'no row may be written');
    });
  }

  describe('the optional title field', () => {
    it('is genuinely optional', async () => {
      const response = await ctx.as(OWNER, 'POST', '/bookmarks', {
        body: { url: 'https://example.com/untitled' },
      });
      assert.equal(response.status, 201);
      assert.equal(response.body.bookmark.title, null);
    });

    for (const [label, value] of [
      ['number', 42],
      ['array', ['a']],
      ['object', { text: 'a' }],
      ['empty string', ''],
      ['whitespace only', '   '],
    ]) {
      it(`rejects a title that is a ${label}, naming the field`, async () => {
        const response = await ctx.as(OWNER, 'POST', '/bookmarks', {
          body: { url: 'https://example.com/titled', title: value },
        });
        assertNamesField(response, 'title');
      });
    }

    it('rejects an oversized title, naming the field', async () => {
      const response = await ctx.as(OWNER, 'POST', '/bookmarks', {
        body: { url: 'https://example.com/long-title', title: 'x'.repeat(MAX_TITLE_LENGTH + 1) },
      });
      const problem = assertNamesField(response, 'title', 'too_long');
      assert.equal(problem.limit, MAX_TITLE_LENGTH);
    });

    it('accepts a title of exactly the limit', async () => {
      const response = await ctx.as(OWNER, 'POST', '/bookmarks', {
        body: { url: 'https://example.com/max-title', title: 'x'.repeat(MAX_TITLE_LENGTH) },
      });
      assert.equal(response.status, 201);
    });
  });

  describe('the body itself', () => {
    for (const [label, raw] of [
      ['truncated JSON', '{"url": '],
      ['plain text', 'this is not json'],
      ['a bare JSON string', '"https://example.com"'],
      ['a JSON array', '["https://example.com"]'],
      ['JSON null', 'null'],
      ['JSON number', '42'],
    ]) {
      it(`rejects ${label} with a 400 naming body, never a 500`, async () => {
        const response = await ctx.as(OWNER, 'POST', '/bookmarks', {
          raw,
          headers: { 'content-type': 'application/json' },
        });
        assert.equal(response.status, 400, JSON.stringify(response.body));
        const problems = response.body?.error?.problems;
        const fields = problems
          ? problems.map((problem) => problem.field)
          : [response.body?.error?.field];
        assert.ok(
          fields.includes('body'),
          `expected a problem naming "body", got ${JSON.stringify(fields)}`,
        );
      });
    }

    it('treats a completely empty body as a body with no url in it', async () => {
      // An empty body parses to `{}`, so the honest fault is a missing `url`
      // rather than an unparseable body. Naming `url` tells the caller what to add.
      const response = await ctx.as(OWNER, 'POST', '/bookmarks', {
        raw: '',
        headers: { 'content-type': 'application/json' },
      });
      assert.equal(response.status, 400);
      assertNamesField(response, 'url', 'required');
    });
  });

  describe('the owner header', () => {
    it('rejects a missing owner header, naming the field', async () => {
      const response = await ctx.request('POST', '/bookmarks', {
        body: { url: 'https://example.com/no-owner' },
      });
      assertNamesField(response, 'x-owner-id', 'required');
    });

    it('rejects an empty owner header, naming the field', async () => {
      const response = await ctx.request('POST', '/bookmarks', {
        body: { url: 'https://example.com/no-owner' },
        headers: { 'x-owner-id': '' },
      });
      assertNamesField(response, 'x-owner-id', 'empty');
    });

    it('rejects an owner header with illegal characters, naming the field', async () => {
      const response = await ctx.request('POST', '/bookmarks', {
        body: { url: 'https://example.com/no-owner' },
        headers: { 'x-owner-id': 'alice bob/../root' },
      });
      assertNamesField(response, 'x-owner-id', 'invalid_characters');
    });

    it('rejects an owner header that arrived as a joined list, naming the field', async () => {
      // Node joins duplicate headers into one comma-separated value before the
      // app sees them, so this is what a repeated header looks like in practice.
      const response = await ctx.request('POST', '/bookmarks', {
        body: { url: 'https://example.com/no-owner' },
        headers: { 'x-owner-id': ['alice', 'bob'] },
      });
      assertNamesField(response, 'x-owner-id', 'invalid_characters');
    });

    it('rejects a repeated owner header array at the validation boundary', () => {
      // The HTTP path above cannot produce an array, so the guard against one is
      // covered here directly rather than left untested.
      assert.throws(
        () => validateOwnerId({ 'x-owner-id': ['alice', 'bob'] }),
        (error) => error.status === 400 && error.details.problems[0].code === 'repeated',
      );
    });
  });

  it('reports every problem at once rather than one per round-trip', async () => {
    const response = await ctx.as(OWNER, 'POST', '/bookmarks', {
      body: { url: '', title: 123 },
    });
    assert.equal(response.status, 400);
    const fields = response.body.error.problems.map((problem) => problem.field);
    assert.deepEqual([...fields].sort(), ['title', 'url']);
    assert.match(response.body.error.message, /2 problems/);
  });

  it('echoes nothing that was not sent, and never stores a rejected request', async () => {
    const before = ctx.store.countAll();
    const response = await ctx.as(OWNER, 'POST', '/bookmarks', {
      body: { url: '', title: 7 },
    });
    assert.equal(response.status, 400);
    assert.equal(ctx.store.countAll(), before);
  });
});
