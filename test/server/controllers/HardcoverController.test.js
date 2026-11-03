const { expect } = require('chai')
const { Sequelize } = require('sequelize')
const sinon = require('sinon')
const { AuthenticationError } = require('@hardcover/sdk')

const Database = require('../../../server/Database')
const ApiRouter = require('../../../server/routers/ApiRouter')
const ApiCacheManager = require('../../../server/managers/ApiCacheManager')
const Auth = require('../../../server/Auth')
const Logger = require('../../../server/Logger')
const HardcoverController = require('../../../server/controllers/HardcoverController')
const ReviewController = require('../../../server/controllers/ReviewController')
const HardcoverSyncManager = require('../../../server/managers/HardcoverSyncManager')

function fakeRes() {
  const res = {}
  res.status = sinon.stub().returns(res)
  res.send = sinon.spy()
  res.json = sinon.spy()
  res.sendStatus = sinon.spy()
  return res
}

describe('HardcoverController', () => {
  let apiRouter
  let user
  let dune
  let duneItem
  let api
  let originalManager

  async function connect() {
    await Database.hardcoverAccountModel.create({ userId: user.id, token: 'hc_pat_secret', hardcoverUserId: 42, hardcoverUsername: 'hc_reader' })
  }

  async function call(handler, req) {
    const res = fakeRes()
    await handler.bind(apiRouter)({ user, params: {}, body: {}, ...req }, res)
    return res
  }

  beforeEach(async () => {
    global.ServerSettings = {}
    Database.sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
    Database.sequelize.uppercaseFirst = (str) => (str ? `${str[0].toUpperCase()}${str.substr(1)}` : '')
    await Database.buildModels()

    apiRouter = new ApiRouter({ auth: new Auth(), apiCacheManager: new ApiCacheManager() })
    sinon.stub(Logger, 'info')
    sinon.stub(Logger, 'warn')
    sinon.stub(Logger, 'error')

    user = await Database.userModel.create({ username: 'reader', type: 'user', isActive: true, permissions: Database.userModel.getDefaultPermissionsForUserType('user') })
    const library = await Database.libraryModel.create({ name: 'Books', mediaType: 'book' })
    const folder = await Database.libraryFolderModel.create({ path: '/books', libraryId: library.id })
    dune = await Database.bookModel.create({ title: 'Dune', isbn: '9780441172719', audioFiles: [], tags: [], narrators: [], genres: [], chapters: [] })
    duneItem = await Database.libraryItemModel.create({ libraryFiles: [], mediaId: dune.id, mediaType: 'book', libraryId: library.id, libraryFolderId: folder.id })

    api = {
      me: sinon.stub().resolves({ id: 42, username: 'hc_reader' }),
      libraryChanges: sinon.stub().resolves({ entries: [], cursor: 'c', hasMore: false }),
      findBookIdsByIsbn: sinon.stub().resolves(new Map([['9780441172719', 100]])),
      friends: sinon.stub().resolves([{ hardcoverUserId: 5, username: 'pal', name: 'Pal', statusId: 3, rating: 4, review: 'Good', updatedAt: '2026-03-01T00:00:00+00:00' }])
    }
    originalManager = HardcoverController.syncManager
    HardcoverController.syncManager = new HardcoverSyncManager({ createApi: () => api })
    HardcoverController.friendsCache.clear()
  })

  afterEach(async () => {
    HardcoverController.syncManager = originalManager
    sinon.restore()
    await Database.sequelize.sync({ force: true })
  })

  describe('routes', () => {
    it('registers the account, sync and friends endpoints', () => {
      const routes = apiRouter.router._router.stack.filter((l) => typeof l.route?.path === 'string' && /hardcover/.test(l.route.path)).map((l) => `${Object.keys(l.route.methods)[0]} ${l.route.path}`)
      expect(routes).to.have.members(['get /me/hardcover', 'put /me/hardcover', 'delete /me/hardcover', 'post /me/hardcover/sync', 'get /items/:id/hardcover-friends'])
    })
  })

  describe('getAccount', () => {
    it('reports not connected', async () => {
      const res = await call(HardcoverController.getAccount)
      expect(res.json.firstCall.args[0]).to.deep.equal({ connected: false })
    })

    it('never sends the token back', async () => {
      await connect()
      const res = await call(HardcoverController.getAccount)
      const body = res.json.firstCall.args[0]
      expect(body).to.include({ connected: true, hardcoverUsername: 'hc_reader' })
      expect(JSON.stringify(body)).not.to.contain('hc_pat_secret')
    })
  })

  describe('connect', () => {
    it('saves a working token and starts a sync', async () => {
      const syncUser = sinon.stub(HardcoverController.syncManager, 'syncUser').resolves({})
      const res = await call(HardcoverController.connect, { body: { token: 'hc_pat_new' } })
      expect(res.json.firstCall.args[0]).to.include({ connected: true, hardcoverUsername: 'hc_reader' })
      expect(JSON.stringify(res.json.firstCall.args[0])).not.to.contain('hc_pat_new')
      expect(syncUser.calledOnceWith(user.id)).to.equal(true)
    })

    it('rejects a missing token', async () => {
      const res = await call(HardcoverController.connect, { body: { token: '  ' } })
      expect(res.status.calledWith(400)).to.equal(true)
    })

    it('explains a token Hardcover refuses', async () => {
      api.me.rejects(new AuthenticationError('invalid_token'))
      const res = await call(HardcoverController.connect, { body: { token: 'hc_pat_bad' } })
      expect(res.status.calledWith(400)).to.equal(true)
      expect(res.send.firstCall.args[0]).to.match(/token/i)
    })
  })

  describe('disconnect', () => {
    it('removes the account', async () => {
      await connect()
      await call(HardcoverController.disconnect)
      expect(await Database.hardcoverAccountModel.count()).to.equal(0)
    })
  })

  describe('syncNow', () => {
    it('runs a sync and returns the result', async () => {
      await connect()
      const res = await call(HardcoverController.syncNow)
      const body = res.json.firstCall.args[0]
      expect(body).to.include({ connected: true })
      expect(body.lastSummary).to.include({ remoteChanges: 0 })
    })

    it('returns 404 when not connected', async () => {
      const res = await call(HardcoverController.syncNow)
      expect(res.sendStatus.calledWith(404)).to.equal(true)
    })

    it('reports why a sync failed', async () => {
      await connect()
      api.libraryChanges.rejects(new AuthenticationError('invalid_token'))
      const res = await call(HardcoverController.syncNow)
      expect(res.status.calledWith(502)).to.equal(true)
      expect(res.send.firstCall.args[0]).to.match(/token/i)
    })
  })

  describe('getFriends', () => {
    const req = () => ({ params: { id: duneItem.id }, libraryItem: { id: duneItem.id, media: dune } })

    it('says so when the user has not connected Hardcover', async () => {
      const res = await call(HardcoverController.getFriends, req())
      expect(res.json.firstCall.args[0]).to.deep.equal({ connected: false, friends: [] })
    })

    it("lists friends' ratings and reviews, finding the book by ISBN", async () => {
      await connect()
      const res = await call(HardcoverController.getFriends, req())
      expect(api.findBookIdsByIsbn.calledOnceWith(['9780441172719'])).to.equal(true)
      expect(api.friends.calledOnceWith(100)).to.equal(true)
      expect(res.json.firstCall.args[0]).to.deep.equal({
        connected: true,
        hardcoverBookId: 100,
        friends: [{ hardcoverUserId: 5, username: 'pal', name: 'Pal', status: 'read', rating: 4, review: 'Good', updatedAt: Date.parse('2026-03-01T00:00:00+00:00') }]
      })
    })

    it('uses the synced Hardcover book when there is one', async () => {
      await connect()
      await Database.hardcoverBookLinkModel.create({ userId: user.id, bookId: dune.id, hardcoverBookId: 777 })
      await call(HardcoverController.getFriends, req())
      expect(api.findBookIdsByIsbn.called).to.equal(false)
      expect(api.friends.calledOnceWith(777)).to.equal(true)
    })

    it('caches the answer for a while', async () => {
      await connect()
      await call(HardcoverController.getFriends, req())
      await call(HardcoverController.getFriends, req())
      expect(api.friends.calledOnce).to.equal(true)
    })

    it('returns an empty list for a book Hardcover does not know', async () => {
      await connect()
      api.findBookIdsByIsbn.resolves(new Map())
      const res = await call(HardcoverController.getFriends, req())
      expect(res.json.firstCall.args[0]).to.deep.equal({ connected: true, hardcoverBookId: null, friends: [] })
    })

    it('does not break the book page when Hardcover is down', async () => {
      await connect()
      api.friends.rejects(new Error('down'))
      const res = await call(HardcoverController.getFriends, req())
      expect(res.json.firstCall.args[0]).to.deep.include({ connected: true, friends: [], error: 'Could not reach Hardcover' })
    })
  })

  describe('after a review is saved', () => {
    it('schedules a Hardcover sync', async () => {
      const scheduleSync = sinon.stub(HardcoverController.syncManager, 'scheduleSync')
      const res = fakeRes()
      await ReviewController.saveMine.bind(apiRouter)({ user, body: { rating: 4 }, libraryItem: { id: duneItem.id, media: dune } }, res)
      expect(scheduleSync.calledOnceWith(user.id)).to.equal(true)
    })

    it('schedules a Hardcover sync when a review is deleted', async () => {
      const scheduleSync = sinon.stub(HardcoverController.syncManager, 'scheduleSync')
      const res = fakeRes()
      await ReviewController.deleteMine.bind(apiRouter)({ user, libraryItem: { id: duneItem.id, media: dune } }, res)
      expect(scheduleSync.calledOnceWith(user.id)).to.equal(true)
    })
  })
})
