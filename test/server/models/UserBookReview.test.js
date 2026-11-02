const { expect } = require('chai')
const { Sequelize } = require('sequelize')

const Database = require('../../../server/Database')
const UserBookReview = require('../../../server/models/UserBookReview')

describe('UserBookReview', () => {
  describe('parsePayload', () => {
    it('accepts whole and half star ratings from 0.5 to 5', () => {
      for (const rating of [0.5, 1, 2.5, 4, 5]) {
        expect(UserBookReview.parsePayload({ rating })).to.deep.equal({ rating })
      }
    })

    it('rejects ratings outside 0.5-5 or not in half steps', () => {
      for (const rating of [0, -1, 5.5, 3.3, '4', true]) {
        expect(UserBookReview.parsePayload({ rating }).error, `rating ${rating}`).to.be.a('string')
      }
    })

    it('accepts null to clear a field', () => {
      expect(UserBookReview.parsePayload({ rating: null, review: null })).to.deep.equal({ rating: null, review: null })
    })

    it('trims reviews and treats blank text as cleared', () => {
      expect(UserBookReview.parsePayload({ review: '  Loved it.  ' })).to.deep.equal({ review: 'Loved it.' })
      expect(UserBookReview.parsePayload({ review: '   ' })).to.deep.equal({ review: null })
    })

    it('rejects non-string and over-long reviews', () => {
      expect(UserBookReview.parsePayload({ review: 42 }).error).to.be.a('string')
      expect(UserBookReview.parsePayload({ review: 'x'.repeat(UserBookReview.MAX_REVIEW_LENGTH + 1) }).error).to.be.a('string')
    })

    it('leaves omitted fields out so they stay unchanged', () => {
      expect(UserBookReview.parsePayload({ review: 'Great' })).to.deep.equal({ review: 'Great' })
    })

    it('ignores unknown fields', () => {
      expect(UserBookReview.parsePayload({ rating: 3, userId: 'someone-else' })).to.deep.equal({ rating: 3 })
    })

    it('rejects a missing or non-object body', () => {
      for (const body of [undefined, null, 'text', [1]]) {
        expect(UserBookReview.parsePayload(body).error).to.be.a('string')
      }
    })
  })

  describe('database', () => {
    let user
    let book
    let libraryItem

    beforeEach(async () => {
      global.ServerSettings = {}
      Database.sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
      Database.sequelize.uppercaseFirst = (str) => (str ? `${str[0].toUpperCase()}${str.substr(1)}` : '')
      await Database.buildModels()

      user = await Database.userModel.create({ username: 'reader', type: 'user', permissions: Database.userModel.getDefaultPermissionsForUserType('user') })
      const library = await Database.libraryModel.create({ name: 'Books', mediaType: 'book' })
      const folder = await Database.libraryFolderModel.create({ path: '/books', libraryId: library.id })
      book = await Database.bookModel.create({ title: 'Dune', audioFiles: [], tags: [], narrators: [], genres: [], chapters: [] })
      libraryItem = await Database.libraryItemModel.create({ libraryFiles: [], mediaId: book.id, mediaType: 'book', libraryId: library.id, libraryFolderId: folder.id })
    })

    afterEach(async () => {
      await Database.sequelize.sync({ force: true })
    })

    it('is registered on Database', () => {
      expect(Database.userBookReviewModel).to.equal(UserBookReview)
    })

    it('creates a review on first save', async () => {
      const review = await UserBookReview.saveForUser(user.id, book.id, { rating: 4, review: 'Spice!' })
      expect(review.rating).to.equal(4)
      expect(review.review).to.equal('Spice!')
      expect(await UserBookReview.count()).to.equal(1)
    })

    it('updates the same row on later saves, keeping omitted fields', async () => {
      await UserBookReview.saveForUser(user.id, book.id, { rating: 4, review: 'Spice!' })
      const review = await UserBookReview.saveForUser(user.id, book.id, { rating: 5 })
      expect(review.rating).to.equal(5)
      expect(review.review).to.equal('Spice!')
      expect(await UserBookReview.count()).to.equal(1)
    })

    it('deletes the row once both rating and review are cleared', async () => {
      await UserBookReview.saveForUser(user.id, book.id, { rating: 4 })
      const review = await UserBookReview.saveForUser(user.id, book.id, { rating: null })
      expect(review).to.be.null
      expect(await UserBookReview.count()).to.equal(0)
    })

    it('does not create an empty row', async () => {
      expect(await UserBookReview.saveForUser(user.id, book.id, { rating: null })).to.be.null
      expect(await UserBookReview.count()).to.equal(0)
    })

    it('enforces one review per user per book', async () => {
      await UserBookReview.create({ userId: user.id, bookId: book.id, rating: 3 })
      let error = null
      try {
        await UserBookReview.create({ userId: user.id, bookId: book.id, rating: 4 })
      } catch (err) {
        error = err
      }
      expect(error).to.not.be.null
    })

    it('is removed when the user is deleted', async () => {
      await UserBookReview.saveForUser(user.id, book.id, { rating: 4 })
      await user.destroy()
      expect(await UserBookReview.count()).to.equal(0)
    })

    it('is removed when the book is deleted', async () => {
      await UserBookReview.saveForUser(user.id, book.id, { rating: 4 })
      await libraryItem.destroy()
      await book.destroy()
      expect(await UserBookReview.count()).to.equal(0)
    })

    it('serializes for the API with the library item id', async () => {
      const review = await UserBookReview.saveForUser(user.id, book.id, { rating: 4.5, review: 'Great' })
      const json = review.toJSONForAPI(libraryItem.id)
      expect(json).to.include({ libraryItemId: libraryItem.id, bookId: book.id, userId: user.id, rating: 4.5, review: 'Great' })
      expect(json.createdAt).to.be.a('number')
      expect(json.updatedAt).to.be.a('number')
    })

    describe('getReaderActivity', () => {
      let friend

      async function createUser(username, extra = {}) {
        return Database.userModel.create({ username, type: 'user', isActive: true, permissions: Database.userModel.getDefaultPermissionsForUserType('user'), ...extra })
      }

      function addProgress(userId, values) {
        // silent keeps an explicit updatedAt instead of stamping the current time, so both timestamps are set here
        const now = new Date()
        return Database.mediaProgressModel.create({ userId, mediaItemId: book.id, mediaItemType: 'book', duration: 100, currentTime: 0, isFinished: false, createdAt: now, updatedAt: now, ...values }, { silent: true })
      }

      beforeEach(async () => {
        friend = await createUser('friend')
      })

      it('returns an empty list when nobody else has touched the book', async () => {
        expect(await UserBookReview.getReaderActivity(book.id, user.id)).to.deep.equal([])
      })

      it('leaves out the requesting user', async () => {
        await UserBookReview.saveForUser(user.id, book.id, { rating: 5 })
        await addProgress(user.id, { isFinished: true, finishedAt: new Date() })
        expect(await UserBookReview.getReaderActivity(book.id, user.id)).to.deep.equal([])
      })

      it('includes another user’s rating and review', async () => {
        await UserBookReview.saveForUser(friend.id, book.id, { rating: 4.5, review: 'Loved it' })
        const [entry] = await UserBookReview.getReaderActivity(book.id, user.id)
        expect(entry).to.include({ userId: friend.id, username: 'friend', rating: 4.5, review: 'Loved it', isFinished: false, progress: 0 })
      })

      it('includes a user who finished the book without reviewing it', async () => {
        const finishedAt = new Date('2026-01-02T00:00:00Z')
        await addProgress(friend.id, { currentTime: 100, isFinished: true, finishedAt })
        const [entry] = await UserBookReview.getReaderActivity(book.id, user.id)
        expect(entry).to.include({ userId: friend.id, rating: null, review: null, isFinished: true, finishedAt: finishedAt.valueOf(), progress: 1 })
      })

      it('includes a user part way through, with progress as a fraction', async () => {
        await addProgress(friend.id, { currentTime: 25 })
        const [entry] = await UserBookReview.getReaderActivity(book.id, user.id)
        expect(entry).to.include({ isFinished: false, finishedAt: null, progress: 0.25 })
      })

      it('uses ebook progress when there is no listening progress', async () => {
        await addProgress(friend.id, { duration: 0, ebookProgress: 0.4 })
        const [entry] = await UserBookReview.getReaderActivity(book.id, user.id)
        expect(entry.progress).to.equal(0.4)
      })

      it('merges a user’s review and progress into one entry', async () => {
        await UserBookReview.saveForUser(friend.id, book.id, { rating: 3 })
        await addProgress(friend.id, { currentTime: 100, isFinished: true, finishedAt: new Date() })
        const activity = await UserBookReview.getReaderActivity(book.id, user.id)
        expect(activity).to.have.length(1)
        expect(activity[0]).to.include({ rating: 3, isFinished: true })
      })

      it('ignores progress rows that have not actually started', async () => {
        await addProgress(friend.id, { currentTime: 0 })
        expect(await UserBookReview.getReaderActivity(book.id, user.id)).to.deep.equal([])
      })

      it('ignores progress on other books', async () => {
        const otherBook = await Database.bookModel.create({ title: 'Emma', audioFiles: [], tags: [], narrators: [], genres: [], chapters: [] })
        await Database.mediaProgressModel.create({ userId: friend.id, mediaItemId: otherBook.id, mediaItemType: 'book', duration: 100, currentTime: 50 })
        expect(await UserBookReview.getReaderActivity(book.id, user.id)).to.deep.equal([])
      })

      it('leaves out disabled users', async () => {
        await friend.update({ isActive: false })
        await UserBookReview.saveForUser(friend.id, book.id, { rating: 2 })
        expect(await UserBookReview.getReaderActivity(book.id, user.id)).to.deep.equal([])
      })

      it('lists the most recent activity first', async () => {
        const other = await createUser('other')
        await UserBookReview.create({ userId: friend.id, bookId: book.id, rating: 3, updatedAt: new Date('2026-01-01T00:00:00Z') }, { silent: true })
        await addProgress(other.id, { currentTime: 10, updatedAt: new Date('2026-03-01T00:00:00Z') })
        const activity = await UserBookReview.getReaderActivity(book.id, user.id)
        expect(activity.map((a) => a.username)).to.deep.equal(['other', 'friend'])
        expect(activity[0].updatedAt).to.equal(new Date('2026-03-01T00:00:00Z').valueOf())
      })
    })
  })
})
