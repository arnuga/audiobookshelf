const { Request, Response, NextFunction } = require('express')
const Logger = require('../Logger')
const Database = require('../Database')
const HardcoverController = require('./HardcoverController')

/**
 * @typedef RequestUserObject
 * @property {import('../models/User')} user
 *
 * @typedef RequestEntityObject
 * @property {import('../models/LibraryItem')} libraryItem
 *
 * @typedef {Request & RequestUserObject & RequestEntityObject} ReviewRequest
 */

/**
 * Fork addition: the current user's own rating and review of a book.
 */
class ReviewController {
  constructor() {}

  /**
   * GET: /api/items/:id/review
   *
   * @param {ReviewRequest} req
   * @param {Response} res
   */
  async getMine(req, res) {
    const review = await Database.userBookReviewModel.findOne({
      where: { userId: req.user.id, bookId: req.libraryItem.media.id }
    })
    res.json(review ? review.toJSONForAPI(req.libraryItem.id) : null)
  }

  /**
   * PUT: /api/items/:id/review
   * Body: { rating?: number|null, review?: string|null }. Omitted fields are unchanged; null clears.
   *
   * @param {ReviewRequest} req
   * @param {Response} res
   */
  async saveMine(req, res) {
    const payload = Database.userBookReviewModel.parsePayload(req.body)
    if (payload.error) {
      return res.status(400).send(payload.error)
    }
    const review = await Database.userBookReviewModel.saveForUser(req.user.id, req.libraryItem.media.id, payload)
    HardcoverController.syncManager.scheduleSync(req.user.id)
    res.json(review ? review.toJSONForAPI(req.libraryItem.id) : null)
  }

  /**
   * GET: /api/items/:id/reviews
   * Other users on this server who rated, reviewed, finished or started the book.
   *
   * @param {ReviewRequest} req
   * @param {Response} res
   */
  async getOthers(req, res) {
    const readers = await Database.userBookReviewModel.getReaderActivity(req.libraryItem.media.id, req.user.id)
    res.json({ libraryItemId: req.libraryItem.id, readers })
  }

  /**
   * DELETE: /api/items/:id/review
   *
   * @param {ReviewRequest} req
   * @param {Response} res
   */
  async deleteMine(req, res) {
    await Database.userBookReviewModel.destroy({
      where: { userId: req.user.id, bookId: req.libraryItem.media.id }
    })
    HardcoverController.syncManager.scheduleSync(req.user.id)
    res.sendStatus(200)
  }

  /**
   * Loads the library item and checks the user can see it.
   * Unlike LibraryItemController.middleware, this does not require the "update" permission:
   * rating a book is personal, not an edit to the library.
   *
   * @param {ReviewRequest} req
   * @param {Response} res
   * @param {NextFunction} next
   */
  async middleware(req, res, next) {
    req.libraryItem = await Database.libraryItemModel.getExpandedById(req.params.id)
    if (!req.libraryItem?.media) return res.sendStatus(404)

    if (!req.user.checkCanAccessLibraryItem(req.libraryItem)) {
      Logger.warn(`[ReviewController] User "${req.user.username}" attempted to access review for inaccessible item "${req.params.id}"`)
      return res.sendStatus(403)
    }

    if (req.libraryItem.mediaType !== 'book') {
      return res.status(400).send('Only books can be rated and reviewed')
    }

    next()
  }
}
module.exports = new ReviewController()
