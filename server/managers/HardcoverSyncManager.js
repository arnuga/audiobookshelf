const cron = require('../libs/nodeCron')
const Logger = require('../Logger')
const Database = require('../Database')
const SocketAuthority = require('../SocketAuthority')
const { AuthenticationError, RateLimitError, ScopeError } = require('@hardcover/sdk')
const { createHardcoverApi } = require('../utils/hardcoverApi')
const { createMatcher, toIsbn13 } = require('../utils/goodreads')
const { normalizeRating, normalizeReview, planMerge } = require('../utils/hardcoverSync')
const { loadAccessibleBooks } = require('../utils/accessibleBooks')

const ISBN_LOOKUP_BATCH = 50

/**
 * @typedef SyncSummary
 * @property {number} remoteChanges Hardcover entries read from the change feed
 * @property {number} unmatched Hardcover entries with no matching book in the user's libraries
 * @property {number} pulled books updated in Audiobookshelf
 * @property {number} pushed books updated on Hardcover
 * @property {number} notOnHardcover reviewed books Hardcover could not find by ISBN
 * @property {number} failed books that could not be synced
 */

/**
 * Fork addition: two-way sync of each user's ratings and reviews with their Hardcover account.
 * Runs hourly, a few seconds after a review is saved, and on request. Reading progress is left to ShelfBridge.
 */
class HardcoverSyncManager {
  /** Edits are batched: a sync starts this long after the last save. */
  static SAVE_DELAY_MS = 10 * 1000

  /**
   * @param {Object} [options]
   * @param {typeof createHardcoverApi} [options.createApi] replaced in tests
   */
  constructor({ createApi = createHardcoverApi } = {}) {
    this.createApi = createApi
    /** @type {Map<string, Promise<SyncSummary|null>>} */
    this.running = new Map()
    /** @type {Map<string, NodeJS.Timeout>} */
    this.pendingSaves = new Map()
  }

  init() {
    cron.schedule('23 * * * *', () => this.syncAll())
  }

  /**
   * Check the token with Hardcover and store it. Connecting a different Hardcover account starts the sync over.
   *
   * @param {string} userId
   * @param {string} token
   * @returns {Promise<import('../models/HardcoverAccount')>}
   */
  async connect(userId, token) {
    const cleaned = token.trim()
    const me = await this.createApi(cleaned).me()

    const existing = await Database.hardcoverAccountModel.findOne({ where: { userId } })
    const values = { token: cleaned, hardcoverUserId: me.id, hardcoverUsername: me.username, lastError: null }
    if (existing && existing.hardcoverUserId === me.id) return existing.update(values)

    await Database.hardcoverBookLinkModel.destroy({ where: { userId } })
    if (existing) return existing.update({ ...values, cursor: null, lastSyncAt: null, lastSummary: null })
    return Database.hardcoverAccountModel.create({ userId, ...values })
  }

  /**
   * @param {string} userId
   */
  async disconnect(userId) {
    await Database.hardcoverBookLinkModel.destroy({ where: { userId } })
    await Database.hardcoverAccountModel.destroy({ where: { userId } })
  }

  /**
   * Sync soon, once edits stop coming in.
   *
   * @param {string} userId
   */
  scheduleSync(userId) {
    clearTimeout(this.pendingSaves.get(userId))
    const timer = setTimeout(() => {
      this.pendingSaves.delete(userId)
      this.syncUser(userId).catch((error) => Logger.error(`[HardcoverSyncManager] Sync after save failed for user "${userId}": ${error.message}`))
    }, HardcoverSyncManager.SAVE_DELAY_MS)
    timer.unref?.()
    this.pendingSaves.set(userId, timer)
  }

  async syncAll() {
    const accounts = await Database.hardcoverAccountModel.findAll({ attributes: ['userId'] })
    for (const { userId } of accounts) {
      await this.syncUser(userId).catch((error) => Logger.error(`[HardcoverSyncManager] Hourly sync failed for user "${userId}": ${error.message}`))
    }
  }

  /**
   * Sync one user. A call while that user's sync is running gets the running one.
   *
   * @param {string} userId
   * @returns {Promise<SyncSummary|null>} null when the user has not connected Hardcover
   */
  syncUser(userId) {
    if (!this.running.has(userId)) {
      const run = this.#sync(userId).finally(() => this.running.delete(userId))
      this.running.set(userId, run)
    }
    return this.running.get(userId)
  }

  /**
   * @param {string} userId
   * @returns {Promise<SyncSummary|null>}
   */
  async #sync(userId) {
    const account = await Database.hardcoverAccountModel.findOne({ where: { userId } })
    if (!account) return null

