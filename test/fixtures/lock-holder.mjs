/**
 * Test fixture: takes SQLite's write lock on a shared database file, holds it for
 * `holdMs`, then releases it.
 *
 * A worker thread rather than a child process because it needs no module
 * resolution across a process boundary, and because a worker keeps running while
 * the main thread is blocked - which is exactly the situation under test. The
 * main thread blocks synchronously inside SQLite's busy handler, so only a
 * separate thread can perform the release it is waiting for.
 */

import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';

const db = new DatabaseSync(workerData.path);
db.exec('PRAGMA busy_timeout = 5000');

db.exec('BEGIN IMMEDIATE');
db.prepare(
  `INSERT INTO bookmarks (id, owner_id, url, url_normalized, title, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
).run(
  '00000000-0000-4000-8000-000000000000',
  'blocker',
  'https://blocker.example/',
  'https://blocker.example/',
  null,
  '2024-01-01T00:00:00.000Z',
  '2024-01-01T00:00:00.000Z',
);

parentPort.postMessage('locked');

setTimeout(() => {
  db.exec('ROLLBACK');
  db.close();
  parentPort.postMessage('released');
}, workerData.holdMs);
