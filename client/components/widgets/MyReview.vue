<template>
  <!-- Fork addition: the current user's rating and review of a book -->
  <div class="w-full max-w-2xl">
    <div class="flex items-center mb-2">
      <p class="text-sm text-gray-300 mr-3">{{ $strings.LabelYourRating }}</p>
      <div cy-id="rating" role="slider" :aria-label="$strings.LabelYourRating" aria-valuemin="0" aria-valuemax="5" :aria-valuenow="String(rating || 0)" class="flex items-center" @mouseleave="hoverRating = null">
        <div v-for="n in 5" :key="n" class="relative w-7 h-7">
          <span class="material-symbols text-2xl text-yellow-400 pointer-events-none" :class="{ fill: displayRating >= n - 0.5 }" aria-hidden="true">{{ displayRating === n - 0.5 ? 'star_half' : 'star' }}</span>
          <button v-for="value in [n - 0.5, n]" :key="value" type="button" :cy-id="`star-${value}`" :aria-label="`${value} / 5`" :disabled="saving" class="absolute top-0 h-full w-1/2" :class="value === n ? 'right-0' : 'left-0'" @mouseenter="hoverRating = value" @focus="hoverRating = value" @blur="hoverRating = null" @click="clickStar(value)" />
        </div>
      </div>
    </div>

    <label for="my-review-text" class="text-sm text-gray-300">{{ $strings.LabelYourReview }}</label>
    <ui-textarea-input id="my-review-text" v-model="reviewDraft" :rows="3" :placeholder="$strings.PlaceholderReview" :disabled="saving" class="w-full mt-1" />

    <div class="flex items-center justify-end mt-2">
      <ui-btn v-if="hasReview" cy-id="delete" small color="bg-error" :disabled="saving" class="mr-2" @click="deleteReview">{{ $strings.ButtonDelete }}</ui-btn>
      <ui-btn v-if="isReviewDirty" cy-id="save" small color="bg-success" :loading="saving" @click="saveReviewText">{{ $strings.ButtonSave }}</ui-btn>
    </div>
  </div>
</template>

<script>
export default {
  props: {
    libraryItemId: {
      type: String,
      required: true
    }
  },
  data() {
    return {
      rating: null,
      review: null,
      reviewDraft: '',
      hoverRating: null,
      saving: false
    }
  },
  computed: {
    endpoint() {
      return `/api/items/${this.libraryItemId}/review`
    },
    displayRating() {
      return this.hoverRating ?? this.rating ?? 0
    },
    hasReview() {
      return this.rating !== null || !!this.review
    },
    isReviewDirty() {
      return (this.reviewDraft || '').trim() !== (this.review || '')
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
    apply(data) {
      this.rating = data?.rating ?? null
      this.review = data?.review ?? null
      this.reviewDraft = this.review || ''
    },
    async load() {
      const data = await this.$axios.$get(this.endpoint).catch((error) => {
        console.error('Failed to load review', error)
        return null
      })
      this.apply(data)
    },
    async save(payload) {
      this.saving = true
      try {
        const data = await this.$axios.$put(this.endpoint, payload)
        // Keep any unsaved review draft when only the rating changed
        const draft = this.reviewDraft
        this.apply(data)
        if (payload.review === undefined) this.reviewDraft = draft
      } catch (error) {
        console.error('Failed to save review', error)
        this.$toast.error(this.$strings.ToastFailedToUpdate)
      } finally {
        this.saving = false
      }
    },
    clickStar(value) {
      this.save({ rating: value === this.rating ? null : value })
    },
    saveReviewText() {
      this.save({ review: (this.reviewDraft || '').trim() })
    },
    async deleteReview() {
      this.saving = true
      try {
        await this.$axios.$delete(this.endpoint)
        this.apply(null)
      } catch (error) {
        console.error('Failed to delete review', error)
        this.$toast.error(this.$strings.ToastFailedToUpdate)
      } finally {
        this.saving = false
      }
    }
  }
}
</script>
