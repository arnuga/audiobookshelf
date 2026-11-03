const { Request, Response } = require('express')
const { LRUCache } = require('lru-cache')
const { AuthenticationError, ScopeError } = require('@hardcover/sdk')
const Logger = require('../Logger')
const Database = require('../Database')
const HardcoverSyncManager = require('../managers/HardcoverSyncManager')
const { toIsbn13 } = require('../utils/goodreads')

const STATUS_NAMES = { 1: 'want-to-read', 2: 'reading', 3: 'read', 4: 'paused', 5: 'did-not-finish', 6: 'ignored' }
const MAX_TOKEN_LENGTH = 4000

/**
 * @typedef RequestUserObject
 * @property {import('../models/User')} user
 *
 * @typedef {Request & RequestUserObject} RequestWithUser
 *
 * @typedef RequestEntityObject
 * @property {import('../models/LibraryItem')} libraryItem
 *
 * @typedef {RequestWithUser & RequestEntityObject} RequestWithLibraryItem
 */

/**
 * Fork addition: connect a Hardcover account, sync ratings and reviews with it, and show friends' entries for a book.
 */
class HardcoverController {
  constructor() {
    this.syncManager = new HardcoverSyncManager()
    /** Friends' entries per user and book, so book pages don't spend the user's Hardcover request allowance */
    this.friendsCache = new LRUCache({ max: 500, ttl: 60 * 60 * 1000 })
  }

  /**
   * GET: /api/me/hardcover
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async getAccount(req, res) {
    const account = await Database.hardcoverAccountModel.findOne({ where: { userId: req.user.id } })
    res.json(account ? account.toJSONForAPI() : { connected: false })
  }

  /**
   * PUT: /api/me/hardcover
   * Body: { token }. Checks the token with Hardcover, saves it and starts a sync.
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async connect(req, res) {
    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : ''
    if (!token || token.length > MAX_TOKEN_LENGTH) return res.status(400).send('Paste a Hardcover API token')

    let account
    try {
      account = await controller.syncManager.connect(req.user.id, token)
    } catch (error) {
      if (error instanceof AuthenticationError) return res.status(400).send('Hardcover did not accept this token. Check it was copied in full and has not expired.')
      if (error instanceof ScopeError) return res.status(400).send(`This token is missing permissions: ${(error.missingScopes || []).join(', ')}`)
      Logger.error(`[HardcoverController] Failed to connect Hardcover for user "${req.user.username}": ${error.message}`)
      return res.status(502).send('Could not reach Hardcover')
    }

    Logger.info(`[HardcoverController] User "${req.user.username}" connected Hardcover account "${account.hardcoverUsername}"`)
    controller.syncManager.syncUser(req.user.id).catch((error) => Logger.error(`[HardcoverController] First sync failed for user "${req.user.username}": ${error.message}`))
    res.json(account.toJSONForAPI())
  }

  /**
   * DELETE: /api/me/hardcover
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async disconnect(req, res) {
    await controller.syncManager.disconnect(req.user.id)
    Logger.info(`[HardcoverController] User "${req.user.username}" disconnected Hardcover`)
    res.json({ connected: false })
  }

  /**
   * POST: /api/me/hardcover/sync
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async syncNow(req, res) {
    try {
      const summary = await controller.syncManager.syncUser(req.user.id)
      if (!summary) return res.sendStatus(404)
    } catch (error) {
      const account = await Database.hardcoverAccountModel.findOne({ where: { userId: req.user.id } })
      return res.status(502).send(account?.lastError || 'Sync failed')
    }
    const account = await Database.hardcoverAccountModel.findOne({ where: { userId: req.user.id } })
    res.json(account.toJSONForAPI())
  }

  /**
   * GET: /api/items/:id/hardcover-friends
   * Ratings and reviews of the people the user follows on Hardcover. Uses ReviewController.middleware.
   *
   * @param {RequestWithLibraryItem} req
   * @param {Response} res
   */
  async getFriends(req, res) {
    const account = await Database.hardcoverAccountModel.findOne({ where: { userId: req.user.id } })
    if (!account) return res.json({ connected: false, friends: [] })

    const book = req.libraryItem.media
    const cacheKey = `${req.user.id}:${book.id}`
    if (controller.friendsCache.has(cacheKey)) return res.json(controller.friendsCache.get(cacheKey))

    const api = controller.syncManager.createApi(account.token)
    try {
      const link = await Database.hardcoverBookLinkModel.findOne({ where: { userId: req.user.id, bookId: book.id } })
      let hardcoverBookId = link?.hardcoverBookId ?? null
      const isbn = toIsbn13(book.isbn) || toIsbn13(book.asin)
      if (!hardcoverBookId && isbn) hardcoverBookId = (await api.findBookIdsByIsbn([isbn])).get(isbn) ?? null

      const friends = hardcoverBookId ? await api.friends(hardcoverBookId) : []
      const result = {
        connected: true,
        hardcoverBookId,
        friends: friends.map(({ statusId, updatedAt, ...friend }) => ({ ...friend, status: STATUS_NAMES[statusId] || null, updatedAt: updatedAt ? Date.parse(updatedAt) : null }))
      }
      controller.friendsCache.set(cacheKey, result)
      res.json(result)
    } catch (error) {
      Logger.warn(`[HardcoverController] Failed to load Hardcover friends for "${book.title}": ${error.message}`)
      res.json({ connected: true, hardcoverBookId: null, friends: [], error: 'Could not reach Hardcover' })
    }
  }
}

// Handlers are bound to the ApiRouter, so they reach this instance through the module
const controller = new HardcoverController()
module.exports = controller
