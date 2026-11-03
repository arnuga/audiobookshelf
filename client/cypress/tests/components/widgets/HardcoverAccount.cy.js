import HardcoverAccount from '@/components/widgets/HardcoverAccount.vue'
import Btn from '@/components/ui/Btn.vue'

describe('HardcoverAccount', () => {
  const strings = {
    MessageHardcoverHelp: 'Help text',
    ButtonHardcoverCreateToken: 'Create a token on Hardcover',
    LabelHardcoverToken: 'Hardcover API token',
    ButtonHardcoverConnect: 'Connect',
    ButtonHardcoverDisconnect: 'Disconnect',
    ButtonHardcoverSyncNow: 'Sync now',
    MessageHardcoverConnectedAs: 'Connected as {0}',
    MessageHardcoverLastSync: 'Last synced {0}',
    MessageHardcoverNeverSynced: 'Not synced yet',
    MessageHardcoverSummary: '{0} updated here, {1} updated on Hardcover',
    MessageHardcoverNotFound: '{0} rated books not found on Hardcover',
    ToastFailedToUpdate: 'Failed to update'
  }

  const connected = { connected: true, hardcoverUsername: 'hc_reader', lastSyncAt: 1000, lastError: null, lastSummary: { remoteChanges: 3, unmatched: 0, pulled: 2, pushed: 1, notOnHardcover: 4, failed: 0 } }

  function mountWith({ account = { connected: false }, put, post } = {}) {
    const axios = {
      $get: cy.stub().as('get').resolves(account),
      $put: cy
        .stub()
        .as('put')
        .callsFake(put || (() => Promise.resolve({ ...connected, lastSyncAt: null, lastSummary: null }))),
      $delete: cy.stub().as('delete').resolves({ connected: false }),
      $post: cy
        .stub()
        .as('post')
        .callsFake(post || (() => Promise.resolve({ ...connected, lastSyncAt: 2000 })))
    }
    const toast = { success: cy.stub().as('toastSuccess'), error: cy.stub().as('toastError') }
    const getString = (key, args = []) => args.reduce((text, arg, i) => text.replace(`{${i}}`, arg), strings[key])
    cy.mount(HardcoverAccount, {
      propsData: { dateFormat: 'MM/dd/yyyy', timeFormat: 'HH:mm' },
      mocks: { $strings: strings, $getString: getString, $axios: axios, $toast: toast, $formatDatetime: (ms) => `at:${ms}` },
      stubs: { 'ui-btn': Btn }
    })
    return axios
  }

  it('links to a token form with the permissions the sync needs', () => {
    mountWith()
    cy.get('@get').should('have.been.calledWith', '/api/me/hardcover')
    cy.get('&create-token').should('have.attr', 'href').and('include', 'https://hardcover.app/account/api/keys/new?scope=').and('include', 'write:reviews').and('include', 'read:social')
    cy.get('&create-token').should('have.attr', 'target', '_blank')
  })

  it('connects with a pasted token and clears the field', () => {
    mountWith()
    cy.get('&token').should('have.attr', 'type', 'password').type('hc_pat_abc')
    cy.get('&connect').click()
    cy.get('@put').should('have.been.calledWith', '/api/me/hardcover', { token: 'hc_pat_abc' })
    cy.get('&status').should('contain', 'Connected as hc_reader').and('contain', 'Not synced yet')
    cy.get('&token').should('not.exist')
  })

  it('shows why a token was refused', () => {
    mountWith({ put: () => Promise.reject({ response: { status: 400, data: 'Hardcover did not accept this token' } }) })
    cy.get('&token').type('bad')
    cy.get('&connect').click()
    cy.get('@toastError').should('have.been.calledWith', 'Hardcover did not accept this token')
    cy.get('&token').should('exist')
  })

  it('shows the last sync and what it did', () => {
    mountWith({ account: connected })
    cy.get('&status').should('contain', 'Connected as hc_reader').and('contain', 'Last synced at:1000')
    cy.get('&summary').should('contain', '2 updated here, 1 updated on Hardcover').and('contain', '4 rated books not found on Hardcover')
  })

  it('shows the last error', () => {
    mountWith({ account: { ...connected, lastError: 'Hardcover rejected the token.' } })
    cy.get('&error').should('contain', 'Hardcover rejected the token.')
  })

  it('syncs on request and shows the new result', () => {
    mountWith({ account: connected })
    cy.get('&sync').click()
    cy.get('@post').should('have.been.calledWith', '/api/me/hardcover/sync')
    cy.get('&status').should('contain', 'Last synced at:2000')
  })

  it('shows a failed sync', () => {
    mountWith({ account: connected, post: () => Promise.reject({ response: { status: 502, data: 'Hardcover daily request limit reached.' } }) })
    cy.get('&sync').click()
    cy.get('&error').should('contain', 'Hardcover daily request limit reached.')
  })

  it('disconnects', () => {
    mountWith({ account: connected })
    cy.get('&disconnect').click()
    cy.get('@delete').should('have.been.calledWith', '/api/me/hardcover')
    cy.get('&token').should('exist')
  })
})
