<template>
  <!-- Fork addition: connect a Hardcover account and sync ratings and reviews with it -->
  <div class="w-full">
    <p class="text-sm text-gray-200 mb-4">{{ $strings.MessageHardcoverHelp }}</p>

    <template v-if="account && account.connected">
      <div cy-id="status" class="text-sm text-gray-100">
        <p>{{ $getString('MessageHardcoverConnectedAs', [account.hardcoverUsername || '']) }}</p>
        <p class="text-gray-300">{{ account.lastSyncAt ? $getString('MessageHardcoverLastSync', [$formatDatetime(account.lastSyncAt, dateFormat, timeFormat)]) : $strings.MessageHardcoverNeverSynced }}</p>
      </div>
      <div v-if="account.lastSummary" cy-id="summary" class="text-xs text-gray-400 mt-1">
        <p>{{ $getString('MessageHardcoverSummary', [account.lastSummary.pulled, account.lastSummary.pushed]) }}</p>
        <p v-if="account.lastSummary.notOnHardcover">{{ $getString('MessageHardcoverNotFound', [account.lastSummary.notOnHardcover]) }}</p>
      </div>
      <p v-if="account.lastError" cy-id="error" class="text-sm text-error mt-1">{{ account.lastError }}</p>

      <div class="flex flex-wrap items-center gap-2 mt-4">
        <ui-btn cy-id="sync" color="bg-primary" :loading="syncing" :disabled="disconnecting" @click="syncNow">{{ $strings.ButtonHardcoverSyncNow }}</ui-btn>
        <ui-btn cy-id="disconnect" color="bg-error" :loading="disconnecting" :disabled="syncing" @click="disconnect">{{ $strings.ButtonHardcoverDisconnect }}</ui-btn>
      </div>
    </template>

    <template v-else-if="account">
      <a cy-id="create-token" :href="createTokenUrl" target="_blank" rel="noopener noreferrer" class="text-sm text-blue-300 hover:underline">{{ $strings.ButtonHardcoverCreateToken }}</a>
      <form class="flex flex-wrap items-center gap-2 mt-2" @submit.prevent="connect">
        <input cy-id="token" v-model="token" type="password" autocomplete="off" :aria-label="$strings.LabelHardcoverToken" :placeholder="$strings.LabelHardcoverToken" class="rounded-sm bg-primary text-gray-200 focus:bg-bg focus:outline-hidden border border-gray-600 h-9 px-3 grow max-w-md" />
        <ui-btn cy-id="connect" type="submit" color="bg-success" :loading="connecting" :disabled="!token.trim()">{{ $strings.ButtonHardcoverConnect }}</ui-btn>
      </form>
    </template>
  </div>
</template>

<script>
// What the sync and the friends list use; the form still lets the user change them
const TOKEN_SCOPES = ['read:me:content', 'read:library', 'write:library', 'write:reviews', 'read:catalog', 'read:social']

export default {
  props: {
    dateFormat: {
      type: String,
      default: 'MM/dd/yyyy'
    },
    timeFormat: {
      type: String,
      default: 'HH:mm'
    }
  },
  data() {
    return {
      account: null,
      token: '',
      connecting: false,
      syncing: false,
      disconnecting: false
    }
  },
  computed: {
    createTokenUrl() {
      return `https://hardcover.app/account/api/keys/new?scope=${TOKEN_SCOPES.join('+')}`
    }
  },
  mounted() {
    this.load()
  },
  methods: {
    async load() {
      this.account = await this.$axios.$get('/api/me/hardcover').catch((error) => {
        console.error('Failed to load Hardcover account', error)
        return { connected: false }
      })
    },
    errorMessage(error) {
      return [400, 502].includes(error.response?.status) && error.response.data ? error.response.data : this.$strings.ToastFailedToUpdate
    },
    async connect() {
      this.connecting = true
      try {
        this.account = await this.$axios.$put('/api/me/hardcover', { token: this.token.trim() })
        this.token = ''
      } catch (error) {
        console.error('Failed to connect Hardcover', error)
        this.$toast.error(this.errorMessage(error))
      } finally {
        this.connecting = false
      }
    },
    async syncNow() {
      this.syncing = true
      try {
        this.account = await this.$axios.$post('/api/me/hardcover/sync')
      } catch (error) {
        console.error('Hardcover sync failed', error)
        this.account = { ...this.account, lastError: this.errorMessage(error) }
      } finally {
        this.syncing = false
      }
    },
    async disconnect() {
      this.disconnecting = true
      try {
        this.account = await this.$axios.$delete('/api/me/hardcover')
      } catch (error) {
        console.error('Failed to disconnect Hardcover', error)
        this.$toast.error(this.$strings.ToastFailedToUpdate)
      } finally {
        this.disconnecting = false
      }
    }
  }
}
</script>
