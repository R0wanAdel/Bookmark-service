/**
 * URL normalisation.
 *
 * This module defines what "the same bookmark" means, so the reasoning lives
 * here rather than being scattered through the storage layer. See the
 * "Duplicate detection" section of README.md for the full argument; the short
 * version is repeated at each rule below.
 */

/**
 * Ports that are implied by the scheme and therefore carry no information.
 * WHATWG's `URL` already drops these during parsing, so this list exists as
 * documentation of intent and as a guard for any future change.
 */
const DEFAULT_PORTS = new Set(['80', '443', '']);

/**
 * Produces the canonical key used to decide whether a create request is a
 * repeat of an existing bookmark.
 *
 * Two bookmark requests are "the same" when this function returns the same
 * string for both. The transform is deterministic, idempotent, and total for
 * any value that has already passed validation.
 *
 * Normalised (a difference that no longer creates a second row):
 *   - scheme and host letter case          HTTPS://Example.COM == https://example.com
 *   - an implied default port              https://example.com:443/ == https://example.com/
 *   - the fragment                         https://example.com/a#one == #two
 *   - percent-encoding of the same bytes   /a%7Eb == /a~b
 *
 * Preserved (a difference that still creates a second row):
 *   - path case                            /Data != /data
 *   - a trailing slash                     /list != /list/
 *   - the query string                     ?id=1 != ?id=2
 *
 * Note that ownership is deliberately *not* part of this function. Scoping is
 * expressed by the storage layer's `UNIQUE (owner_id, url_normalized)`
 * constraint instead, so two people saving the same link get two rows. Keeping
 * the two concerns separate is what lets this function stay a pure function of
 * the URL alone, which makes it trivial to test.
 *
 * @param {string} url An absolute http/https URL that has already been validated.
 * @returns {string} The canonical comparison key.
 */
export function normalizeUrl(url) {
  const parsed = new URL(url);

  // Fragments address a position *within* a resource. For bookmark purposes
  // "#comments" and "#replies" are the same page, so the fragment is dropped.
  parsed.hash = '';

  // Defensive: WHATWG drops the default port during parsing, but if a caller
  // reaches here with an unusual scheme this keeps the key stable.
  if (DEFAULT_PORTS.has(parsed.port)) parsed.port = '';

  // `href` is the WHATWG serialiser, which lowercases scheme and host and
  // normalises percent-encoding. It deliberately preserves path case and any
  // trailing slash, which is the behaviour we want.
return parsed.href;
}
