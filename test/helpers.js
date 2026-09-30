/**
 * Test helpers.
 *
 * Tests drive the app over a real socket rather than by calling handlers
 * directly. That costs a little speed and buys a lot of confidence: status codes,
 * headers, the body parser and the error boundary are all exercised exactly as a
 * caller would hit them, so a test cannot pass while the deployed behaviour
 * differs.
 */

import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../src/app.js';

/** A logger that swallows the service's own diagnostics, keeping output readable. */
export const silentLogger = { log() {}, warn() {}, error() {} };

/** Owner header used by most tests. */
export const OWNER = 'user-alice';

/**
 * Boots an already-constructed Express app on an ephemeral port.
 *
 * Split out from `startTestServer` so a test can assemble its own app - for
 * instance with a store double - and still drive it over a real socket.
 *
 * @param {import('express').Express} app
 * @param {object} [store] Exposed on the context so tests can inspect rows.
 * @returns {Promise<object>} Test context with a `request` helper and `close`.
 */
export async function listenOnce(app, store) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  /**
   * Issues one HTTP request and decodes the response.
   *
   * @param {string} method
   * @param {string} path
   * @param {object} [options]
   * @param {unknown} [options.body] JSON-serialised automatically.
   * @param {string} [options.raw] Sent verbatim, bypassing JSON serialisation.
   * @param {object} [options.headers] Extra request headers.
   * @returns {Promise<{ status: number, headers: Headers, body: any }>}
   *   `body` is null for an empty response such as 204.
   */
  async function request(method, path, { body, raw, headers = {} } = {}) {
    const requestHeaders = { ...headers };
    let payload;

    if (raw !== undefined) {
      payload = raw;
    } else if (body !== undefined) {
      // JSON.stringify cannot serialize BigInt; fall back to textual form so the
      // request reaches the server as unparsable JSON and is treated as a body
      // error instead of causing a preflight throw.
      if (typeof body === 'bigint') {
        payload = body.toString();
        requestHeaders['content-type'] ??= 'text/plain';
      } else {
        try {
          payload = JSON.stringify(body);
        } catch (stringifyError) {
          payload = String(body);
        }
        requestHeaders['content-type'] ??= 'application/json';
      }
    }

    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: requestHeaders,
      body: payload,
    });

    const text = await response.text();
    let decoded = null;
    if (text !== '') {
      try {
        decoded = JSON.parse(text);
      } catch {
        decoded = text;
      }
    }

    return { status: response.status, headers: response.headers, body: decoded };
  }

  /**
   * Convenience wrapper that sends the owner header.
   *
   * @param {string} method
   * @param {string} path
   * @param {object} [options]
   */
  function as(owner, method, path, options = {}) {
    return request(method, path, {
      ...options,
      headers: { 'x-owner-id': owner, ...(options.headers ?? {}) },
    });
  }

  async function close() {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
    store?.close?.();
  }

  return { baseUrl, request, as, store, close, owner: OWNER };
}

/**
 * Boots a real app backed by a real store.
 *
 * @param {object} [options]
 * @param {string} [options.databaseFile] Defaults to an in-memory database.
 * @returns {Promise<object>} Test context.
 */
export async function startTestServer({ databaseFile = ':memory:' } = {}) {
  const { app, store } = createApp({ databaseFile, logger: silentLogger });
  return listenOnce(app, store);
}

/**
 * Builds a store double whose methods can be made to fail on demand.
 *
 * Used to drive the fault paths - the ones a caller must never be able to reach -
 * by making an internal component misbehave.
 *
 * @returns {object} A BookmarkStore-compatible object with a `failWith` control.
 */
export function faultyStore({ methods = ['create'], error = new Error('boom') } = {}) {
const failures = new Set(methods);
    // Held in an array so the current value can be `null`, which a plain `let`
    // cannot represent once it is initialised.
    const thrown = [error];

  const boom = () => {
    if (failures.size > 0) throw thrown[0];
  };

  return {
    failWith(next) {
      thrown[0] = next;
    },
    recover() {
      failures.clear();
    },
    create: () => {
      boom();
      return { bookmark: { id: 'stub' }, created: true };
    },
    listByOwner: () => {
      boom();
      return { items: [], limit: 50, offset: 0, total: 0 };
    },
    findById: () => {
      boom();
      return null;
    },
    deleteById: () => {
      boom();
      return false;
    },
    countAll: () => 0,
    close() {},
  };
}

/**
 * Creates a temporary directory for tests that need a file-backed database.
 *
 * @returns {Promise<{ path: string, cleanup: () => Promise<void> }>}
 */
export async function tempDirectory() {
  const path = await mkdtemp(join(tmpdir(), 'bookmark-service-'));
  return {
    path,
    cleanup: () => rm(path, { recursive: true, force: true }),
  };
}

/**
 * Asserts that an error body is a validation failure naming a specific field.
 *
 * Every malformed-input test funnels through this, so "the response names the
 * field" is checked in exactly one place.
 *
 * @param {{ status: number, body: any }} response
 * @param {string} field
 * @param {string} [expectedCode] Optional specific problem code.
 */
export function assertNamesField(response, field, expectedCode) {
  if (response.status !== 400) {
    throw new Error(`expected status 400, received ${response.status}: ${JSON.stringify(response.body)}`);
  }
  if (response.body?.error?.code !== 'validation_failed') {
    throw new Error(`expected error.code "validation_failed", received ${JSON.stringify(response.body?.error)}`);
  }

  const problems = response.body?.error?.problems;
  if (!Array.isArray(problems) || problems.length === 0) {
    throw new Error(`expected a non-empty problems array, received ${JSON.stringify(response.body)}`);
  }

  const match = problems.find((problem) => problem.field === field);
  if (match === undefined) {
    throw new Error(
      `expected a problem naming field "${field}", received fields: ${JSON.stringify(problems.map((p) => p.field))}`,
    );
  }
  if (!messageNamesField(match.message, field)) {
    throw new Error(`problem message does not name "${field}": ${JSON.stringify(match.message)}`);
  }
  if (expectedCode !== undefined && match.code !== expectedCode) {
    throw new Error(`expected problem code "${expectedCode}", received "${match.code}"`);
  }
  return match;
}

/**
 * A problem is only useful to a caller if its message says which field is at
 * fault, so the field name must appear in the human-readable text as well as the
 * structured `field` key.
 */
function messageNamesField(message, field) {
  return typeof message === 'string' && message.includes(`"${field}"`);
}
