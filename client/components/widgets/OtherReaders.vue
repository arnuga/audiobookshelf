<template>
  <!-- Fork addition: other users' ratings, reviews and progress on a book -->
  <div v-if="readers.length" cy-id="other-readers" class="w-full max-w-2xl">
    <p class="text-sm text-gray-300 mb-2">{{ $strings.LabelOtherReaders }}</p>
    <div v-for="reader in readers" :key="reader.userId" cy-id="reader" class="py-2 border-t border-white/10">
      <div class="flex items-center flex-wrap">
        <p class="text-sm text-gray-100 font-semibold mr-3">{{ reader.username }}</p>
        <div v-if="reader.rating" cy-id="stars" role="img" :aria-label="`${reader.rating} / 5`" class="flex items-center mr-3">
          <span v-for="n in 5" :key="n" class="material-symbols text-base text-yellow-400" :class="{ fill: reader.rating >= n - 0.5 }" aria-hidden="true">{{ reader.rating === n - 0.5 ? 'star_half' : 'star' }}</span>
        </div>
        <p cy-id="status" class="text-xs text-gray-400">{{ statusText(reader) }}</p>
      </div>
      <template v-if="reader.review">
        <p cy-id="review" dir="auto" class="text-sm text-gray-200 whitespace-pre-line mt-1" :class="{ 'line-clamp-3': !expanded[reader.userId] }">{{ reader.review }}</p>
        <button v-if="reader.review.length > 200" cy-id="toggle-review" type="button" class="text-xs text-slate-300 hover:text-white" @click="toggle(reader.userId)">{{ expanded[reader.userId] ? $strings.ButtonReadLess : $strings.ButtonReadMore }}</button>
      </template>
    </div>
  </div>
</template>

<script>
export default {
  props: {
    libraryItemId: {
      type: String,
      required: true
    },
    dateFormat: {
      type: String,
      default: 'MM/dd/yyyy'
    }
  },
  data() {
    return {
      readers: [],
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
      const data = await this.$axios.$get(`/api/items/${this.libraryItemId}/reviews`).catch((error) => {
        console.error('Failed to load other readers', error)
        return null
      })
      this.readers = data?.readers || []
      this.expanded = {}
    },
    statusText(reader) {
      if (reader.isFinished) return reader.finishedAt ? `${this.$strings.LabelFinished} ${this.$formatDate(reader.finishedAt, this.dateFormat)}` : this.$strings.LabelFinished
      if (reader.progress > 0) return `${this.$strings.LabelInProgress} ${Math.round(reader.progress * 100)}%`
      return ''
    },
    toggle(userId) {
      this.$set(this.expanded, userId, !this.expanded[userId])
    }
  }
}
</script>
