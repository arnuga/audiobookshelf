const { Request, Response } = require('express')
const { Op } = require('sequelize')
const Logger = require('../Logger')
const Database = require('../Database')
const SocketAuthority = require('../SocketAuthority')
const goodreads = require('../utils/goodreads')

/**
 * @typedef RequestUserObject
 * @property {import('../models/User')} user
 *
 * @typedef {Request & RequestUserObject} RequestWithUser
 *
 * @typedef ImportRow
 * @property {number} row
 * @property {string} title
 * @property {string} author
 * @property {'matched'|'unmatched'|'ambiguous'} status
 * @property {'isbn'|'title-author'|null} matchMethod
 * @property {string|null} libraryItemId
 * @property {string|null} matchedTitle
 * @property {('rating'|'review'|'finished')[]} actions changes the import makes
 * @property {('rating-kept'|'review-kept'|'review-invalid')[]} notes Goodreads values that were not used
 */

/**
 * Fork addition: import the current user's Goodreads library export and export a Goodreads import file.
 */
class GoodreadsController {
  constructor() {}

  /**
   * POST: /api/me/goodreads/import
   * Body: { csv: string, apply?: boolean }. Without apply, nothing is written and the planned changes are returned.
   *
   * Only fills gaps: an existing Audiobookshelf rating or review is kept, finished books stay finished
   * with their own date, and only the "read" shelf marks books finished.
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async importCsv(req, res) {
    const parsed = goodreads.parseGoodreadsExport(typeof req.body?.csv === 'string' ? req.body.csv : '')
    if (parsed.error) return res.status(400).send(parsed.error)
    const apply = req.body.apply === true

    const match = goodreads.createMatcher(await loadAccessibleBooks(req.user))
    const reviews = await Database.userBookReviewModel.findAll({ where: { userId: req.user.id } })
    // Working copy of the user's state, updated as rows are planned, so two rows for one book don't both apply
    const reviewByBook = new Map(reviews.map((r) => [r.bookId, { rating: r.rating, review: r.review }]))
    const finishedBooks = new Set(req.user.mediaProgresses.filter((mp) => mp.isFinished).map((mp) => mp.mediaItemId))

    /** @type {ImportRow[]} */
    const rows = []
    for (const entry of parsed.entries) {
      const { book, method, ambiguous } = match(entry)
      /** @type {ImportRow} */
      const row = { row: entry.row, title: entry.title, author: entry.author, status: book ? 'matched' : ambiguous ? 'ambiguous' : 'unmatched', matchMethod: method, libraryItemId: book?.libraryItemId || null, matchedTitle: book?.title || null, actions: [], notes: [] }
      rows.push(row)
      if (!book) continue

      const current = reviewByBook.get(book.id) || { rating: null, review: null }
      const reviewPayload = {}
      if (entry.rating !== null) {
        if (current.rating === null) reviewPayload.rating = entry.rating
        else if (current.rating !== entry.rating) row.notes.push('rating-kept')
      }
      if (entry.review !== null) {
        const validated = Database.userBookReviewModel.parsePayload({ review: entry.review })
        if (validated.error) row.notes.push('review-invalid')
        else if (current.review === null) reviewPayload.review = validated.review
        else if (current.review !== validated.review) row.notes.push('review-kept')
      }
      row.actions.push(...Object.keys(reviewPayload))
      if (row.actions.length) reviewByBook.set(book.id, { ...current, ...reviewPayload })

      const markFinished = entry.shelf === 'read' && !finishedBooks.has(book.id)
      if (markFinished) {
        row.actions.push('finished')
        finishedBooks.add(book.id)
      }

      if (!apply) continue
      if (Object.keys(reviewPayload).length) {
        await Database.userBookReviewModel.saveForUser(req.user.id, book.id, reviewPayload)
      }
      if (markFinished) {
        const result = await req.user.createUpdateMediaProgressFromPayload({ libraryItemId: book.libraryItemId, isFinished: true, finishedAt: entry.dateRead || entry.dateAdded || new Date() })
        if (result.error) Logger.error(`[GoodreadsController] Failed to mark "${book.title}" finished: ${result.error}`)
      }
    }

