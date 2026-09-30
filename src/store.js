/**
 * Persistence for bookmarks, on SQLite via `node:sqlite`.
 *
 * Two design choices here carry most of the weight of this service.
 *
 * 1. `UNIQUE (owner_id, url_normalized)` is the mechanism that stops a repeated
 *    create request from producing two rows. It is enforced by the database,
 *    not by a "SELECT then INSERT" in application code. An application-level
 *    check has a race between the check and the insert, and under concurrent
 *    requests both callers pass the check and both insert. A uniqueness
 *    constraint has no such window: the second insert simply fails. The route
 *    layer translates that failure into a 409. See README, "Duplicate detection".
 *
 * 2. Every value reaching SQLite is a bound parameter. No caller-supplied string
 *    is ever concatenated into a statement. Error messages do quote user input,
 *    but they travel as bound values, so they cannot alter a statement either.
 *
 * `node:sqlite` is used rather than `better-sqlite3` so the service installs with
 * zero native dependencies and runs on any platform Node runs on.
 */

import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { BUSY_TIMEOUT_MS, MAX_BOOKMARKS_PER_OWNER } from './config.js';
import { PayloadTooLargeError } from './errors.js';
import { normalizeUrl } from './normalize-url.js';

/** SQLITE_CONSTRAINT_UNIQUE - the duplicate we expect and handle. */
const SQLITE_CONSTRAINT_UNIQUE = 2067;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS bookmarks (
    seq            INTEGER PRIMARY KEY AUTOINCREMENT,
    id             TEXT    NOT NULL UNIQUE,
    owner_id       TEXT    NOT NULL,
    url            TEXT    NOT NULL,
    url_normalized TEXT    NOT NULL,
    title          TEXT,
    created_at     TEXT    NOT NULL,
    updated_at     TEXT    NOT NULL,

    -- The repeat rule, stated once, in the schema.
    UNIQUE (owner_id, url_normalized)
  );

  CREATE INDEX IF NOT EXISTS idx_bookmarks_owner_seq
    ON bookmarks (owner_id, seq DESC);
`;

/**
 * Maps an internal row to the shape the HTTP layer serves.
 *
 * `url_normalized` and `owner_id` are internal: the normalized form is an
 * implementation detail of the repeat rule, and the caller already knows who
 * they are. Neither is part of the public representation.
 */
function toBookmark(row) {
  if (row === undefined) return null;
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class BookmarkStore {
  #db;
  #clock;
  #maxPerOwner;
  #busyTimeoutMs;

  /**
   * @param {object} [options]
   * @param {string} [options.filename] SQLite file path, or ':memory:'.
   * @param {() => Date} [options.clock] Injectable clock, for deterministic tests.
   * @param {number} [options.maxPerOwner] Per-owner row ceiling.
   * @param {number} [options.busyTimeoutMs] How long to wait for a contended lock.
   */
  constructor({
    filename = ':memory:',
    clock = () => new Date(),
    maxPerOwner = MAX_BOOKMARKS_PER_OWNER,
    busyTimeoutMs = BUSY_TIMEOUT_MS,
  } = {}) {
    this.#db = new DatabaseSync(filename);
    this.#busyTimeoutMs = busyTimeoutMs;
    this.#configure();
    this.#db.exec(SCHEMA);
    this.#clock = clock;
    this.#maxPerOwner = maxPerOwner;
  }

  /**
   * Applies the connection settings the service depends on.
   *
   * Order matters: `busy_timeout` must be set before any statement runs,
   * because it is what makes a contended lock wait rather than fail.
   */
  #configure() {
    // Wait instead of failing instantly when another writer holds the lock.
    // Without this the default is zero, and two overlapping writes become an
    // immediate SQLITE_BUSY error rather than a slightly slower success.
    this.#db.exec(`PRAGMA busy_timeout = ${this.#busyTimeoutMs}`);

    // Write-ahead logging lets readers run while a writer holds the lock, instead
    // of blocking every read for the duration of a write. This is the setting
    // that makes the single-file database usable by more than one reader.
    //
    // Skipped for in-memory databases, where there is no file to log and SQLite
    // reports the journal mode as "memory" regardless.
    if (this.#db.prepare('PRAGMA database_list').get().file !== '') {
      this.#db.exec('PRAGMA journal_mode = WAL');
    }

    // Referential integrity is off by default in SQLite; turn it on so the
    // schema's intent is actually enforced rather than merely documented.
    this.#db.exec('PRAGMA foreign_keys = ON');
  }

  /**
   * Reads back the settings this connection is running with.
   *
   * Exposed so a test can assert the configuration was actually applied rather
   * than merely written. The service does not otherwise need these.
   *
   * @returns {{ journalMode: string, busyTimeoutMs: number, foreignKeys: boolean }}
   */
  connectionSettings() {
    return {
      journalMode: this.#db.prepare('PRAGMA journal_mode').get().journal_mode,
      busyTimeoutMs: this.#db.prepare('PRAGMA busy_timeout').get().timeout,
      foreignKeys: this.#db.prepare('PRAGMA foreign_keys').get().foreign_keys === 1,
    };
  }

  /** Per-owner row ceiling, reported to callers so the limit is discoverable. */
get maxPerOwner() {
  return this.#maxPerOwner;
}

