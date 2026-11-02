import MyReview from '@/components/widgets/MyReview.vue'
import TextareaInput from '@/components/ui/TextareaInput.vue'
import Btn from '@/components/ui/Btn.vue'

describe('MyReview', () => {
  const strings = {
    LabelYourRating: 'Your rating',
    LabelYourReview: 'Your review',
    PlaceholderReview: 'What did you think?',
    ButtonSave: 'Save',
    ButtonDelete: 'Delete',
    ToastFailedToUpdate: 'Failed to update'
  }

  function mountWith(existing) {
    const axios = {
      $get: cy.stub().as('get').resolves(existing),
      $put: cy
        .stub()
        .as('put')
        .callsFake((url, body) => Promise.resolve({ rating: null, review: null, ...existing, ...body })),
      $delete: cy.stub().as('delete').resolves()
    }
    const toast = { error: cy.stub().as('toastError') }
    cy.mount(MyReview, {
      propsData: { libraryItemId: 'li_1' },
      mocks: { $strings: strings, $axios: axios, $toast: toast },
      stubs: { 'ui-textarea-input': TextareaInput, 'ui-btn': Btn }
    })
    return axios
  }

  it('loads the current user’s review', () => {
    mountWith({ rating: 3.5, review: 'Pretty good' })
    cy.get('@get').should('have.been.calledWith', '/api/items/li_1/review')
    cy.get('&rating').should('have.attr', 'aria-valuenow', '3.5')
    cy.get('textarea').should('have.value', 'Pretty good')
  })

  it('shows empty stars when there is no review', () => {
    mountWith(null)
    cy.get('&rating').should('have.attr', 'aria-valuenow', '0')
    cy.get('&delete').should('not.exist')
  })

  it('saves a rating immediately when a star is clicked', () => {
    mountWith(null)
    cy.get('&star-4').click()
    cy.get('@put').should('have.been.calledWith', '/api/items/li_1/review', { rating: 4 })
    cy.get('&rating').should('have.attr', 'aria-valuenow', '4')
  })

  it('supports half stars', () => {
    mountWith(null)
    cy.get('&star-2.5').click()
    cy.get('@put').should('have.been.calledWith', '/api/items/li_1/review', { rating: 2.5 })
  })

  it('clears the rating when the current rating is clicked again', () => {
    mountWith({ rating: 4, review: null })
    cy.get('&star-4').click()
    cy.get('@put').should('have.been.calledWith', '/api/items/li_1/review', { rating: null })
  })

  it('only shows Save once the review text changes, then saves it', () => {
    mountWith({ rating: 4, review: 'Old' })
    cy.get('&save').should('not.exist')
    cy.get('textarea').clear().type('New thoughts')
    cy.get('&save').click()
    cy.get('@put').should('have.been.calledWith', '/api/items/li_1/review', { review: 'New thoughts' })
    cy.get('&save').should('not.exist')
  })

  it('keeps an unsaved review draft when the rating changes', () => {
    mountWith({ rating: 2, review: 'Old' })
    cy.get('textarea').clear().type('Draft in progress')
    cy.get('&star-5').click()
    cy.get('textarea').should('have.value', 'Draft in progress')
    cy.get('&save').should('exist')
  })

  it('deletes the review', () => {
    mountWith({ rating: 4, review: 'Old' })
    cy.get('&delete').click()
    cy.get('@delete').should('have.been.calledWith', '/api/items/li_1/review')
    cy.get('&rating').should('have.attr', 'aria-valuenow', '0')
    cy.get('textarea').should('have.value', '')
  })

  it('shows an error and keeps the old rating if saving fails', () => {
    const axios = mountWith({ rating: 2, review: null })
    cy.then(() => axios.$put.rejects(new Error('nope')))
    cy.get('&star-5').click()
    cy.get('@toastError').should('have.been.calledWith', 'Failed to update')
    cy.get('&rating').should('have.attr', 'aria-valuenow', '2')
  })
})
