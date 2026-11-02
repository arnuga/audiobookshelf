const { expect } = require('chai')
const { Sequelize } = require('sequelize')
const sinon = require('sinon')

const Database = require('../../../server/Database')
const ApiRouter = require('../../../server/routers/ApiRouter')
const ApiCacheManager = require('../../../server/managers/ApiCacheManager')
const Auth = require('../../../server/Auth')
const Logger = require('../../../server/Logger')
const ReviewController = require('../../../server/controllers/ReviewController')

function fakeRes() {
  const res = {}
  res.status = sinon.stub().returns(res)
  res.send = sinon.spy()
  res.json = sinon.spy()
  res.sendStatus = sinon.spy()
  return res
}

describe('ReviewController', () => {
  let apiRouter
  let user
  let library
  let book
  let libraryItem

  beforeEach(async () => {
    global.ServerSettings = {}
    Database.sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
    Database.sequelize.uppercaseFirst = (str) => (str ? `${str[0].toUpperCase()}${str.substr(1)}` : '')
    await Database.buildModels()

    apiRouter = new ApiRouter({ auth: new Auth(), apiCacheManager: new ApiCacheManager() })
    sinon.stub(Logger, 'warn')

    // A regular user: no "update" permission, which rating must not require
    user = await Database.userModel.create({ username: 'reader', type: 'user', permissions: Database.userModel.getDefaultPermissionsForUserType('user') })
    library = await Database.libraryModel.create({ name: 'Books', mediaType: 'book' })
    const folder = await Database.libraryFolderModel.create({ path: '/books', libraryId: library.id })
    book = await Database.bookModel.create({ title: 'Dune', audioFiles: [], tags: [], narrators: [], genres: [], chapters: [] })
    libraryItem = await Database.libraryItemModel.create({ libraryFiles: [], mediaId: book.id, mediaType: 'book', libraryId: library.id, libraryFolderId: folder.id })
  })

  afterEach(async () => {
    sinon.restore()
    await Database.sequelize.sync({ force: true })
  })

  async function reqFor(body) {
    return { user, body, params: { id: libraryItem.id }, libraryItem: await Database.libraryItemModel.getExpandedById(libraryItem.id) }
  }

  describe('routes', () => {
    it('registers GET, PUT and DELETE /items/:id/review', () => {
      // ApiRouter.router is an Express 4 app; its routes live on _router.stack
      const routes = apiRouter.router._router.stack.filter((l) => l.route?.path === '/items/:id/review').flatMap((l) => Object.keys(l.route.methods))
      expect(routes).to.have.members(['get', 'put', 'delete'])
    })
  })

  describe('middleware', () => {
    it('404s for an unknown item', async () => {
      const res = fakeRes()
      const next = sinon.spy()
      await ReviewController.middleware.bind(apiRouter)({ user, params: { id: 'nope' }, method: 'GET' }, res, next)
      expect(res.sendStatus.calledWith(404)).to.be.true
      expect(next.called).to.be.false
    })

    it('403s when the user cannot access the library', async () => {
      await user.update({ permissions: { ...user.permissions, accessAllLibraries: false, librariesAccessible: [] } })
      const res = fakeRes()
      const next = sinon.spy()
      await ReviewController.middleware.bind(apiRouter)({ user, params: { id: libraryItem.id }, method: 'PUT' }, res, next)
      expect(res.sendStatus.calledWith(403)).to.be.true
      expect(next.called).to.be.false
    })

    it('lets a user without update permission rate a book', async () => {
      const res = fakeRes()
      const next = sinon.spy()
      const req = { user, params: { id: libraryItem.id }, method: 'PUT' }
      await ReviewController.middleware.bind(apiRouter)(req, res, next)
      expect(next.calledOnce).to.be.true
      expect(req.libraryItem.id).to.equal(libraryItem.id)
    })

    it('400s for podcasts', async () => {
      const podcastLibrary = await Database.libraryModel.create({ name: 'Pods', mediaType: 'podcast' })
      const folder = await Database.libraryFolderModel.create({ path: '/pods', libraryId: podcastLibrary.id })
      const podcast = await Database.podcastModel.create({ title: 'Pod', tags: [], genres: [], coverPath: null })
      const podItem = await Database.libraryItemModel.create({ libraryFiles: [], mediaId: podcast.id, mediaType: 'podcast', libraryId: podcastLibrary.id, libraryFolderId: folder.id })

      const res = fakeRes()
      const next = sinon.spy()
      await ReviewController.middleware.bind(apiRouter)({ user, params: { id: podItem.id }, method: 'GET' }, res, next)
      expect(res.status.calledWith(400)).to.be.true
      expect(next.called).to.be.false
    })
  })

  describe('GET /items/:id/review', () => {
    it('returns null when the user has not reviewed the book', async () => {
      const res = fakeRes()
      await ReviewController.getMine.bind(apiRouter)(await reqFor(), res)
      expect(res.json.calledWith(null)).to.be.true
    })

    it('returns only the current user’s review', async () => {
      const other = await Database.userModel.create({ username: 'friend', type: 'user', permissions: Database.userModel.getDefaultPermissionsForUserType('user') })
      await Database.userBookReviewModel.saveForUser(other.id, book.id, { rating: 1 })
      await Database.userBookReviewModel.saveForUser(user.id, book.id, { rating: 5 })

      const res = fakeRes()
      await ReviewController.getMine.bind(apiRouter)(await reqFor(), res)
      expect(res.json.firstCall.args[0]).to.include({ userId: user.id, rating: 5, libraryItemId: libraryItem.id })
    })
  })

  describe('PUT /items/:id/review', () => {
    it('saves a rating and review', async () => {
      const res = fakeRes()
      await ReviewController.saveMine.bind(apiRouter)(await reqFor({ rating: 4.5, review: 'Excellent' }), res)
      expect(res.json.firstCall.args[0]).to.include({ rating: 4.5, review: 'Excellent', userId: user.id })
    })

    it('400s on an invalid rating and saves nothing', async () => {
      const res = fakeRes()
      await ReviewController.saveMine.bind(apiRouter)(await reqFor({ rating: 7 }), res)
      expect(res.status.calledWith(400)).to.be.true
      expect(await Database.userBookReviewModel.count()).to.equal(0)
    })

    it('returns null after clearing everything', async () => {
      await Database.userBookReviewModel.saveForUser(user.id, book.id, { rating: 3 })
      const res = fakeRes()
      await ReviewController.saveMine.bind(apiRouter)(await reqFor({ rating: null }), res)
      expect(res.json.calledWith(null)).to.be.true
    })
  })

  describe('DELETE /items/:id/review', () => {
    it('removes the current user’s review only', async () => {
      const other = await Database.userModel.create({ username: 'friend', type: 'user', permissions: Database.userModel.getDefaultPermissionsForUserType('user') })
      await Database.userBookReviewModel.saveForUser(other.id, book.id, { rating: 1 })
      await Database.userBookReviewModel.saveForUser(user.id, book.id, { rating: 5 })

      const res = fakeRes()
      await ReviewController.deleteMine.bind(apiRouter)(await reqFor(), res)
      expect(res.sendStatus.calledWith(200)).to.be.true
      const remaining = await Database.userBookReviewModel.findAll()
      expect(remaining.map((r) => r.userId)).to.deep.equal([other.id])
    })
  })
})