/**
   * Stores a new bookmark, or returns the existing one when the owner has
   * already saved this URL.
   *
   * A repeat is reported as `created: false` rather than thrown, because the
   * caller of this method can do something useful with the existing row: the
   * 409 it produces names the id the caller already holds. Deciding *whether* a
   * repeat is an error is the route layer's job; deciding *whether one exists*
   * is the database's.
   *
   * @param {object} input
   * @param {string} input.ownerId
   * @param {string} input.url The caller's URL, stored as sent.
   * @param {string} input.title Already validated; may be null.
   * @returns {{ bookmark: object, created: boolean }} `created` is false when the
   *   owner had already saved this URL; `bookmark` is then the pre-existing row.
   * @throws {PayloadTooLargeError} The owner is at capacity.
   */
  create({ ownerId, url, title }) {
    const normalized = normalizeUrl(url);

    // BEGIN IMMEDIATE takes the write lock up front, so the capacity check below
    // and the insert cannot interleave with another writer. The capacity ceiling
    // is therefore accurate, unlike a bare count-then-insert.
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const { count } = this.#db
        .prepare('SELECT COUNT(*) AS count FROM bookmarks WHERE owner_id = ?')
        .get(ownerId);

      if (count >= this.#maxPerOwner) {
        throw new PayloadTooLargeError(
          `Field "owner_id" is at capacity: ${this.#maxPerOwner} bookmarks is the limit.`,
          { field: 'owner_id', limit: this.#maxPerOwner },
        );
      }

      const timestamp = this.#clock().toISOString();
      const id = randomUUID();

      this.#db
        .prepare(
          `INSERT INTO bookmarks (id, owner_id, url, url_normalized, title, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, ownerId, url, normalized, title, timestamp, timestamp);

      const row = this.#db.prepare('SELECT * FROM bookmarks WHERE id = ?').get(id);
      this.#db.exec('COMMIT');
      return { bookmark: toBookmark(row), created: true };
    } catch (error) {
      // Rollback must never mask the original failure. If COMMIT itself threw,
      // the transaction may already be finished and this would otherwise raise
      // a second, more confusing error on top of the first.
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        /* no transaction to roll back */
      }

      if (!isUniqueViolation(error)) throw error;

      // The insert lost the race with an identical row. Read it back outside the
      // transaction so we return committed state rather than our own rolled-back
      // attempt.
      return { bookmark: this.findByNormalizedUrl(ownerId, normalized), created: false };
    }
  }

  /**
   * Looks up an owner's bookmark by its normalised URL. Used to resolve a repeat.
   *
   * @returns {object|null}
   */
  findByNormalizedUrl(ownerId, normalizedUrl) {
    return toBookmark(
      this.#db
        .prepare('SELECT * FROM bookmarks WHERE owner_id = ? AND url_normalized = ?')
        .get(ownerId, normalizedUrl),
    );
  }

  /**
   * Lists one owner's bookmarks, newest first.
   *
   * The owner predicate is mandatory and takes no default: there is no code path
   * that lists without one, which is what makes cross-owner leakage impossible
   * by omission rather than by review.
   *
   * @param {string} ownerId
   * @param {{ limit: number, offset: number }} page
   * @returns {{ items: object[], limit: number, offset: number, total: number }}
   */
  listByOwner(ownerId, { limit, offset }) {
    const items = this.#db
      .prepare(
        `SELECT * FROM bookmarks
          WHERE owner_id = ?
          ORDER BY seq DESC
          LIMIT ? OFFSET ?`,
      )
      .all(ownerId, limit, offset)
      .map(toBookmark);

    const { total } = this.#db
      .prepare('SELECT COUNT(*) AS total FROM bookmarks WHERE owner_id = ?')
      .get(ownerId);

    return { items, limit, offset, total };
  }

  /**
   * Fetches one bookmark belonging to `ownerId`.
   *
   * The owner predicate is part of the lookup, so another owner's id resolves to
   * the same 404 as an id that does not exist. That is intentional: a 404 for
   * both means the endpoint cannot be used to probe for the existence of other
   * people's bookmarks.
   *
   * @returns {object|null}
   */
  findById(ownerId, id) {
    return toBookmark(
      this.#db
        .prepare('SELECT * FROM bookmarks WHERE owner_id = ? AND id = ?')
        .get(ownerId, id),
    );
  }

  /**
   * Deletes one bookmark belonging to `ownerId`.
   *
   * @returns {boolean} True if a row was removed, false if there was nothing to remove.
   */
  deleteById(ownerId, id) {
    const result = this.#db
      .prepare('DELETE FROM bookmarks WHERE owner_id = ? AND id = ?')
      .run(ownerId, id);
    return result.changes > 0;
  }

  /** @returns {number} Total rows, for assertions in tests. */
  countAll() {
    return this.#db.prepare('SELECT COUNT(*) AS count FROM bookmarks').get().count;
  }

  close() {
    this.#db.close();
  }
}

/**
 * Distinguishes the duplicate we expect from a genuine fault.
 *
 * Matching on `errcode` rather than on the message text is deliberate: SQLite's
 * message wording is not part of its API contract, whereas the extended result
 * code is.
 */
function isUniqueViolation(error) {
  if (error?.errcode === SQLITE_CONSTRAINT_UNIQUE) return true;
  return (
    error?.code === 'ERR_SQLITE_ERROR' &&
    typeof error?.message === 'string' &&
    error.message.includes('UNIQUE constraint failed')
  );
}
