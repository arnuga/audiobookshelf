/**
 * Fork addition: the few Hardcover calls the sync needs, in plain shapes, on top of the official SDK.
 * The SDK paces requests to the rate limit and retries reads, so callers only handle the errors it raises.
 *
 * Token scopes used: read:me:content, read:library, write:library, write:reviews, read:catalog, read:social.
 */

const { HardcoverClient, UserBookStatus } = require('@hardcover/sdk')
const { version } = require('../../package.json')

const CHANGES_PAGE_SIZE = 100

/**
 * @typedef RemoteEntry
 * @property {number} userBookId the library entry id
 * @property {number} hardcoverBookId
 * @property {number} statusId 1 want to read, 2 reading, 3 read, 4 paused, 5 did not finish
 * @property {number|null} rating
 * @property {boolean} hasReview
 * @property {string|null|undefined} review undefined when the call did not include the text
 * @property {string|null} updatedAt
 * @property {string|null} title
 * @property {string[]} authors
 * @property {string|null} isbn10
 * @property {string|null} isbn13
 * @property {string|null} asin
 *
 * @typedef FriendEntry
 * @property {number} hardcoverUserId
 * @property {string|null} username
 * @property {string|null} name
 * @property {number} statusId
 * @property {number|null} rating
 * @property {string|null} review
 * @property {string|null} updatedAt
 */

/**
 * @param {*} row a user_books row from the SDK
 * @returns {RemoteEntry}
 */
function toRemoteEntry(row) {
  const contributors = Array.isArray(row.book?.cachedContributors) ? row.book.cachedContributors : []
  return {
    userBookId: row.id,
    hardcoverBookId: row.bookId,
    statusId: row.statusId,
    rating: row.rating ?? null,
    hasReview: !!row.hasReview,
    review: row.reviewMarkdown,
    updatedAt: row.updatedAt ?? null,
    title: row.book?.title ?? null,
    authors: contributors.filter((c) => !c.contribution && c.author?.name).map((c) => c.author.name),
    isbn10: row.edition?.isbn10 ?? null,
    isbn13: row.edition?.isbn13 ?? null,
    asin: row.edition?.asin ?? null
  }
}

/**
 * @param {{ rating?: number|null, review?: string|null }} values
 */
function toPatch({ rating, review }) {
  const patch = {}
  if (rating !== undefined) patch.rating = rating
  if (review !== undefined) patch.review = { markdown: review }
  return patch
}

/**
 * @param {string} token a Hardcover personal access token
 * @param {Object} [options] for tests
 * @param {import('@hardcover/sdk').HardcoverClientOptions['transport']} [options.transport]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 */
function createHardcoverApi(token, { transport, sleep } = {}) {
  const client = new HardcoverClient({ token, userAgent: `audiobookshelf-fork/${version}`, transport, sleep })

  return {
    /** @returns {Promise<{ id: number, username: string|null }>} */
    async me() {
      const { id, username } = await client.me.get()
      return { id, username: username ?? null }
    },

    /**
     * Library entries changed since the cursor, oldest first. Review text is not included.
     *
     * @param {string|null} since
     * @returns {Promise<{ entries: RemoteEntry[], cursor: string|null, hasMore: boolean }>}
     */
    async libraryChanges(since) {
      const page = await client.library.changes({ since, limit: CHANGES_PAGE_SIZE })
      return { entries: page.items.map(toRemoteEntry), cursor: page.cursor, hasMore: page.hasMore }
    },

    /**
     * @param {number} hardcoverBookId
     * @returns {Promise<RemoteEntry|null>} with review text
     */
    async entryForBook(hardcoverBookId) {
      const row = await client.library.forBook(hardcoverBookId)
      return row ? toRemoteEntry(row) : null
    },

    /**
     * @param {string[]} isbns
     * @returns {Promise<Map<string, number>>} each ISBN found, mapped to the book of its most-read edition
     */
    async findBookIdsByIsbn(isbns) {
      const ids = new Map()
      for (const edition of await client.books.findByIsbn(isbns)) {
        for (const isbn of [edition.isbn13, edition.isbn10]) {
          if (isbn && !ids.has(isbn)) ids.set(isbn, edition.bookId)
        }
      }
      return ids
    },

    /**
     * Shelve a book as Read with a rating or review, as an import so followers' feeds stay quiet.
     *
     * @param {number} hardcoverBookId
     * @param {{ rating?: number|null, review?: string|null, finishedDate?: string }} values finishedDate is YYYY-MM-DD
     * @returns {Promise<RemoteEntry>}
     */
    async addEntry(hardcoverBookId, { finishedDate, ...values }) {
      const row = await client.library.add(hardcoverBookId, { status: UserBookStatus.Read, ...(finishedDate && { date: finishedDate }), ...toPatch(values), imported: true })
      return toRemoteEntry(row)
    },

    /**
     * @param {number} userBookId
     * @param {{ rating?: number|null, review?: string|null }} values only the fields given are changed
     * @returns {Promise<RemoteEntry>}
     */
    async updateEntry(userBookId, values) {
      return toRemoteEntry(await client.library.update(userBookId, toPatch(values)))
    },

    /**
     * Entries of people the user follows on Hardcover, for one book.
     *
     * @param {number} hardcoverBookId
     * @returns {Promise<FriendEntry[]>}
     */
    async friends(hardcoverBookId) {
      const rows = await client.books.friends(hardcoverBookId)
      return rows.map((row) => ({
        hardcoverUserId: row.user?.id ?? row.userId,
        username: row.user?.username ?? null,
        name: row.user?.name ?? null,
        statusId: row.statusId,
        rating: row.rating ?? null,
        review: row.reviewMarkdown ?? null,
        updatedAt: row.updatedAt ?? null
      }))
    }
  }
}

module.exports = { createHardcoverApi }