    try {
      const summary = await this.#syncAccount(account)
      Logger.info(`[HardcoverSyncManager] Synced user "${userId}" with Hardcover: ${JSON.stringify(summary)}`)
      if (summary.pulled) SocketAuthority.clientEmitter(userId, 'hardcover_synced', summary)
      return summary
    } catch (error) {
      await account.update({ lastError: describeError(error), lastSyncAt: new Date() })
      throw error
    }
  }

  /**
   * @param {import('../models/HardcoverAccount')} account
   * @returns {Promise<SyncSummary>}
   */
  async #syncAccount(account) {
    const { userId } = account
    const api = this.createApi(account.token)
    /** @type {SyncSummary} */
    const summary = { remoteChanges: 0, unmatched: 0, pulled: 0, pushed: 0, notOnHardcover: 0, failed: 0 }

    const user = await Database.userModel.getUserById(userId)
    const books = user ? await loadAccessibleBooks(user) : []
    const bookById = new Map(books.map((book) => [book.id, book]))
    const match = createMatcher(books)
    const links = (await Database.hardcoverBookLinkModel.findAll({ where: { userId } })).filter((link) => bookById.has(link.bookId))
    const linkByBook = new Map(links.map((link) => [link.bookId, link]))
    const bookByHardcoverId = new Map(links.map((link) => [link.hardcoverBookId, link.bookId]))
    const reviews = await Database.userBookReviewModel.findAll({ where: { userId } })
    const reviewByBook = new Map(reviews.filter((review) => bookById.has(review.bookId)).map((review) => [review.bookId, review]))

    // Hardcover side: everything changed since the last sync
    const isFirstSync = !account.cursor
    let cursor = account.cursor
    /** @type {Map<string, import('../utils/hardcoverApi').RemoteEntry>} */
    const remoteByBook = new Map()
    let page
    do {
      page = await api.libraryChanges(cursor)
      cursor = page.cursor
      for (const entry of page.entries) {
        summary.remoteChanges++
        const bookId = bookByHardcoverId.get(entry.hardcoverBookId) ?? matchEntry(match, entry)
        if (!bookId) {
          summary.unmatched++
          continue
        }
        // Our own writes come back in the feed; skip what this server already synced
        const syncedAt = linkByBook.get(bookId)?.syncedAt
        if (syncedAt && entry.updatedAt && new Date(entry.updatedAt) <= syncedAt) continue
        remoteByBook.set(bookId, entry)
      }
    } while (page.hasMore)

    // Audiobookshelf side: reviews that differ from the last sync, including ones cleared since
    const bookIds = new Set(remoteByBook.keys())
    for (const [bookId, review] of reviewByBook) {
      const link = linkByBook.get(bookId)
      if (!link || !sameValues(review, link.base)) bookIds.add(bookId)
    }
    for (const link of links) {
      if (!reviewByBook.has(link.bookId) && !sameValues(null, link.base)) bookIds.add(link.bookId)
    }

    // Books never synced need their Hardcover id, found by ISBN
    /** @type {Map<string, number>} */
    const hardcoverIdByBook = new Map()
    for (const [bookId, entry] of remoteByBook) hardcoverIdByBook.set(bookId, entry.hardcoverBookId)
    for (const link of links) hardcoverIdByBook.set(link.bookId, link.hardcoverBookId)
    const lookups = [...bookIds].filter((bookId) => !hardcoverIdByBook.has(bookId)).map((bookId) => ({ bookId, isbn: toIsbn13(bookById.get(bookId).isbn) || toIsbn13(bookById.get(bookId).asin) }))
    for (let i = 0; i < lookups.length; i += ISBN_LOOKUP_BATCH) {
      const batch = lookups.slice(i, i + ISBN_LOOKUP_BATCH).filter((lookup) => lookup.isbn)
      if (!batch.length) continue
      const found = await api.findBookIdsByIsbn(batch.map((lookup) => lookup.isbn))
      for (const { bookId, isbn } of batch) {
        if (found.has(isbn)) hardcoverIdByBook.set(bookId, found.get(isbn))
      }
    }

    for (const bookId of bookIds) {
      const hardcoverBookId = hardcoverIdByBook.get(bookId)
      if (!hardcoverBookId) {
        summary.notOnHardcover++
        continue
      }
      try {
        const result = await this.#syncBook({ api, userId, bookId, hardcoverBookId, remote: remoteByBook.get(bookId), review: reviewByBook.get(bookId), link: linkByBook.get(bookId), isFirstSync })
        if (result.pulled) summary.pulled++
        if (result.pushed) summary.pushed++
      } catch (error) {
        if (isAccountError(error)) throw error
        summary.failed++
        Logger.error(`[HardcoverSyncManager] Failed to sync "${bookById.get(bookId).title}" for user "${userId}": ${error.message}`)
      }
    }

    await account.update({ cursor, lastSyncAt: new Date(), lastError: null, lastSummary: summary })
    return summary
  }

  /**
   * Merge one book and record what both sides now hold.
   *
   * @param {Object} params
   * @param {ReturnType<typeof createHardcoverApi>} params.api
   * @param {string} params.userId
   * @param {string} params.bookId
   * @param {number} params.hardcoverBookId
   * @param {import('../utils/hardcoverApi').RemoteEntry} [params.remote] the entry from the change feed
   * @param {import('../models/UserBookReview')} [params.review]
   * @param {import('../models/HardcoverBookLink')} [params.link]
   * @param {boolean} params.isFirstSync the change feed then held the whole shelf, so a book missing from it is not on the shelf
   * @returns {Promise<{ pulled: boolean, pushed: boolean }>}
   */
  async #syncBook({ api, userId, bookId, hardcoverBookId, remote, review, link, isFirstSync }) {
    let entry = remote ?? null
    if (entry ? entry.hasReview && entry.review === undefined : !isFirstSync) {
      entry = await api.entryForBook(hardcoverBookId)
    }

    const local = review ? { rating: review.rating, review: review.review, updatedAt: review.updatedAt } : null
    const plan = planMerge({ local, remote: entry, base: link?.base ?? null })
    const pulled = Object.keys(plan.pull).length > 0
    let pushed = false
    let userBookId = entry?.userBookId ?? null

    if (pulled) await Database.userBookReviewModel.saveForUser(userId, bookId, plan.pull)
    if (Object.keys(plan.push).length) {
      if (entry) {
        await api.updateEntry(entry.userBookId, plan.push)
        pushed = true
      } else if (Object.values(plan.push).some((value) => value !== null)) {
        const finishedDate = await this.#finishedDate(userId, bookId)
        const added = await api.addEntry(hardcoverBookId, { ...plan.push, ...(finishedDate && { finishedDate }) })
        userBookId = added.userBookId
        pushed = true
      }
    }

    const values = { hardcoverBookId, userBookId, syncedRating: plan.base.rating, syncedReview: plan.base.review, syncedAt: new Date() }
    if (link) await link.update(values)
    else await Database.hardcoverBookLinkModel.create({ userId, bookId, ...values })
    return { pulled, pushed }
  }

  /**
   * @param {string} userId
   * @param {string} bookId
   * @returns {Promise<string|null>} YYYY-MM-DD the user finished the book in Audiobookshelf
   */
  async #finishedDate(userId, bookId) {
    const progress = await Database.mediaProgressModel.findOne({ where: { userId, mediaItemId: bookId, isFinished: true } })
    return progress?.finishedAt ? new Date(progress.finishedAt).toISOString().slice(0, 10) : null
  }
}

