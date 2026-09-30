# Bookmark Service

An HTTP service for saving bookmarks. A caller can create a bookmark, list their
own, fetch one by id, and delete one.

The interesting part is not the happy path. It is what happens when a caller sends
an empty URL, a number where a URL belongs, no URL at all, or a URL that is two
kilobytes long — and what happens when the same bookmark is sent twice.

```
npm install
npm start          # http://127.0.0.1:3000
npm test           # 120 tests, no watch mode, ~5s
```

Node 20 or newer. One runtime dependency (Express); persistence uses the built-in
`node:sqlite`, so there is nothing to compile.

---

## Endpoints

Every caller must identify itself with an `X-Owner-Id` header, except
`GET /health`. See [Ownership](#ownership).

| Method   | Path                | Success | Also returns                                                              |
| -------- | ------------------- | ------- | ------------------------------------------------------------------------- |
| `GET`    | `/health`           | 200     | —                                                                          |
| `POST`   | `/bookmarks`        | 201     | 400 malformed field · 409 already bookmarked · 413 owner at capacity      |
| `GET`    | `/bookmarks`        | 200     | 400 malformed field or query parameter                                     |
| `GET`    | `/bookmarks/{id}`   | 200     | 400 malformed field · 404 unknown id, or not yours                         |
| `DELETE` | `/bookmarks/{id}`   | 204     | 400 malformed field · 404 unknown id, or not yours                         |
| any      | anything else       | —       | 404, as JSON                                                               |


### `POST /bookmarks`

```bash
curl -i -X POST http://127.0.0.1:3000/bookmarks \
  -H 'X-Owner-Id: user-alice' \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/article","title":"An article"}'
```

`201 Created`, with a `Location` header:

```json
{
  "bookmark": {
    "id": "6f1c…",
    "url": "https://example.com/article",
    "title": "An article",
    "createdAt": "2026-09-30T10:15:00.000Z",
    "updatedAt": "2026-09-30T10:15:00.000Z"
  }
}
```

Only `url` is required. `title` is optional and may be omitted or `null`; if you
send it, it must be a non-empty string. `url_normalized` and `owner_id` are stored
but never served — see [Duplicate detection](#duplicate-detection).

### `GET /bookmarks`

Query parameters: `limit` (1–100, default 50) and `offset` (0–100000, default 0).

```json
{
  "bookmarks": [ /* newest first */ ],
  "pagination": { "limit": 50, "offset": 0, "total": 3, "count": 3, "maxPerOwner": 10000 }
}
```

### `GET /bookmarks/{id}` and `DELETE /bookmarks/{id}`

`200` with `{ "bookmark": { … } }` and `204` with an empty body respectively.

---

## Malformed input

Every rejection is a `400` with a machine-readable `problems` array. Each problem
names the field, in the structured `field` key *and* in the human-readable
`message`.

```json
{
  "error": {
    "code": "validation_failed",
    "message": "Request validation failed: 1 problem.",
    "problems": [
      {
        "field": "url",
        "code": "wrong_type",
        "message": "Field \"url\" must be a string, received number.",
        "expected": "string",
        "actual": "number"
      }
    ]
  }
}
```

The four cases from the brief, and what each returns:

| Sent                                   | Status | `field` | `code`         |
| -------------------------------------- | ------ | ------- | -------------- |
| `{"url": ""}`                          | 400    | `url`   | `empty`        |
| `{"url": 12345}`                       | 400    | `url`   | `wrong_type`   |
| `{"title": "no url"}`                  | 400    | `url`   | `required`     |
| `{"url": "https://…/a×2048"}`          | 400    | `url`   | `too_long`     |

In every case `limit` and `actual` are included for `too_long`, so a caller can
see both what was allowed and what was sent. **No rejected request writes a row** —
asserted directly in the tests by counting rows before and after.

Other rules, all reported the same way:

- `url` must be an absolute `http://` or `https://` URL with a host, and at most
  **1024 characters**.
- `url` must not embed a username or password — they would leak into every later
  read and list.
- `title`, if present, must be a non-empty string of at most 200 characters.
- `X-Owner-Id` must match `[A-Za-z0-9_-]{1,128}`.
- `{id}` must match `[A-Za-z0-9_-]{1,64}`.
- A body that is not a JSON object, or not parseable JSON, is a `400` naming
  `body`.
- Every problem in a request is reported in one response. `{"url":"","title":123}`
  returns two problems, not two round-trips.

### Why the URL cap is 1024 and not 2048

The cap is deliberately *below* the 2 KB URL in the brief, so that a 2 KB URL is
rejected. 1024 is the smallest ceiling that is still generous for real links and
is a widely honoured transport limit; above it, URLs are pathological rather than
legitimate. The length check runs **before** URL parsing and reports the raw
character count, so an oversized URL is told it is too big rather than being
obscured by an incidental parse failure. Both boundaries are pinned by tests.

---

## Duplicate detection

**The rule.** Two create requests are the same bookmark when they have the same
owner *and* the same URL after normalisation. That is enforced by a database
constraint:

```sql
UNIQUE (owner_id, url_normalized)
```

**The normalisations applied** (so that these do *not* create a second row):

| Input                                   | Result                        |
| --------------------------------------- | ----------------------------- |
| `HTTPS://Example.COM/a`                 | `https://example.com/a`       |
| `https://example.com:443/a`             | `https://example.com/a`       |
| `https://example.com/a#section-1`       | `https://example.com/a`       |
| `https://example.com/a#section-2`       | `https://example.com/a`       |
| `https://例え.jp/`                       | `https://xn--r8jz45g.jp/`     |

**Preserved** (so that these *do* create a second row):

| Kept distinct because | Example pair                                              |
| --------------------- | --------------------------------------------------------- |
| Path case             | `…/Data` vs `…/data` — real servers may distinguish these   |
| Trailing slash        | `…/list` vs `…/list/`                                       |
| Query string          | `…/?id=1` vs `…/?id=2` — often identifies the resource      |
| Scheme                | `http://…` vs `https://…` — different documents            |
| Non-default port      | `https://example.com:8443/` vs `https://example.com/`      |

### Why this rule

**Fragments are dropped, query strings are kept.** This is the one genuinely
contestable decision, so here is the reasoning. A fragment addresses a position
*within* a document: `#comments` and `#replies` are the same page, and a
bookmark service that treated them as different would fill a user's list with
copies. A query string is different — `?id=1` and `?id=2` are usually different
pages, and in many applications (issue trackers, dashboards, infinite scroll) the
query *is* the resource. Dropping fragments and keeping queries follows that
distinction. If this service were used somewhere where fragments are the primary
identity, `normalizeUrl` is the single function to change.

**Path case and trailing slash are kept.** Both are the sort of thing that
plausibly *is* significant on some servers, and getting it wrong merges two
genuinely different bookmarks. Erring toward a duplicate the user can delete is
less harmful than silently refusing to save something they asked for. The
consequence is stated plainly here rather than hidden: `…/list` and `…/list/` are
two rows.

**The title is not part of the key.** A user who bookmarks a URL with a typo in
the title and then re-sends it to fix the typo wants the same bookmark, not two.
Re-sending is a 409 naming the existing id, so the path to a corrected title is
delete-then-create. The alternative — treating the title as part of the key —
means a single typo permanently duplicates the entry.

**Ownership is part of the key, not of the comparison.** Two people saving the
same link is not a duplicate. `normalizeUrl` is a pure function of the URL alone;
scoping is expressed entirely by the schema. Keeping those separate is what makes
the normalisation trivially testable in isolation.

### Why a database constraint rather than a check

The obvious implementation is `SELECT … then INSERT if not found`. It has a race:
between the check and the insert, a concurrent request for the same URL also sees
nothing and also inserts. Two rows, and no error to indicate it went wrong. A
uniqueness constraint has no such window — the second insert simply fails, and the
failure is the signal.

So the service returns **`409 Conflict`**, not `201` and not `200`. A `200` would
tell the caller their bookmark was created when nothing was written, which is the
worst of the three options. The 409 body names the field and carries the id the
caller already holds:

```json
{
  "error": {
    "code": "conflict",
    "message": "You have already bookmarked this URL.",
    "field": "url",
    "existingId": "6f1c…",
    "existing": { "id": "6f1c…", "url": "https://example.com/article", "…": "…" }
  }
}
```

Three tests hold this up:

- The identical request sent twice leaves exactly one row.
- Twelve concurrent identical requests produce exactly one `201` and eleven `409`s,
  and one row.
- Two *independent* store connections to the same database file see the conflict.
  This is the important one: if detection relied on anything in the application,
  a second connection sharing no JavaScript state would happily insert. It does
  not, which locates the guarantee in the schema rather than in a check that could
  be bypassed.

A repeat is not permanent: delete the bookmark and the URL can be created again.

---

## Ownership

There is no authentication. A caller declares who they are with `X-Owner-Id`.

This is a deliberate simplification, and the trade-off is worth stating: the header
is **asserted, not proven**, so anyone can read or delete anyone else's bookmarks by
changing it. What the header *does* buy is a real boundary between owners — every
query filters on `owner_id`, so one caller cannot see another's rows by accident,
and the isolation is enforced by tests rather than by review.

Putting a real identity provider in front would mean replacing `validateOwnerId`
with a check against a verified token. Every other part of the service already
treats the owner as an opaque validated identifier and would not change.

---

## No input produces a 500

This holds by construction, not by luck:

1. `src/validation.js` is total. Every function either returns a value or throws
   `ValidationError`. Nothing else can escape it.
2. Handlers contain no conditionals that pick a status code from an unexpected
   value. Every rejection they can produce is a thrown `AppError`.
3. `src/errors-middleware.js` is the single place that converts a thrown value
   into a response, and it has a total fallback. There is no input for which it
   fails to produce a response.
4. Body-parser failures are translated to `AppError` at the app level, so the
   boundary never has to pattern-match framework error shapes.

`test/no-500.test.js` then checks the claim empirically: 46 hostile field values
(BigInt, `NaN`, `Infinity`, `null`, functions, objects with `toString: null`,
control characters, 10 KB strings, `javascript:` and `data:` URLs, SQL injection
attempts, prototype-pollution payloads) × 10 routes × 4 body shapes = 1,840
requests, plus 90 requests with hostile owner headers, 12 query strings, 147
raw bodies across 7 content types, and 84 unusual path and method combinations.
Any 5xx fails the test, and any 4xx must still have a usable body.

`test/error-boundary.test.js` covers the paths a caller *cannot* reach, using a
store double that misbehaves: a genuine fault returns a generic 500 with no
internal detail in the body, the detail goes to the log instead, a thrown string
or bare object is handled, and the service recovers on the next request.

Two things that testing turned up, both now handled:

- The error handler originally did `` `… ${error?.stack ?? error}` ``, which throws
  for a null-prototype object. That would have made the error handler throw and
  handed the caller Express's default HTML error page instead of this service's
  JSON. `describe()` in `errors-middleware.js` is total.
- A handler that throws `null` degrades to a 404 rather than a 500, because
  Express 4 treats a falsy value passed to `next()` as "no error". This leaks
  nothing and no caller input can reach it, since validation only ever throws
  `AppError`. It is recorded in a test as a known property rather than left to
  surprise someone.

---

## Ownership of data and safety notes

- **SQL injection.** Every caller-supplied value reaches SQLite as a bound
  parameter. No value is ever concatenated into a statement. Error messages do
  quote user input, but they travel as bound values too, so they cannot alter a
  statement. `test/no-500.test.js` sends `' OR 1=1 --`, `"; DROP TABLE bookmarks; --`
  and a Unicode path.
- **Information disclosure.** 5xx responses carry a fixed generic message and
  nothing else; the detail is logged. A test asserts that no response contains a
  stack frame, a module path, a source path, or the driver name.
- **Error volume.** A 4xx is not logged. It is the caller's problem, and logging
  it in full would bury real faults.
- **Errors are echoed bounded.** A rejected value appears in the error body
  truncated to 120 characters, so a large input cannot be used to flood a client.
- **Caps.** Request body 64 KB, URL 1024 characters, title 200 characters, 10,000
  bookmarks per owner. The owner ceiling exists so that listing cannot become an
  unbounded read; exceeding it is a `413` naming `owner_id`.
- **No CORS headers.** Not designed for browser callers; an open policy on a
  state-changing API is a risk rather than a convenience.
- **A lock that outlives `busy_timeout` is a 500.** If another writer holds the
  database for longer than 5 seconds, the request fails as `internal_error`. That
  is not input-driven, so it does not violate the no-500 rule above, but a `503`
  with `Retry-After` would describe it better.
- **Not hardened for the public internet.** There is no rate limiting, no
  authentication, and the service trusts `X-Owner-Id`. It is an internal service.

---

## Layout

```
src/
  server.js           entrypoint; binds a port, handles shutdown
  app.js              Express assembly; the only place framework behaviour is configured
  routes.js           the four bookmark endpoints and /health
  validation.js       total input validation; every function returns or throws AppError
  normalize-url.js    the repeat rule, and why each rule exists
  store.js            SQLite; the UNIQUE constraint that prevents duplicates
  errors.js           AppError hierarchy
  errors-middleware.js the single place a thrown value becomes a response
  config.js           every limit, in one place
test/
  malformed-input.test.js  the four cases from the brief, and their neighbours
  endpoints.test.js        one test per documented status code
  duplicates.test.js       the repeat rule, concurrency, and normalisation
  no-500.test.js           the general claim, fuzzed
  error-boundary.test.js   the paths a caller cannot reach
  store.test.js            persistence, capacity, ordering, connection settings
  helpers.js               boots the app on a real socket and drives it over HTTP
```

Tests drive the app over a real socket rather than by calling handlers directly.
It costs a little speed and buys the assurance that status codes, headers, the
body parser and the error boundary behave exactly as a caller will hit them.

---

## The database

SQLite, through Node's built-in `node:sqlite` — so there is no native module to
compile and `npm install` needs no build toolchain. Storage is the file named by
`DATABASE_FILE`, defaulting to `./bookmarks.db`. The schema is created on startup
if absent, so a fresh checkout needs no migration step.

### Schema

```sql
CREATE TABLE bookmarks (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,  -- insertion order, exact
  id             TEXT    NOT NULL UNIQUE,           -- public id (UUIDv4)
  owner_id       TEXT    NOT NULL,
  url            TEXT    NOT NULL,                  -- exactly as the caller sent it
  url_normalized TEXT    NOT NULL,                  -- the repeat key
  title          TEXT,
  created_at     TEXT    NOT NULL,                  -- ISO 8601 UTC
  updated_at     TEXT    NOT NULL,
  UNIQUE (owner_id, url_normalized)                 -- the repeat rule
);

CREATE INDEX idx_bookmarks_owner_seq ON bookmarks (owner_id, seq DESC);
```

Two details that are load-bearing:

- **`url` and `url_normalized` are stored separately.** A caller gets back the URL
  they sent, not a normalised rewrite of it. The normalised form exists only to
  answer "have I already saved this?", and is never served. Confining it to one
  column means a change to the normalisation rules cannot accidentally alter data
  a caller can see.
- **Ordering is on `seq`, not `created_at`.** Timestamps have millisecond
  resolution, so two bookmarks created in the same millisecond would tie, and
  pagination would be non-deterministic. `seq` is the autoincrement rowid, so
  order is exact and total even when the clock does not move — a case the test
  suite covers with an injected frozen clock.

### Connection settings

| Setting                      | Why                                                                     |
| ---------------------------- | ----------------------------------------------------------------------- |
| `busy_timeout = 5000`        | Wait for a contended lock instead of failing instantly                   |
| `journal_mode = WAL`         | Readers proceed during a write instead of blocking behind it            |
| `foreign_keys = ON`          | Off by default in SQLite; enforcing the schema's stated intent          |

`busy_timeout` is the one that was missing, and it mattered. SQLite's default is
to fail **immediately** with `SQLITE_BUSY`, so any two overlapping writes — a
second process on the same file, a backup tool taking a read lock — became a
failed request instead of a slightly slower one. Measured before the fix, a
contended write failed in **0.2 ms**; with the timeout it waits for the holder and
succeeds.

Both behaviours are pinned by tests in `test/store.test.js`, including a control
that runs the same contended write with the timeout disabled, so the setting
cannot silently stop mattering.

`WAL` is skipped for in-memory databases, where there is no file to log. Those
files are git-ignored: the `-wal` and `-shm` companions are SQLite's write-ahead
log and shared-memory index, and appear whenever the database is open.

### How the data layer is written

- **Every value is a bound parameter.** No caller-supplied string is ever
  concatenated into a statement — including in error messages, which quote user
  input but travel as bound values too.
- **Statements are prepared once at call time** and reused within a call; there is
  no string-built SQL anywhere in the codebase.
- **Writes are transactional.** `create` uses `BEGIN IMMEDIATE` so the capacity
  check and the insert cannot interleave with another writer, and rolls back on
  any failure without masking the original error.
- **The owner predicate is mandatory and has no default** on `listByOwner` and
  `findById`. There is no code path that can read a bookmark without naming an
  owner, which makes cross-owner leakage impossible by omission rather than by
  review.

