import GoodreadsSync from '@/components/widgets/GoodreadsSync.vue'
import Btn from '@/components/ui/Btn.vue'

describe('GoodreadsSync', () => {
  const strings = {
    HeaderGoodreads: 'Goodreads',
    MessageGoodreadsHelp: 'Help text',
    ButtonGoodreadsChooseFile: 'Choose Goodreads export',
    ButtonGoodreadsApply: 'Apply {0} changes',
    ButtonGoodreadsExport: 'Export for Goodreads',
    MessageGoodreadsSummary: '{0} of {1} matched, {2} changes',
    MessageGoodreadsApplied: 'Imported {0} changes',
    LabelGoodreadsNotInLibrary: 'Not in your library',
    LabelGoodreadsAmbiguous: 'More than one possible match',
    LabelGoodreadsNoChanges: 'Nothing to change',
    LabelGoodreadsActionRating: 'Add rating',
    LabelGoodreadsActionReview: 'Add review',
    LabelGoodreadsActionFinished: 'Mark finished',
    LabelGoodreadsNoteRatingKept: 'Kept your rating',
    LabelGoodreadsNoteReviewKept: 'Kept your review',
    LabelGoodreadsNoteReviewInvalid: 'Review too long',
    ToastFailedToUpdate: 'Failed to update'
  }

  const preview = {
    applied: false,
    summary: { total: 3, matched: 2, unmatched: 1, changes: 3 },
    rows: [
      { row: 2, title: 'Dune (Dune #1)', author: 'Frank Herbert', status: 'matched', matchMethod: 'isbn', libraryItemId: 'li_1', matchedTitle: 'Dune', actions: ['rating', 'finished'], notes: ['review-kept'] },
      { row: 3, title: 'Emma', author: 'Jane Austen', status: 'matched', matchMethod: 'title-author', libraryItemId: 'li_2', matchedTitle: 'Emma', actions: ['review'], notes: [] },
      { row: 4, title: 'Missing', author: 'Nobody', status: 'unmatched', matchMethod: null, libraryItemId: null, matchedTitle: null, actions: [], notes: [] }
    ]
  }

  function mountWith({ post } = {}) {
    const axios = {
      $post: cy
        .stub()
        .as('post')
        .callsFake(post || ((url, body) => Promise.resolve(body.apply ? { ...preview, applied: true } : preview))),
      $get: cy.stub().as('get').resolves('Title,Author\nDune,Frank Herbert\n')
    }
    const toast = { success: cy.stub().as('toastSuccess'), error: cy.stub().as('toastError') }
    const getString = (key, args = []) => args.reduce((text, arg, i) => text.replace(`{${i}}`, arg), strings[key])
    cy.mount(GoodreadsSync, {
      mocks: { $strings: strings, $getString: getString, $axios: axios, $toast: toast },
      stubs: { 'ui-btn': Btn }
    })
    return axios
  }

  function chooseFile(contents = 'Title,Author,My Rating,Exclusive Shelf\n') {
    cy.get('&file').selectFile({ contents: Cypress.Buffer.from(contents), fileName: 'goodreads_library_export.csv', mimeType: 'text/csv' }, { force: true })
  }

  it('previews the chosen file without applying it', () => {
    mountWith()
    chooseFile('Title,Author,My Rating,Exclusive Shelf\nDune,Frank Herbert,5,read\n')
    cy.get('@post').should('have.been.calledOnceWith', '/api/me/goodreads/import', { csv: 'Title,Author,My Rating,Exclusive Shelf\nDune,Frank Herbert,5,read\n', apply: false })
    cy.get('&summary').should('have.text', '2 of 3 matched, 3 changes')
  })

  it('lists each row with its planned changes and notes', () => {
    mountWith()
    chooseFile()
    cy.get('&row').should('have.length', 3)
    cy.get('&row').eq(0).should('contain', 'Dune (Dune #1)').and('contain', 'Add rating').and('contain', 'Mark finished').and('contain', 'Kept your review')
    cy.get('&row').eq(2).should('contain', 'Not in your library')
  })

  it('applies the import after preview', () => {
    mountWith()
    chooseFile('csv text')
    cy.get('&apply').should('contain', 'Apply 3 changes').click()
    cy.get('@post').should('have.been.calledWith', '/api/me/goodreads/import', { csv: 'csv text', apply: true })
    cy.get('@toastSuccess').should('have.been.calledWith', 'Imported 3 changes')
    cy.get('&apply').should('not.exist')
  })

  it('does not offer Apply when there is nothing to change', () => {
    mountWith({ post: () => Promise.resolve({ ...preview, summary: { ...preview.summary, changes: 0 }, rows: [] }) })
    chooseFile()
    cy.get('&summary').should('exist')
    cy.get('&apply').should('not.exist')
  })

  it('shows the server message when the file is rejected', () => {
    mountWith({ post: () => Promise.reject({ response: { status: 400, data: 'Not a Goodreads export' } }) })
    chooseFile('name,score\n')
    cy.get('@toastError').should('have.been.calledWith', 'Not a Goodreads export')
    cy.get('&summary').should('not.exist')
  })

  it('downloads the export file', () => {
    mountWith()
    cy.get('&export').click()
    cy.get('@get').should('have.been.calledWith', '/api/me/goodreads/export')
  })
})
