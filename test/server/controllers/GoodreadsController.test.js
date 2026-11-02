const { expect } = require('chai')
const { Sequelize } = require('sequelize')
const sinon = require('sinon')

const Database = require('../../../server/Database')
const ApiRouter = require('../../../server/routers/ApiRouter')
const ApiCacheManager = require('../../../server/managers/ApiCacheManager')
const Auth = require('../../../server/Auth')
const Logger = require('../../../server/Logger')
const SocketAuthority = require('../../../server/SocketAuthority')
const GoodreadsController = require('../../../server/controllers/GoodreadsController')
const goodreads = require('../../../server/utils/goodreads')

const HEADER = 'Book Id,Title,Author,Author l-f,Additional Authors,ISBN,ISBN13,My Rating,Average Rating,Publisher,Binding,Number of Pages,Year Published,Original Publication Year,Date Read,Date Added,Bookshelves,Bookshelves with positions,Exclusive Shelf,My Review,Spoiler,Private Notes,Read Count,Owned Copies'

function exportCsv(rows) {
  const keys = HEADER.split(',')
  const lines = rows.map((values) => {
    const row = { 'Book Id': '1', ISBN: '=""', ISBN13: '=""', 'My Rating': '0', 'Exclusive Shelf': 'read', 'Date Read': '', 'Date Added': '2024/01/01', 'My Review': '', ...values }
    return keys.map((key) => `"${String(row[key] ?? '').replace(/"/g, '""')}"`).join(',')
  })
  return [HEADER, ...lines].join('\n')
}

function fakeRes() {
  const res = {}
  res.status = sinon.stub().returns(res)
  res.send = sinon.spy()
  res.json = sinon.spy()
  res.sendStatus = sinon.spy()
  res.setHeader = sinon.spy()
  return res
}

