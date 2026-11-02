import OtherReaders from '@/components/widgets/OtherReaders.vue'

describe('OtherReaders', () => {
  const strings = {
    LabelOtherReaders: 'Other readers',
    LabelFinished: 'Finished',
    LabelInProgress: 'In Progress',
    ButtonReadMore: 'Read More',
    ButtonReadLess: 'Read Less'
  }

  const finishedAt = new Date('2026-01-02T12:00:00Z').valueOf()

  function mountWith(readers) {
    const axios = { $get: cy.stub().as('get').resolves({ libraryItemId: 'li_1', readers }) }
    cy.mount(OtherReaders, {
      propsData: { libraryItemId: 'li_1', dateFormat: 'MM/dd/yyyy' },
      mocks: { $strings: strings, $axios: axios, $formatDate: (ms, fmt) => `${fmt}:${ms}` }
    })
    return axios
  }

  function reader(values) {
    return { userId: 'u1', username: 'friend', rating: null, review: null, isFinished: false, finishedAt: null, progress: 0, updatedAt: 1, ...values }
  }

  it('loads readers for the item', () => {
    mountWith([])
    cy.get('@get').should('have.been.calledWith', '/api/items/li_1/reviews')
  })

  it('renders nothing when nobody else has read the book', () => {
    mountWith([])
    cy.get('&other-readers').should('not.exist')
  })

  it('shows each reader’s name, stars and review', () => {
    mountWith([reader({ username: 'alice', rating: 3.5, review: 'Slow start, great ending' }), reader({ userId: 'u2', username: 'bob', rating: 5 })])
    cy.get('&other-readers').should('contain', 'Other readers')
    cy.get('&reader').should('have.length', 2)
    cy.get('&reader').first().should('contain', 'alice').and('contain', 'Slow start, great ending')
    // the &name shortcut only works in cy.get, so .find uses the attribute selector
    cy.get('&reader').first().find('[cy-id="stars"]').should('have.attr', 'aria-label', '3.5 / 5')
    cy.get('&reader').eq(1).find('[cy-id="review"]').should('not.exist')
  })

  it('shows no stars for a reader who did not rate', () => {
    mountWith([reader({ isFinished: true, finishedAt })])
    cy.get('&stars').should('not.exist')
  })

  it('shows when a reader finished the book', () => {
    mountWith([reader({ isFinished: true, finishedAt, progress: 1 })])
    cy.get('&status').should('have.text', `Finished MM/dd/yyyy:${finishedAt}`)
  })

  it('shows progress for a reader part way through', () => {
    mountWith([reader({ progress: 0.426 })])
    cy.get('&status').should('have.text', 'In Progress 43%')
  })

  it('collapses long reviews behind Read More', () => {
    mountWith([reader({ review: 'word '.repeat(200) })])
    cy.get('&review').should('have.class', 'line-clamp-3')
    cy.get('&toggle-review').should('contain', 'Read More').click()
    cy.get('&review').should('not.have.class', 'line-clamp-3')
    cy.get('&toggle-review').should('contain', 'Read Less')
  })

  it('stays hidden if loading fails', () => {
    cy.mount(OtherReaders, {
      propsData: { libraryItemId: 'li_1', dateFormat: 'MM/dd/yyyy' },
      mocks: { $strings: strings, $axios: { $get: cy.stub().rejects(new Error('nope')) }, $formatDate: () => '' }
    })
    cy.get('&other-readers').should('not.exist')
  })
})
