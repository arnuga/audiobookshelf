# Audiobookshelf fork: ratings, reviews, friends, Goodreads/Hardcover sync

Personal fork of advplyr/audiobookshelf. Changes are not sent upstream, but upstream
releases are merged in regularly, so keep our changes easy to merge.

## Working rules

- **Test-driven, always.** Write the failing test first, run it, then implement. No feature lands without tests.
- **Minimal edits to upstream files.** Put fork code in new files; mark each touch point in an
  existing file with a `// Fork addition:` (or `<!-- Fork addition: -->`) comment.
- **No migrations for new tables.** `sequelize.sync()` in `Database.buildModels()` creates missing
  tables on startup. Migrations here are keyed to the upstream version number, which the fork keeps,
  so a fork migration would not run when expected. Only add a migration if altering an existing upstream table.
- **Never modify the live Audiobookshelf database.** Test against a copied config folder.
- **Goodreads has no API.** No login/scraping bots (terms of service, account lock risk).
  Pull via CSV export or public shelf RSS; push via a Goodreads-format CSV the user uploads.
- Progress sync to Hardcover is handled by ShelfBridge (separate container); don't duplicate it.

## Commands (Windows / PowerShell)

```powershell
npm ci; npm test                      # server: mocha, run from repo root
cd client; npm ci; npm test           # client: Cypress component tests (Chrome)
npx prettier --check --end-of-line auto <files>   # repo has .prettierrc; core.autocrlf=true checks out CRLF
```

Chrome is not installed on this PC, so `npm test` in `client` fails to start. Run the component tests in Electron:
`npm run compile-tailwind; npx cypress run --component --browser electron`.

Server tests live in `test/server/**` and build via `npm test` (tsc to dist-server, then mocha).
Client component tests live in `client/cypress/tests/components/**`; `cy.get('&name')` selects `[cy-id="name"]`.

## Status

### Phase 1: own rating and review (done, branch `ratings-reviews`)
- Model `server/models/UserBookReview.js`, table `userBookReviews`
  (userId, bookId, rating 0.5–5 in 0.5 steps, review text; unique per user+book; cascades on user/book delete).
- `server/controllers/ReviewController.js`: `GET|PUT|DELETE /api/items/:id/review`.
  Own middleware: requires library access only, not the "update" permission. Books only (podcasts → 400).
  PUT: omitted fields unchanged, null clears, clearing both deletes the row.
- `client/components/widgets/MyReview.vue` on `client/pages/item/_id/index.vue`. Strings in `client/strings/en-us.json`.
- Baseline: 394 server tests passing (366 upstream + 28 fork).

### Phase 2: other readers on this server (done, branch `ratings-reviews`)
- `UserBookReview.getReaderActivity(bookId, excludeUserId)`: one entry per active user (not the requester)
  who reviewed the book or started/finished it, merged from `userBookReviews` and `mediaProgresses`,
  newest first. Progress is 1 when finished, else currentTime/duration, else ebookProgress.
- `GET /api/items/:id/reviews` -> `{ libraryItemId, readers: [...] }`, same middleware as phase 1.
- `client/components/widgets/OtherReaders.vue` below the description on the book page; hidden when empty.
- Every user who can open a book sees every other active user's activity on it. There is no opt-out yet.
- Totals: 407 server tests, 122 client component tests.

### Phases 3 and 4: Goodreads CSV import and export (done, branch `ratings-reviews`)
- `server/utils/goodreads.js`: CSV parser, Goodreads export parser, ISBN-10/13 normalizer, matcher, import-file writer.
  Matching: ISBN (book.isbn, plus book.asin when it is an ISBN-10), then normalized title + exact normalized author;
  more than one candidate is reported as ambiguous, never guessed.
- `server/controllers/GoodreadsController.js`:
  `POST /api/me/goodreads/import { csv, apply }` previews unless `apply: true`. Fills gaps only: existing ratings/reviews
  are kept (reported as notes), finished books keep their date, only the `read` shelf marks finished
  (date read, else date added). Idempotent. Only books the user can access are matched.
  `GET /api/me/goodreads/export`: rated, reviewed, finished or started books; half stars round up.
- `client/components/widgets/GoodreadsSync.vue` in a Goodreads section on `client/pages/account.vue` (not for guests).
- Not done: Goodreads shelf RSS import (needs a profile URL setting and a scheduled fetch).
- Totals: 437 server tests, 128 client component tests.

### Next phases
5. Hardcover two-way sync of ratings and reviews, plus Hardcover friends.
6. Goodreads friends with public profiles via shelf RSS.

## Deployment (Synology NAS)

Runs as container `audiobookshelf-fork` on the Synology at 192.168.88.194 (x86_64, Container Manager).
`ssh djshultz@192.168.88.194` uses this PC's `id_ed25519` key; djshultz is in the `docker` group
(prefix remote commands with `export PATH=$PATH:/usr/local/bin`).

- Port 13378 -> 80; `/volume1/docker/audiobookshelf` -> `/config`, `/volume1/metadata/audiobookshelf` -> `/metadata`,
  `/volume2/audiobooks` -> `/audiobooks`; restart always; `JWT_SECRET_KEY` env (copy from the running container, never hard-code).
- Update: `docker build --platform linux/amd64 -t audiobookshelf-fork:ratings-reviews -t audiobookshelf-fork:<sha> .`,
  `docker save ... | gzip`, copy and `docker load` on the NAS, back up config + metadata to
  `/volume1/docker/backups/audiobookshelf-<date>-<reason>/` with the container stopped, then recreate the container.
  Get the user's OK before stopping or replacing the live container.
- The original upstream container `audiobookshelf` (advplyr/audiobookshelf) is kept stopped with restart=no as a fallback.
  First swap backup: `/volume1/docker/backups/audiobookshelf-2026-11-02-pre-fork/`.

## About the user
Likes analogies when learning new concepts, prefers newer tech, and wants things correct or easy.
