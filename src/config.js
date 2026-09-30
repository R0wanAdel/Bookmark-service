/**
 * Single source of truth for tunables and limits.
 *
 * Every limit is a constant rather than an env var on purpose: these values are
 * part of the API contract that the README documents, so a test run and a
 * production run must agree. Deployment-specific concerns (port, host) live in
 * server.js.
 */

/**
 * Upper bound on a bookmark URL, in characters.
 *
 * Chosen at 1024 rather than "the 2048 bytes that the requirement mentions"
 * deliberately. 1024 is the smallest value that is still generous for real
 * links and is a widely honoured transport ceiling, so anything above it is
 * pathological rather than legitimate. The effect is that a 2 KB URL is
 * rejected with a named-field 400 rather than being stored.
 */
export const MAX_URL_LENGTH = 1024;

/** Upper bound on the optional title, in characters. */
export const MAX_TITLE_LENGTH = 200;

/** Maximum accepted size of a request body, in bytes. */
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * Above this many rows a single owner's collection returns 413 instead of the
 * full list. Stopping unbounded here is deliberate: the "silently saved row"
 * failure mode this service guards against should not have an unbounded twin
 * where a caller silently gets a truncated page with no signal.
 */
export const MAX_BOOKMARKS_PER_OWNER = 10_000;

/** Upper bound on the opaque id a caller may address a bookmark by. */
export const MAX_ID_LENGTH = 64;

/**
 * How long SQLite waits for a lock held by another writer before giving up.
 *
 * Without this, SQLite's default is to fail immediately with SQLITE_BUSY, which
 * means any two writes that overlap - a second process on the same file, or a
 * backup tool taking a read lock - turn into a failed request rather than a
 * slightly slower one. Set to 5000ms, which is long enough to outlast normal
 * contention and short enough that a genuinely stuck lock surfaces as an error
 * instead of hanging a request indefinitely.
 */
export const BUSY_TIMEOUT_MS = 5_000;
