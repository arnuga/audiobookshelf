const { expect } = require('chai')
const { Sequelize } = require('sequelize')
const sinon = require('sinon')
const { AuthenticationError } = require('@hardcover/sdk')

const Database = require('../../../server/Database')
const Logger = require('../../../server/Logger')
const SocketAuthority = require('../../../server/SocketAuthority')
const HardcoverSyncManager = require('../../../server/managers/HardcoverSyncManager')

describe('HardcoverSyncManager', () => {
  let user
  let library
  let folder
  let dune
  let duneItem
  let api
  let manager

  const older = '2026-01-01T00:00:00+00:00'

  function remoteEntry(values = {}) {
    return { userBookId: 7, hardcoverBookId: 100, statusId: 3, rating: null, hasReview: false, review: undefined, updatedAt: older, title: 'Dune', authors: ['Frank Herbert'], isbn10: null, isbn13: '9780441172719', asin: null, ...values }
  }

  function fakeApi({ shelf = [], isbns = {} } = {}) {
    return {
      me: sinon.stub().resolves({ id: 42, username: 'hc_reader' }),
      libraryChanges: sinon.stub().resolves({ entries: shelf, cursor: 'cursor-1', hasMore: false }),
      entryForBook: sinon.stub().callsFake(async (id) => shelf.find((e) => e.hardcoverBookId === id) || null),
      findBookIdsByIsbn: sinon.stub().resolves(new Map(Object.entries(isbns))),
      addEntry: sinon.stub().callsFake(async (hardcoverBookId, values) => remoteEntry({ userBookId: 500, hardcoverBookId, ...values })),
      updateEntry: sinon.stub().callsFake(async (userBookId, values) => remoteEntry({ userBookId, ...values })),
      friends: sinon.stub().resolves([])
    }
  }

  async function addBook(values) {
    const { authorNames = [], ...bookValues } = values
    const book = await Database.bookModel.create({ audioFiles: [], tags: [], narrators: [], genres: [], chapters: [], ...bookValues })
    const libraryItem = await Database.libraryItemModel.create({ libraryFiles: [], mediaId: book.id, mediaType: 'book', libraryId: library.id, libraryFolderId: folder.id })
    for (const name of authorNames) {
      const author = await Database.authorModel.create({ name, libraryId: library.id })
      await Database.bookAuthorModel.create({ bookId: book.id, authorId: author.id })
    }
    return { book, libraryItem }
  }

  async function connect() {
    await Database.hardcoverAccountModel.create({ userId: user.id, token: 'hc_pat_test', hardcoverUserId: 42, hardcoverUsername: 'hc_reader' })
  }

  async function reviewOf(book) {
    const review = await Database.userBookReviewModel.findOne({ where: { userId: user.id, bookId: book.id } })
    return review && { rating: review.rating, review: review.review }
  }

  async function linkOf(book) {
    return Database.hardcoverBookLinkModel.findOne({ where: { userId: user.id, bookId: book.id } })
  }

  beforeEach(async () => {
    global.ServerSettings = {}
    Database.sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
    Database.sequelize.uppercaseFirst = (str) => (str ? `${str[0].toUpperCase()}${str.substr(1)}` : '')
    await Database.buildModels()

    sinon.stub(Logger, 'info')
    sinon.stub(Logger, 'warn')
    sinon.stub(Logger, 'error')
    sinon.stub(Logger, 'debug')
    sinon.stub(SocketAuthority, 'clientEmitter')

    user = await Database.userModel.create({ username: 'reader', type: 'user', isActive: true, permissions: Database.userModel.getDefaultPermissionsForUserType('user') })
    library = await Database.libraryModel.create({ name: 'Books', mediaType: 'book' })
    folder = await Database.libraryFolderModel.create({ path: '/books', libraryId: library.id })
    ;({ book: dune, libraryItem: duneItem } = await addBook({ title: 'Dune', isbn: '9780441172719', authorNames: ['Frank Herbert'] }))

    api = fakeApi()
    manager = new HardcoverSyncManager({ createApi: () => api })
  })

  afterEach(async () => {
    sinon.restore()
    await Database.sequelize.sync({ force: true })
  })

  describe('connect', () => {
    it('checks the token with Hardcover and saves it with the account name', async () => {
      const account = await manager.connect(user.id, '  hc_pat_test  ')
      expect(api.me.calledOnce).to.equal(true)
      expect(account.toJSONForAPI()).to.include({ connected: true, hardcoverUsername: 'hc_reader' })
      const saved = await Database.hardcoverAccountModel.findOne({ where: { userId: user.id } })
      expect(saved.token).to.equal('hc_pat_test')
      expect(saved.hardcoverUserId).to.equal(42)
    })

    it('refuses a token Hardcover rejects', async () => {
      api.me.rejects(new AuthenticationError('invalid_token'))
      const result = await manager.connect(user.id, 'bad').catch((error) => error)
      expect(result).to.be.an('error')
      expect(await Database.hardcoverAccountModel.count()).to.equal(0)
    })

    it('starts over when a different Hardcover account is connected', async () => {
      await connect()
      await Database.hardcoverAccountModel.update({ cursor: 'old' }, { where: { userId: user.id } })
      await Database.hardcoverBookLinkModel.create({ userId: user.id, bookId: dune.id, hardcoverBookId: 100 })
      api.me.resolves({ id: 99, username: 'someone_else' })
      await manager.connect(user.id, 'hc_pat_other')
      const saved = await Database.hardcoverAccountModel.findOne({ where: { userId: user.id } })
      expect(saved.cursor).to.equal(null)
      expect(await Database.hardcoverBookLinkModel.count()).to.equal(0)
    })
  })

  describe('syncUser', () => {
    beforeEach(connect)

    it('pulls a rating and review from Hardcover for a matching book', async () => {
      api = fakeApi({ shelf: [remoteEntry({ rating: 4.5, hasReview: true, review: 'Spice!' })] })
      const summary = await manager.syncUser(user.id)
      expect(await reviewOf(dune)).to.deep.equal({ rating: 4.5, review: 'Spice!' })
      expect(summary).to.include({ pulled: 1, pushed: 0, unmatched: 0 })
      const link = await linkOf(dune)
      expect(link).to.include({ hardcoverBookId: 100, userBookId: 7, syncedRating: 4.5, syncedReview: 'Spice!' })
    })

    it('fetches review text when the change feed only says there is one', async () => {
      api = fakeApi({ shelf: [remoteEntry({ rating: 4, hasReview: true, review: undefined })] })
      api.entryForBook.resolves(remoteEntry({ rating: 4, hasReview: true, review: 'Full text' }))
      await manager.syncUser(user.id)
      expect(api.entryForBook.calledOnceWith(100)).to.equal(true)
      expect(await reviewOf(dune)).to.deep.equal({ rating: 4, review: 'Full text' })
    })

    it('matches by title and author when Hardcover has no ISBN for the edition', async () => {
      api = fakeApi({ shelf: [remoteEntry({ isbn13: null, title: 'Dune', authors: ['Frank Herbert'], rating: 3 })] })
      await manager.syncUser(user.id)
      expect(await reviewOf(dune)).to.deep.equal({ rating: 3, review: null })
    })

    it('counts Hardcover books that are not in the library', async () => {
      api = fakeApi({ shelf: [remoteEntry({ hardcoverBookId: 555, isbn13: '9780000000002', title: 'Elsewhere', authors: ['Nobody'], rating: 5 })] })
      const summary = await manager.syncUser(user.id)
      expect(summary).to.include({ unmatched: 1, pulled: 0 })
    })

    it('adds a reviewed book to the Hardcover shelf as read, dated by when it was finished', async () => {
      await Database.userBookReviewModel.saveForUser(user.id, dune.id, { rating: 4, review: 'Great' })
      await Database.mediaProgressModel.create({ userId: user.id, mediaItemId: dune.id, mediaItemType: 'book', duration: 100, currentTime: 100, isFinished: true, finishedAt: new Date('2025-06-30T12:00:00Z') })
      api = fakeApi({ isbns: { 9780441172719: 100 } })
      const summary = await manager.syncUser(user.id)
      expect(api.addEntry.calledOnce).to.equal(true)
      expect(api.addEntry.firstCall.args).to.deep.equal([100, { rating: 4, review: 'Great', finishedDate: '2025-06-30' }])
      expect(summary).to.include({ pushed: 1 })
      expect(await linkOf(dune)).to.include({ userBookId: 500, syncedRating: 4, syncedReview: 'Great' })
    })

    it('reports reviewed books Hardcover could not find by ISBN', async () => {
      await Database.userBookReviewModel.saveForUser(user.id, dune.id, { rating: 4 })
      const summary = await manager.syncUser(user.id)
      expect(api.addEntry.called).to.equal(false)
      expect(summary).to.include({ notOnHardcover: 1, pushed: 0 })
      expect(await linkOf(dune)).to.equal(null)
    })

    it('saves the cursor so the next sync only reads new changes', async () => {
      await manager.syncUser(user.id)
      await manager.syncUser(user.id)
      expect(api.libraryChanges.firstCall.args[0]).to.equal(null)
      expect(api.libraryChanges.secondCall.args[0]).to.equal('cursor-1')
    })

    it('reads every page of changes', async () => {
      api.libraryChanges.onFirstCall().resolves({ entries: [], cursor: 'page-1', hasMore: true })
      api.libraryChanges.onSecondCall().resolves({ entries: [remoteEntry({ rating: 2 })], cursor: 'page-2', hasMore: false })
      await manager.syncUser(user.id)
      expect(api.libraryChanges.secondCall.args[0]).to.equal('page-1')
      expect(await reviewOf(dune)).to.deep.equal({ rating: 2, review: null })
      expect((await Database.hardcoverAccountModel.findOne()).cursor).to.equal('page-2')
    })

    it('sends only what changed in Audiobookshelf since the last sync', async () => {
      await Database.userBookReviewModel.saveForUser(user.id, dune.id, { rating: 5, review: 'Same' })
      await Database.hardcoverBookLinkModel.create({ userId: user.id, bookId: dune.id, hardcoverBookId: 100, userBookId: 7, syncedRating: 3, syncedReview: 'Same', syncedAt: new Date() })
      await Database.hardcoverAccountModel.update({ cursor: 'cursor-0' }, { where: { userId: user.id } })
      api.entryForBook.resolves(remoteEntry({ rating: 3, hasReview: true, review: 'Same' }))
      await manager.syncUser(user.id)
      expect(api.updateEntry.calledOnceWith(7, { rating: 5 })).to.equal(true)
      expect(api.findBookIdsByIsbn.called).to.equal(false)
      expect(await linkOf(dune)).to.include({ syncedRating: 5 })
    })

    it('sends a review cleared in Audiobookshelf', async () => {
      await Database.hardcoverBookLinkModel.create({ userId: user.id, bookId: dune.id, hardcoverBookId: 100, userBookId: 7, syncedRating: 4, syncedReview: 'Gone', syncedAt: new Date() })
      await Database.hardcoverAccountModel.update({ cursor: 'cursor-0' }, { where: { userId: user.id } })
      api.entryForBook.resolves(remoteEntry({ rating: 4, hasReview: true, review: 'Gone' }))
      await manager.syncUser(user.id)
      expect(api.updateEntry.calledOnceWith(7, { rating: null, review: null })).to.equal(true)
    })

    it('makes no Hardcover calls for books unchanged on both sides', async () => {
      await Database.userBookReviewModel.saveForUser(user.id, dune.id, { rating: 4 })
      await Database.hardcoverBookLinkModel.create({ userId: user.id, bookId: dune.id, hardcoverBookId: 100, userBookId: 7, syncedRating: 4, syncedReview: null, syncedAt: new Date() })
      await Database.hardcoverAccountModel.update({ cursor: 'cursor-0' }, { where: { userId: user.id } })
      const summary = await manager.syncUser(user.id)
      expect(api.entryForBook.called).to.equal(false)
      expect(api.updateEntry.called).to.equal(false)
      expect(summary).to.include({ pulled: 0, pushed: 0 })
    })

    it('skips change-feed entries this server already synced', async () => {
      await Database.userBookReviewModel.saveForUser(user.id, dune.id, { rating: 4, review: 'Mine' })
      await Database.hardcoverBookLinkModel.create({ userId: user.id, bookId: dune.id, hardcoverBookId: 100, userBookId: 7, syncedRating: 4, syncedReview: 'Mine', syncedAt: new Date('2026-05-01T00:00:00Z') })
      api = fakeApi({ shelf: [remoteEntry({ rating: 4, hasReview: true, review: undefined, updatedAt: '2026-04-30T23:59:59+00:00' })] })
      await manager.syncUser(user.id)
      expect(api.entryForBook.called).to.equal(false)
    })

    it('lets the newer edit win when both sides changed', async () => {
      await Database.userBookReviewModel.saveForUser(user.id, dune.id, { rating: 2 })
      await Database.hardcoverBookLinkModel.create({ userId: user.id, bookId: dune.id, hardcoverBookId: 100, userBookId: 7, syncedRating: 3, syncedReview: null, syncedAt: new Date('2020-01-01T00:00:00Z') })
      api = fakeApi({ shelf: [remoteEntry({ rating: 5, updatedAt: '2099-01-01T00:00:00+00:00' })] })
      await manager.syncUser(user.id)
      expect(await reviewOf(dune)).to.deep.equal({ rating: 5, review: null })
      expect(api.updateEntry.called).to.equal(false)
    })

    it('ignores books the user cannot access', async () => {
      user.permissions = { ...user.permissions, accessAllLibraries: false }
      user.librariesAccessible = []
      await user.save()
      api = fakeApi({ shelf: [remoteEntry({ rating: 4 })] })
      const summary = await manager.syncUser(user.id)
      expect(summary).to.include({ unmatched: 1, pulled: 0 })
      expect(await reviewOf(dune)).to.equal(null)
    })

    it('records an expired token and stops', async () => {
      api.libraryChanges.rejects(new AuthenticationError('invalid_token'))
      const error = await manager.syncUser(user.id).catch((e) => e)
      expect(error).to.be.an('error')
      const account = await Database.hardcoverAccountModel.findOne()
      expect(account.lastError).to.match(/token/i)
      expect(account.cursor).to.equal(null)
    })

    it('keeps going when one book fails, and reports it', async () => {
      await Database.userBookReviewModel.saveForUser(user.id, dune.id, { rating: 4 })
      const { book: emma } = await addBook({ title: 'Emma', isbn: '9780141439587', authorNames: ['Jane Austen'] })
      await Database.userBookReviewModel.saveForUser(user.id, emma.id, { rating: 5 })
      api = fakeApi({ isbns: { 9780441172719: 100, 9780141439587: 200 } })
      api.addEntry.onFirstCall().rejects(new Error('boom'))
      const summary = await manager.syncUser(user.id)
      expect(summary).to.include({ failed: 1, pushed: 1 })
      const account = await Database.hardcoverAccountModel.findOne()
      expect(account.lastSummary).to.include({ failed: 1, pushed: 1 })
      expect(account.lastSyncAt).to.be.instanceOf(Date)
    })

    it('runs one sync per user at a time', async () => {
      const [first, second] = await Promise.all([manager.syncUser(user.id), manager.syncUser(user.id)])
      expect(first).to.equal(second)
      expect(api.libraryChanges.calledOnce).to.equal(true)
    })

    it('tells the user when ratings came in', async () => {
      api = fakeApi({ shelf: [remoteEntry({ rating: 4 })] })
      await manager.syncUser(user.id)
      expect(SocketAuthority.clientEmitter.calledWith(user.id, 'hardcover_synced')).to.equal(true)
    })
  })

  describe('syncAll', () => {
    it('syncs every connected user and survives one failing', async () => {
      await connect()
      const other = await Database.userModel.create({ username: 'other', type: 'user', isActive: true, permissions: Database.userModel.getDefaultPermissionsForUserType('user') })
      await Database.hardcoverAccountModel.create({ userId: other.id, token: 'hc_pat_other' })
      const apis = { hc_pat_test: fakeApi(), hc_pat_other: fakeApi() }
      apis.hc_pat_other.libraryChanges.rejects(new Error('down'))
      manager = new HardcoverSyncManager({ createApi: (token) => apis[token] })
      await manager.syncAll()
      expect(apis.hc_pat_test.libraryChanges.calledOnce).to.equal(true)
      expect(apis.hc_pat_other.libraryChanges.calledOnce).to.equal(true)
    })
  })

  describe('scheduleSync', () => {
    it('waits for edits to settle, then syncs once', async () => {
      await connect()
      const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const syncUser = sinon.stub(manager, 'syncUser').resolves({})
      manager.scheduleSync(user.id)
      manager.scheduleSync(user.id)
      clock.tick(HardcoverSyncManager.SAVE_DELAY_MS + 1)
      clock.restore()
      expect(syncUser.calledOnceWith(user.id)).to.equal(true)
    })
  })
})
