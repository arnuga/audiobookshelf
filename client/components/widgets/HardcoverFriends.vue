<template>
  <!-- Fork addition: ratings and reviews of the people the user follows on Hardcover -->
  <div v-if="friends.length" cy-id="hardcover-friends" class="w-full max-w-2xl">
    <p class="text-sm text-gray-300 mb-2">{{ $strings.LabelHardcoverFriends }}</p>
    <div v-for="friend in friends" :key="friend.hardcoverUserId" cy-id="friend" class="py-2 border-t border-white/10">
      <div class="flex items-center flex-wrap">
        <a :href="`https://hardcover.app/@${friend.username}`" target="_blank" rel="noopener noreferrer" class="text-sm text-gray-100 font-semibold mr-3 hover:underline">{{ friend.name || friend.username }}</a>
        <div v-if="friend.rating" cy-id="stars" role="img" :aria-label="`${friend.rating} / 5`" class="flex items-center mr-3">
          <span v-for="n in 5" :key="n" class="material-symbols text-base text-yellow-400" :class="{ fill: friend.rating >= n - 0.5 }" aria-hidden="true">{{ friend.rating === n - 0.5 ? 'star_half' : 'star' }}</span>
        </div>
        <p class="text-xs text-gray-400">{{ statusText(friend.status) }}</p>
      </div>
      <template v-if="friend.review">
        <p cy-id="review" dir="auto" class="text-sm text-gray-200 whitespace-pre-line mt-1" :class="{ 'line-clamp-3': !expanded[friend.hardcoverUserId] }">{{ friend.review }}</p>
        <button v-if="friend.review.length > 200" cy-id="toggle-review" type="button" class="text-xs text-slate-300 hover:text-white" @click="toggle(friend.hardcoverUserId)">{{ expanded[friend.hardcoverUserId] ? $strings.ButtonReadLess : $strings.ButtonReadMore }}</button>
      </template>
    </div>
  </div>
</template>

<script>
const STATUS_STRINGS = {
  read: 'LabelHardcoverStatusRead',
  reading: 'LabelHardcoverStatusReading',
  'want-to-read': 'LabelHardcoverStatusWantToRead',
  paused: 'LabelHardcoverStatusPaused',
  'did-not-finish': 'LabelHardcoverStatusDidNotFinish'
}

export default {
  props: {
    libraryItemId: {
      type: String,
      required: true
    }
  },
  data() {
    return {
      friends: [],
      expanded: {}
    }
  },
  watch: {
    libraryItemId: {
      immediate: true,
      handler() {
        this.load()
      }
    }
  },
  methods: {
    async load() {
      const data = await this.$axios.$get(`/api/items/${this.libraryItemId}/hardcover-friends`).catch((error) => {
        console.error('Failed to load Hardcover friends', error)
        return null
      })
      this.friends = data?.friends || []
      this.expanded = {}
    },
    statusText(status) {
      return STATUS_STRINGS[status] ? this.$strings[STATUS_STRINGS[status]] : ''
    },
    toggle(id) {
      this.$set(this.expanded, id, !this.expanded[id])
    }
  }
}
</script>
