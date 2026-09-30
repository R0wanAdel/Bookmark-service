/**
 * Server entrypoint.
 *
 * Separate from `app.js` so that importing the application never binds a port.
 * That separation is what lets the test suite construct the app in-process.
 */

import { createApp } from './app.js';

const PORT = Number.parseInt(process.env.PORT ?? '3000', 10);
const HOST = process.env.HOST ?? '127.0.0.1';
const DATABASE_FILE = process.env.DATABASE_FILE ?? 'bookmarks.db';

const { app, store } = createApp({ databaseFile: DATABASE_FILE });

const server = app.listen(PORT, HOST, () => {
  // Printed to stdout rather than logged so it is visible without a log level.
  process.stdout.write(
    `bookmark-service listening on http://${HOST}:${PORT} (database: ${DATABASE_FILE})\n`,
  );
});

/**
 * Drains connections and releases the database file before exiting, so a
 * container restart does not leave a stale write-ahead log behind.
 */
function shutdown(signal) {
  process.stdout.write(`\nreceived ${signal}, shutting down\n`);
  server.close(() => {
    store.close();
    process.exit(0);
  });
  // Do not wait forever for a stuck connection to drain.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