    const matched = rows.filter((r) => r.status === 'matched').length
    const summary = { total: rows.length, matched, unmatched: rows.length - matched, changes: rows.reduce((total, r) => total + r.actions.length, 0) }
    if (apply) {
      Logger.info(`[GoodreadsController] User "${req.user.username}" imported Goodreads export: ${summary.matched}/${summary.total} matched, ${summary.changes} changes`)
      if (summary.changes) SocketAuthority.clientEmitter(req.user.id, 'user_updated', req.user.toOldJSONForBrowser())
    }
    res.json({ applied: apply, summary, rows })
  }

  /**
   * GET: /api/me/goodreads/export
   * Books the user rated, reviewed, finished or started, as a CSV for the Goodreads import page.
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async exportCsv(req, res) {
    const reviews = await Database.userBookReviewModel.findAll({ where: { userId: req.user.id } })
    const progressByBook = new Map(req.user.mediaProgresses.filter((mp) => mp.mediaItemType === 'book' && (mp.isFinished || mp.currentTime > 0 || mp.ebookProgress > 0)).map((mp) => [mp.mediaItemId, mp]))
    const reviewByBook = new Map(reviews.map((r) => [r.bookId, r]))
    const bookIds = [...new Set([...reviewByBook.keys(), ...progressByBook.keys()])]

    const books = await Database.bookModel.findAll({
      where: { id: { [Op.in]: bookIds } },
      attributes: ['id', 'title', 'isbn', 'asin'],
      include: { model: Database.authorModel, attributes: ['name'], through: { attributes: [] } }
    })

    const entries = books.map((book) => {
      const review = reviewByBook.get(book.id)
      const progress = progressByBook.get(book.id)
      const dates = [review?.createdAt, progress?.createdAt].filter(Boolean).map((d) => new Date(d))
      return {
        title: book.title,
        author: book.authors?.[0]?.name || '',
        isbn: goodreads.toIsbn13(book.isbn) ? book.isbn : book.asin,
        rating: review?.rating ?? null,
        review: review?.review ?? null,
        // A rating or review without progress means the book was read somewhere else
        shelf: !progress || progress.isFinished ? 'read' : 'currently-reading',
        dateRead: progress?.isFinished && progress.finishedAt ? new Date(progress.finishedAt) : null,
        dateAdded: dates.length ? new Date(Math.min(...dates)) : null
      }
    })
    entries.sort((a, b) => a.title.localeCompare(b.title))

    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', 'attachment; filename="audiobookshelf_goodreads_import.csv"')
    res.send(goodreads.buildGoodreadsCsv(entries))
  }
}

/**
 * Books in libraries and with tags the user can access, in the shape the matcher needs.
 *
 * @param {import('../models/User')} user
 * @returns {Promise<import('../utils/goodreads').MatchableBook[]>}
 */
async function loadAccessibleBooks(user) {
  const libraryItems = await Database.libraryItemModel.findAll({
    where: { mediaType: 'book' },
    // mediaId is the join key; LibraryItem's afterFind hook needs mediaType to move the book to .media
    attributes: ['id', 'libraryId', 'mediaId', 'mediaType'],
    include: {
      model: Database.bookModel,
      attributes: ['id', 'title', 'isbn', 'asin', 'explicit', 'tags'],
      include: { model: Database.authorModel, attributes: ['name'], through: { attributes: [] } }
    }
  })

  return libraryItems.filter((li) => li.media && user.checkCanAccessLibraryItem(li)).map((li) => ({ id: li.media.id, libraryItemId: li.id, title: li.media.title, isbn: li.media.isbn, asin: li.media.asin, authors: (li.media.authors || []).map((a) => a.name) }))
}

module.exports = new GoodreadsController()