describe('GoodreadsController', () => {
  let apiRouter
  let user
  let library
  let folder
  let dune
  let duneItem

  async function addBook(values, inLibrary = library, inFolder = folder) {
    const { authorNames = [], ...bookValues } = values
    const book = await Database.bookModel.create({ audioFiles: [], tags: [], narrators: [], genres: [], chapters: [], ...bookValues })
    const libraryItem = await Database.libraryItemModel.create({ libraryFiles: [], mediaId: book.id, mediaType: 'book', libraryId: inLibrary.id, libraryFolderId: inFolder.id })
    for (const name of authorNames) {
      const author = await Database.authorModel.create({ name, libraryId: inLibrary.id })
      await Database.bookAuthorModel.create({ bookId: book.id, authorId: author.id })
    }
    return { book, libraryItem }
  }

  async function freshUser() {
    // Reload so mediaProgresses reflect the database, as the auth middleware would
    return Database.userModel.getUserById(user.id)
  }

  async function runImport(csv, apply) {
    const res = fakeRes()
    await GoodreadsController.importCsv.bind(apiRouter)({ user: await freshUser(), body: { csv, apply } }, res)
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
    sinon.stub(SocketAuthority, 'clientEmitter')

    user = await Database.userModel.create({ username: 'reader', type: 'user', isActive: true, permissions: Database.userModel.getDefaultPermissionsForUserType('user') })
    library = await Database.libraryModel.create({ name: 'Books', mediaType: 'book' })
    folder = await Database.libraryFolderModel.create({ path: '/books', libraryId: library.id })
    ;({ book: dune, libraryItem: duneItem } = await addBook({ title: 'Dune', isbn: '9780441172719', authorNames: ['Frank Herbert'] }))
  })

  afterEach(async () => {
    sinon.restore()
    await Database.sequelize.sync({ force: true })
  })

  describe('routes', () => {
    it('registers the import and export endpoints', () => {
      const routes = apiRouter.router._router.stack.filter((l) => typeof l.route?.path === 'string' && l.route.path.startsWith('/me/goodreads')).map((l) => `${Object.keys(l.route.methods)[0]} ${l.route.path}`)
      expect(routes).to.have.members(['post /me/goodreads/import', 'get /me/goodreads/export'])
    })
  })

  describe('POST /me/goodreads/import', () => {
    it('400s when the file is not a Goodreads export', async () => {
      const res = await runImport('hello,world\n1,2', false)
      expect(res.status.calledWith(400)).to.be.true
    })

    it('previews changes without writing anything', async () => {
      const res = await runImport(exportCsv([{ Title: 'Dune (Dune #1)', Author: 'Frank Herbert', ISBN: '="0441172717"', 'My Rating': '5', 'My Review': 'Great', 'Date Read': '2024/03/09' }]), false)
      const body = res.json.firstCall.args[0]
      expect(body.applied).to.be.false
      expect(body.summary).to.include({ total: 1, matched: 1, unmatched: 0, changes: 3 })
      expect(body.rows[0]).to.deep.include({ status: 'matched', matchMethod: 'isbn', libraryItemId: duneItem.id, actions: ['rating', 'review', 'finished'] })
      expect(await Database.userBookReviewModel.count()).to.equal(0)
      expect(await Database.mediaProgressModel.count()).to.equal(0)
    })

    it('applies rating, review and finished date', async () => {
      const res = await runImport(exportCsv([{ Title: 'Dune', Author: 'Frank Herbert', ISBN13: '="9780441172719"', 'My Rating': '4', 'My Review': 'Spice!<br/>Wow', 'Date Read': '2024/03/09' }]), true)
      expect(res.json.firstCall.args[0].applied).to.be.true

      const review = await Database.userBookReviewModel.findOne({ where: { userId: user.id, bookId: dune.id } })
      expect(review).to.include({ rating: 4, review: 'Spice!\nWow' })
      const progress = await Database.mediaProgressModel.findOne({ where: { userId: user.id, mediaItemId: dune.id } })
      expect(progress.isFinished).to.be.true
      expect(progress.finishedAt.toISOString()).to.equal('2024-03-09T00:00:00.000Z')
    })

    it('uses the date added when a read book has no date read', async () => {
      await runImport(exportCsv([{ Title: 'Dune', Author: 'Frank Herbert', 'Date Read': '', 'Date Added': '2022/05/01' }]), true)
      const progress = await Database.mediaProgressModel.findOne({ where: { userId: user.id, mediaItemId: dune.id } })
      expect(progress.finishedAt.toISOString()).to.equal('2022-05-01T00:00:00.000Z')
    })

    it('keeps an existing Audiobookshelf rating and review and reports the conflict', async () => {
      await Database.userBookReviewModel.saveForUser(user.id, dune.id, { rating: 2, review: 'Mine' })
      const res = await runImport(exportCsv([{ Title: 'Dune', Author: 'Frank Herbert', 'My Rating': '5', 'My Review': 'Theirs' }]), true)
      const row = res.json.firstCall.args[0].rows[0]
      expect(row.actions).to.deep.equal(['finished'])
      expect(row.notes).to.include.members(['rating-kept', 'review-kept'])
      expect(await Database.userBookReviewModel.findOne({ where: { userId: user.id } })).to.include({ rating: 2, review: 'Mine' })
    })

    it('fills only the missing half of an existing review', async () => {
      await Database.userBookReviewModel.saveForUser(user.id, dune.id, { rating: 3 })
      await runImport(exportCsv([{ Title: 'Dune', Author: 'Frank Herbert', 'My Rating': '3', 'My Review': 'Added later' }]), true)
      expect(await Database.userBookReviewModel.findOne({ where: { userId: user.id } })).to.include({ rating: 3, review: 'Added later' })
    })

    it('does not touch a book already finished, or change its date', async () => {
      const finishedAt = new Date('2020-01-01T00:00:00Z')
      await (await freshUser()).createUpdateMediaProgressFromPayload({ libraryItemId: duneItem.id, isFinished: true, finishedAt })
      const res = await runImport(exportCsv([{ Title: 'Dune', Author: 'Frank Herbert', 'Date Read': '2024/03/09' }]), true)
      expect(res.json.firstCall.args[0].rows[0].actions).to.deep.equal([])
      const progress = await Database.mediaProgressModel.findOne({ where: { userId: user.id, mediaItemId: dune.id } })
      expect(progress.finishedAt.toISOString()).to.equal(finishedAt.toISOString())
    })

    it('marks a book finished that was part way through', async () => {
      await (await freshUser()).createUpdateMediaProgressFromPayload({ libraryItemId: duneItem.id, duration: 100, currentTime: 40 })
      await runImport(exportCsv([{ Title: 'Dune', Author: 'Frank Herbert', 'Date Read': '2024/03/09' }]), true)
      const progress = await Database.mediaProgressModel.findOne({ where: { userId: user.id, mediaItemId: dune.id } })
      expect(progress.isFinished).to.be.true
    })

    it('does not mark currently-reading or to-read books finished', async () => {
      const res = await runImport(exportCsv([{ Title: 'Dune', Author: 'Frank Herbert', 'Exclusive Shelf': 'currently-reading', 'My Rating': '4' }]), true)
      expect(res.json.firstCall.args[0].rows[0].actions).to.deep.equal(['rating'])
      expect(await Database.mediaProgressModel.count()).to.equal(0)
    })

    it('reports unmatched and ambiguous rows without changing anything', async () => {
      await addBook({ title: 'Emma', authorNames: ['Jane Austen'] })
      await addBook({ title: 'Emma', authorNames: ['Jane Austen'] })
      const res = await runImport(
        exportCsv([
          { Title: 'Not In Library', Author: 'Nobody', 'My Rating': '5' },
          { Title: 'Emma', Author: 'Jane Austen', 'My Rating': '5' }
        ]),
        true
      )
      const body = res.json.firstCall.args[0]
      expect(body.rows.map((r) => r.status)).to.deep.equal(['unmatched', 'ambiguous'])
      expect(body.summary).to.include({ total: 2, matched: 0, unmatched: 2, changes: 0 })
      expect(await Database.userBookReviewModel.count()).to.equal(0)
    })

    it('only matches books in libraries the user can access', async () => {
      const hidden = await Database.libraryModel.create({ name: 'Hidden', mediaType: 'book' })
      const hiddenFolder = await Database.libraryFolderModel.create({ path: '/hidden', libraryId: hidden.id })
      await addBook({ title: 'Secret', isbn: '9780000000002', authorNames: ['Anon'] }, hidden, hiddenFolder)
      await user.update({ permissions: { ...user.permissions, accessAllLibraries: false, librariesAccessible: [library.id] } })

      const res = await runImport(exportCsv([{ Title: 'Secret', Author: 'Anon', ISBN13: '="9780000000002"' }]), false)
      expect(res.json.firstCall.args[0].rows[0].status).to.equal('unmatched')
    })

    it('is safe to run twice', async () => {
      const csv = exportCsv([{ Title: 'Dune', Author: 'Frank Herbert', 'My Rating': '4', 'Date Read': '2024/03/09' }])
      await runImport(csv, true)
      const res = await runImport(csv, true)
      expect(res.json.firstCall.args[0].summary.changes).to.equal(0)
      expect(await Database.mediaProgressModel.count()).to.equal(1)
    })
  })

  describe('GET /me/goodreads/export', () => {
    it('exports rated, reviewed, finished and in-progress books as a Goodreads import CSV', async () => {
      const { libraryItem: emmaItem } = await addBook({ title: 'Emma', authorNames: ['Jane Austen'] })
      await addBook({ title: 'Untouched', authorNames: ['Nobody'] })
      await Database.userBookReviewModel.saveForUser(user.id, dune.id, { rating: 4.5, review: 'Spice' })
      await (await freshUser()).createUpdateMediaProgressFromPayload({ libraryItemId: duneItem.id, isFinished: true, finishedAt: new Date('2024-03-09T00:00:00Z') })
      await (await freshUser()).createUpdateMediaProgressFromPayload({ libraryItemId: emmaItem.id, duration: 100, currentTime: 10 })

      const res = fakeRes()
      await GoodreadsController.exportCsv.bind(apiRouter)({ user: await freshUser() }, res)

      expect(res.setHeader.calledWith('Content-Type', 'text/csv; charset=utf-8')).to.be.true
      const [header, ...rows] = goodreads.parseCsv(res.send.firstCall.args[0])
      expect(header[0]).to.equal('Title')
      const byTitle = Object.fromEntries(rows.map((r) => [r[0], r]))
      expect(Object.keys(byTitle)).to.have.members(['Dune', 'Emma'])
      expect(byTitle.Dune).to.deep.equal(['Dune', 'Frank Herbert', '9780441172719', '5', '2024/03/09', byTitle.Dune[5], 'read', 'Spice'])
      expect(byTitle.Emma[6]).to.equal('currently-reading')
    })
  })
})