/**
 * @param {ReturnType<typeof createMatcher>} match
 * @param {import('../utils/hardcoverApi').RemoteEntry} entry
 * @returns {string|null} library book id
 */
function matchEntry(match, entry) {
  const isbn10 = entry.isbn10 || (toIsbn13(entry.asin) ? entry.asin : null)
  for (const author of entry.authors.length ? entry.authors : ['']) {
    const { book } = match({ isbn10, isbn13: entry.isbn13, title: entry.title || '', author })
    if (book) return book.id
  }
  return null
}

/**
 * @param {{ rating: number|null, review: string|null }|null} values
 * @param {{ rating: number|null, review: string|null }} base
 */
function sameValues(values, base) {
  return normalizeRating(values?.rating) === normalizeRating(base.rating) && normalizeReview(values?.review) === normalizeReview(base.review)
}

/**
 * Errors that stop the whole sync rather than one book.
 *
 * @param {Error} error
 */
function isAccountError(error) {
  return error instanceof AuthenticationError || error instanceof ScopeError || error instanceof RateLimitError
}

/**
 * @param {Error} error
 * @returns {string} shown on the Account page
 */
function describeError(error) {
  if (error instanceof AuthenticationError) return 'Hardcover rejected the token. It may have expired; create a new one and connect again.'
  if (error instanceof ScopeError) return `The Hardcover token is missing permissions: ${(error.missingScopes || []).join(', ')}`
  if (error instanceof RateLimitError) return 'Hardcover daily request limit reached. The next sync will continue.'
  return error.message || 'Sync failed'
}

module.exports = HardcoverSyncManager
