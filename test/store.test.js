/**
 * Storage behaviour that is not visible through the HTTP contract.
 *
 * The persistence and capacity cases live here rather than in the endpoint tests
 * because each needs to control the store's construction directly - a file path,
 * or a ceiling small enough to reach in a test.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Worker } from 'node:worker_threads';

import { BUSY_TIMEOUT_MS } from '../src/config.js';
import { PayloadTooLargeError } from '../src/errors.js';
import { BookmarkStore } from '../src/store.js';
import { tempDirectory } from './helpers.js';

describe('bookmark store', () => {
  let directory;

  before(async () => {
    directory = await tempDirectory();
  });

  after(async () => {
    await directory.cleanup();
  });

  it('persists across a close and reopen', () => {
    const path = `${directory.path}/persist.db`;

    const first = new BookmarkStore({ filename: path });
    const created = first.create({
      ownerId: 'alice',
      url: 'https://example.com/persisted',
      title: 'Kept',
    });
    first.close();

    const second = new BookmarkStore({ filename: path });
    try {
      const found = second.findById('alice', created.bookmark.id);
      assert.equal(found.url, 'https://example.com/persisted');
      assert.equal(found.title, 'Kept');
      // And the repeat rule survives the restart too.
      assert.equal(
        second.create({ ownerId: 'alice', url: 'https://example.com/persisted', title: null })
          .created,
        false,
      );
    } finally {
      second.close();
    }
  });

  it('refuses to exceed the per-owner ceiling, naming the owner', () => {
    const store = new BookmarkStore({ maxPerOwner: 2 });
    try {
      store.create({ ownerId: 'alice', url: 'https://example.com/1', title: null });
      store.create({ ownerId: 'alice', url: 'https://example.com/2', title: null });

      assert.throws(
        () => store.create({ ownerId: 'alice', url: 'https://example.com/3', title: null }),
        (error) => {
          assert.ok(error instanceof PayloadTooLargeError);
          assert.equal(error.status, 413);
          assert.equal(error.details.field, 'owner_id');
          assert.equal(error.details.limit, 2);
          return true;
        },
      );

      // Another owner is unaffected by one owner's ceiling.
      assert.equal(
        store.create({ ownerId: 'bob', url: 'https://example.com/1', title: null }).created,
        true,
      );
      assert.equal(store.countAll(), 3);
    } finally {
      store.close();
    }
  });

  it('leaves the store usable after a rejected create', () => {
    const store = new BookmarkStore({ maxPerOwner: 1 });
    try {
      store.create({ ownerId: 'alice', url: 'https://example.com/only', title: null });
      assert.throws(() => store.create({ ownerId: 'alice', url: 'https://example.com/two', title: null }));

      // The failed transaction must have been rolled back, not left open.
      assert.equal(store.create({ ownerId: 'bob', url: 'https://example.com/b', title: null }).created, true);
      assert.equal(store.countAll(), 2);
    } finally {
      store.close();
    }
  });

  it('orders by insertion, newest first, with no ties', () => {
    // A fixed clock means every row shares a timestamp, so an order that relied
    // on `created_at` alone would be ambiguous. Ordering on the autoincrement
    // key keeps it exact even when the clock does not move.
    const store = new BookmarkStore({ clock: () => new Date('2024-01-01T00:00:00.000Z') });
    try {
      const urls = ['https://example.com/a', 'https://example.com/b', 'https://example.com/c'];
      for (const url of urls) store.create({ ownerId: 'alice', url, title: null });

      const listed = store.listByOwner('alice', { limit: 10, offset: 0 });
      assert.deepEqual(listed.items.map((bookmark) => bookmark.url), urls.slice().reverse());
    } finally {
      store.close();
    }
  });

  it('stamps createdAt and updatedAt from the injected clock', () => {
    const store = new BookmarkStore({ clock: () => new Date('2030-06-05T04:03:02.001Z') });
    try {
      const { bookmark } = store.create({
        ownerId: 'alice',
        url: 'https://example.com/timed',
        title: null,
      });
      assert.equal(bookmark.createdAt, '2030-06-05T04:03:02.001Z');
      assert.equal(bookmark.updatedAt, '2030-06-05T04:03:02.001Z');
    } finally {
      store.close();
    }
  });

  it('paginates without gaps or repeats', () => {
    const store = new BookmarkStore();
    try {
      for (let n = 1; n <= 7; n += 1) {
        store.create({ ownerId: 'alice', url: `https://example.com/p${n}`, title: null });
      }

      const seen = new Set();
      for (let offset = 0; offset < 7; offset += 3) {
        const page = store.listByOwner('alice', { limit: 3, offset });
        assert.equal(page.total, 7);
        for (const bookmark of page.items) {
          assert.ok(!seen.has(bookmark.id), 'a row appeared on two pages');
          seen.add(bookmark.id);
        }
      }
      assert.equal(seen.size, 7);
    } finally {
      store.close();
    }
  });

  it('returns an empty page past the end rather than failing', () => {
    const store = new BookmarkStore();
    try {
      const page = store.listByOwner('alice', { limit: 10, offset: 500 });
      assert.deepEqual(page.items, []);
      assert.equal(page.total, 0);
    } finally {
      store.close();
    }
  });
});

/**
 * Connection configuration.
 *
 * These exist because the settings are load-bearing rather than decorative:
 * without `busy_timeout` a contended write fails immediately instead of waiting,
 * which turns ordinary concurrency into user-visible errors. The test below
 * proves the behaviour changed, by running the same contended write with the
 * timeout disabled.
 */
