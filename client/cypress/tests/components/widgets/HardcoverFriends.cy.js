import HardcoverFriends from '@/components/widgets/HardcoverFriends.vue'

describe('HardcoverFriends', () => {
  const strings = {
    LabelHardcoverFriends: 'Friends on Hardcover',
    LabelHardcoverStatusRead: 'Read',
    LabelHardcoverStatusReading: 'Reading',
    LabelHardcoverStatusWantToRead: 'Want to Read',
    LabelHardcoverStatusPaused: 'Paused',
    LabelHardcoverStatusDidNotFinish: 'Did Not Finish',
    ButtonReadMore: 'Read More',
    ButtonReadLess: 'Read Less'
  }

  function friend(values) {
    return { hardcoverUserId: 5, username: 'pal', name: 'Pal', status: 'read', rating: null, review: null, updatedAt: 1, ...values }
  }

  function mountWith(response) {
    const axios = { $get: cy.stub().as('get').resolves(response) }
    cy.mount(HardcoverFriends, {
      propsData: { libraryItemId: 'li_1' },
      mocks: { $strings: strings, $axios: axios }
    })
  }

  it('loads friends for the item', () => {
    mountWith({ connected: false, friends: [] })
    cy.get('@get').should('have.been.calledWith', '/api/items/li_1/hardcover-friends')
  })

  it('renders nothing without friends to show', () => {
    mountWith({ connected: true, friends: [] })
    cy.get('&hardcover-friends').should('not.exist')
  })

  it("shows each friend's name, status, stars and review, linked to their Hardcover profile", () => {
    mountWith({ connected: true, hardcoverBookId: 100, friends: [friend({ rating: 4.5, review: 'Loved it' }), friend({ hardcoverUserId: 6, username: 'bud', name: null, status: 'reading' })] })
    cy.get('&hardcover-friends').should('contain', 'Friends on Hardcover')
    cy.get('&friend').should('have.length', 2)
    cy.get('&friend').first().should('contain', 'Pal').and('contain', 'Read').and('contain', 'Loved it')
    cy.get('&friend').first().find('[cy-id="stars"]').should('have.attr', 'aria-label', '4.5 / 5')
    cy.get('&friend').first().find('a').should('have.attr', 'href', 'https://hardcover.app/@pal')
    cy.get('&friend').eq(1).should('contain', 'bud').and('contain', 'Reading')
  })

  it('clamps long reviews with a toggle', () => {
    mountWith({ connected: true, friends: [friend({ review: 'x'.repeat(300) })] })
    cy.get('&friend').first().find('[cy-id="review"]').should('have.class', 'line-clamp-3')
    cy.get('&friend').first().find('[cy-id="toggle-review"]').click()
    cy.get('&friend').first().find('[cy-id="review"]').should('not.have.class', 'line-clamp-3')
  })

  it('stays hidden when the request fails', () => {
    const axios = { $get: cy.stub().rejects(new Error('down')) }
    cy.mount(HardcoverFriends, { propsData: { libraryItemId: 'li_1' }, mocks: { $strings: strings, $axios: axios } })
    cy.get('&hardcover-friends').should('not.exist')
  })
})
