const { expect } = require('chai')
const { MockTransport } = require('@hardcover/sdk/testing')

const { createHardcoverApi } = require('../../../server/utils/hardcoverApi')

describe('hardcoverApi', () => {
  const me = { id: 42, username: 'reader', name: 'Reader' }
  const ok = (data) => ({ status: 200, body: { data } })
  const contributors = [{ author: { name: 'Frank Herbert' }, contribution: null }]

  function userBook(values = {}) {
    return {
      id: 7,
      bookId: 100,
      editionId: 200,
      userId: 42,
      statusId: 3,
      rating: 4.5,
      hasReview: true,
      reviewMarkdown: 'Spice!',
      updatedAt: '2026-03-01T10:00:00+00:00',
      book: { id: 100, title: 'Dune', cachedContributors: contributors },
      edition: { id: 200, isbn10: '0441172717', isbn13: '9780441172719', asin: null },
      userBookReads: [],
      ...values
    }
  }

  function apiWith(responses) {
    const transport = new MockTransport(responses)
    return { api: createHardcoverApi('hc_pat_test', { transport, sleep: async () => {} }), transport }
  }

  function sentBody(transport, index) {
    const { body } = transport.requests[index]
    return typeof body === 'string' ? JSON.parse(body) : body
  }

  it('reads the signed-in account', async () => {
    const { api, transport } = apiWith([ok({ me: [me] })])
    expect(await api.me()).to.deep.equal({ id: 42, username: 'reader' })
    expect(transport.requests[0].headers.authorization || transport.requests[0].headers.Authorization).to.equal('Bearer hc_pat_test')
  })

  it('pages through library changes in a shape the sync understands', async () => {
    const { api } = apiWith([ok({ me: [me] }), ok({ user_books: [userBook({ hasReview: false, reviewMarkdown: undefined })] })])
    const page = await api.libraryChanges(null)
    expect(page.hasMore).to.equal(false)
    expect(page.cursor).to.be.a('string')
    expect(page.entries).to.deep.equal([{ userBookId: 7, hardcoverBookId: 100, statusId: 3, rating: 4.5, hasReview: false, review: undefined, updatedAt: '2026-03-01T10:00:00+00:00', title: 'Dune', authors: ['Frank Herbert'], isbn10: '0441172717', isbn13: '9780441172719', asin: null }])
  })

  it('reads one entry with its review text', async () => {
    const { api } = apiWith([ok({ me: [me] }), ok({ user_books: [userBook()] })])
    const entry = await api.entryForBook(100)
    expect(entry.review).to.equal('Spice!')
    expect(entry.userBookId).to.equal(7)
  })

  it('returns null for a book not on the shelf', async () => {
    const { api } = apiWith([ok({ me: [me] }), ok({ user_books: [] })])
    expect(await api.entryForBook(100)).to.equal(null)
  })

  it('maps ISBNs to Hardcover book ids, most-read edition first', async () => {
    const { api } = apiWith([
      ok({
        editions: [
          { id: 1, bookId: 100, isbn10: null, isbn13: '9780441172719', book: { id: 100 } },
          { id: 2, bookId: 999, isbn10: null, isbn13: '9780441172719', book: { id: 999 } },
          { id: 3, bookId: 300, isbn10: '0553803700', isbn13: null, book: { id: 300 } }
        ]
      })
    ])
    const ids = await api.findBookIdsByIsbn(['9780441172719', '0553803700'])
    expect(ids.get('9780441172719')).to.equal(100)
    expect(ids.get('0553803700')).to.equal(300)
  })

  it('sends rating and review changes, and only the fields given', async () => {
    const { api, transport } = apiWith([ok({ update_user_book: { id: 7, error: null, userBook: userBook({ rating: 2 }) } })])
    await api.updateEntry(7, { rating: 2 })
    const { variables } = sentBody(transport, 0)
    expect(variables).to.deep.equal({ id: 7, object: { rating: 2 } })
  })

  it('sends a review as markdown and clears with null', async () => {
    const { api, transport } = apiWith([ok({ update_user_book: { id: 7, error: null, userBook: userBook() } })])
    await api.updateEntry(7, { rating: null, review: null })
    expect(sentBody(transport, 0).variables.object).to.deep.equal({ rating: null, review_markdown: null })
  })

  it('adds a book as read and quietly, so followers are not flooded', async () => {
    const { api, transport } = apiWith([ok({ insert_user_book: { id: 8, error: null, userBook: userBook({ id: 8 }) } })])
    const entry = await api.addEntry(100, { rating: 4, review: 'Nice' })
    expect(entry.userBookId).to.equal(8)
    const { object } = sentBody(transport, 0).variables
    expect(object).to.include({ book_id: 100, status_id: 3, rating: 4, review_markdown: 'Nice', imported: true })
  })

  it("lists friends' entries for a book", async () => {
    const friend = userBook({ id: 9, userId: 5, rating: 3, reviewMarkdown: 'Meh', statusId: 2, user: { id: 5, username: 'pal', name: 'Pal' } })
    const { api } = apiWith([ok({ me: [me] }), ok({ following_user_books: [{ userBook: friend }, { userBook: null }] })])
    expect(await api.friends(100)).to.deep.equal([{ hardcoverUserId: 5, username: 'pal', name: 'Pal', statusId: 2, rating: 3, review: 'Meh', updatedAt: '2026-03-01T10:00:00+00:00' }])
  })
})