describe('bookmark store connection settings', () => {
  let directory;

  before(async () => {
    directory = await tempDirectory();
  });

  after(async () => {
    await directory.cleanup();
  });

  it('applies the intended pragmas to a file-backed connection', () => {
    const store = new BookmarkStore({ filename: `${directory.path}/pragmas.db` });
    try {
      const settings = store.connectionSettings();
      assert.equal(settings.busyTimeoutMs, BUSY_TIMEOUT_MS);
      assert.equal(settings.journalMode, 'wal');
      assert.equal(settings.foreignKeys, true);
    } finally {
      store.close();
    }
  });

  it('does not request write-ahead logging from an in-memory database', () => {
    const store = new BookmarkStore();
    try {
      // There is no file to write a log to, so SQLite reports "memory". What
      // matters is that the PRAGMA did not throw on the way.
      assert.equal(store.connectionSettings().journalMode, 'memory');
    } finally {
      store.close();
    }
  });

  it('waits for a contended lock instead of failing immediately', async () => {
    const path = `${directory.path}/contended.db`;
    const holdMs = 400;

    const store = new BookmarkStore({ filename: path, busyTimeoutMs: 5000 });
    try {
      const elapsedMs = await withLockedDatabase(path, holdMs, () => {
        const startedAt = process.hrtime.bigint();
        const result = store.create({
          ownerId: 'alice',
          url: 'https://example.com/waiting',
          title: null,
        });
        return { result, waitedMs: Number(process.hrtime.bigint() - startedAt) / 1e6 };
      });

      assert.equal(elapsedMs.result.created, true, 'the write should succeed once the lock clears');
      assert.ok(
        elapsedMs.waitedMs >= holdMs * 0.5,
        `expected to wait for the lock holder, waited only ${elapsedMs.waitedMs.toFixed(0)}ms`,
      );
    } finally {
      store.close();
    }
  });

  it('would fail immediately without the timeout, which is why it is set', async () => {
    const path = `${directory.path}/no-timeout.db`;
    const holdMs = 400;

    // The same contended write against a store with no busy timeout. This is the
    // regression the setting prevents, pinned so the two cannot drift apart.
    const store = new BookmarkStore({ filename: path, busyTimeoutMs: 0 });
    try {
      const elapsedMs = await withLockedDatabase(path, holdMs, () => {
        const startedAt = process.hrtime.bigint();
        try {
          store.create({ ownerId: 'alice', url: 'https://example.com/failing', title: null });
          return { failed: false, waitedMs: Number(process.hrtime.bigint() - startedAt) / 1e6 };
        } catch {
          return { failed: true, waitedMs: Number(process.hrtime.bigint() - startedAt) / 1e6 };
        }
      });

      assert.equal(elapsedMs.failed, true, 'a zero busy_timeout must not wait');
      assert.ok(
        elapsedMs.waitedMs < holdMs / 2,
        `expected an immediate failure, took ${elapsedMs.waitedMs.toFixed(0)}ms`,
      );
    } finally {
      store.close();
    }
  });
});

/**
 * Runs `action` while a worker thread holds SQLite's write lock.
 *
 * @param {string} path Database file. Must already have its schema created.
 * @param {number} holdMs How long the worker keeps the lock.
 * @param {() => any} action Executed on the main thread while the lock is held.
 * @returns {Promise<any>} Whatever `action` returns.
 */
async function withLockedDatabase(path, holdMs, action) {
  const worker = new Worker(new URL('./fixtures/lock-holder.mjs', import.meta.url), {
    workerData: { path, holdMs },
  });

  try {
    // Wait until the worker has genuinely taken the lock before contending it.
    await new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });

    return action();
  } finally {
    await worker.terminate();
  }
}
