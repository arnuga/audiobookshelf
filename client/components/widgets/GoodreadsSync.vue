<template>
  <!-- Fork addition: Goodreads CSV import with preview, and export for the Goodreads import page -->
  <div class="w-full">
    <p class="text-sm text-gray-200 mb-4">{{ $strings.MessageGoodreadsHelp }}</p>

    <div class="flex flex-wrap items-center gap-2">
      <input ref="fileInput" cy-id="file" type="file" accept=".csv,text/csv" class="hidden" @change="fileChosen" />
      <ui-btn color="bg-primary" :loading="previewing" :disabled="applying" @click="$refs.fileInput.click()">{{ $strings.ButtonGoodreadsChooseFile }}</ui-btn>
      <ui-btn cy-id="export" color="bg-primary" :loading="exporting" @click="exportCsv">{{ $strings.ButtonGoodreadsExport }}</ui-btn>
    </div>

    <template v-if="result">
      <div class="flex flex-wrap items-center gap-2 mt-4">
        <p cy-id="summary" class="text-sm text-gray-100 grow">{{ $getString('MessageGoodreadsSummary', [result.summary.matched, result.summary.total, result.summary.changes]) }}</p>
        <ui-btn v-if="!result.applied && result.summary.changes" cy-id="apply" small color="bg-success" :loading="applying" @click="applyImport">{{ $getString('ButtonGoodreadsApply', [result.summary.changes]) }}</ui-btn>
      </div>

      <div class="mt-2 max-h-96 overflow-y-auto">
        <table class="w-full text-sm">
          <tr v-for="row in result.rows" :key="row.row" cy-id="row" class="border-t border-white/10 align-top">
            <td class="py-1 pr-2">
              <p class="text-gray-100">{{ row.title }}</p>
              <p class="text-xs text-gray-400">{{ row.author }}</p>
            </td>
            <td class="py-1 text-xs" :class="row.status === 'matched' ? 'text-gray-200' : 'text-gray-400'">{{ describeRow(row) }}</td>
          </tr>
        </table>
      </div>
    </template>
  </div>
</template>

<script>
const ACTION_STRINGS = {
  rating: 'LabelGoodreadsActionRating',
  review: 'LabelGoodreadsActionReview',
  finished: 'LabelGoodreadsActionFinished'
}
const NOTE_STRINGS = {
  'rating-kept': 'LabelGoodreadsNoteRatingKept',
  'review-kept': 'LabelGoodreadsNoteReviewKept',
  'review-invalid': 'LabelGoodreadsNoteReviewInvalid'
}

export default {
  data() {
    return {
      csv: null,
      result: null,
      previewing: false,
      applying: false,
      exporting: false
    }
  },
  methods: {
    describeRow(row) {
      if (row.status === 'unmatched') return this.$strings.LabelGoodreadsNotInLibrary
      if (row.status === 'ambiguous') return this.$strings.LabelGoodreadsAmbiguous
      const parts = [...row.actions.map((a) => this.$strings[ACTION_STRINGS[a]]), ...row.notes.map((n) => this.$strings[NOTE_STRINGS[n]])]
      return parts.length ? parts.join(', ') : this.$strings.LabelGoodreadsNoChanges
    },
    async fileChosen(event) {
      const file = event.target.files?.[0]
      event.target.value = ''
      if (!file) return
      this.csv = await file.text()
      this.result = null
      this.previewing = true
      this.result = await this.runImport(false)
      this.previewing = false
    },
    async applyImport() {
      this.applying = true
      const result = await this.runImport(true)
      this.applying = false
      if (!result) return
      this.result = result
      this.$toast.success(this.$getString('MessageGoodreadsApplied', [result.summary.changes]))
    },
    async runImport(apply) {
      try {
        return await this.$axios.$post('/api/me/goodreads/import', { csv: this.csv, apply })
      } catch (error) {
        console.error('Goodreads import failed', error)
        this.$toast.error(error.response?.status === 400 && error.response.data ? error.response.data : this.$strings.ToastFailedToUpdate)
        return null
      }
    },
    async exportCsv() {
      this.exporting = true
      try {
        const csv = await this.$axios.$get('/api/me/goodreads/export', { responseType: 'text' })
        const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
        const link = document.createElement('a')
        link.href = url
        link.download = 'audiobookshelf_goodreads_import.csv'
        link.click()
        URL.revokeObjectURL(url)
      } catch (error) {
        console.error('Goodreads export failed', error)
        this.$toast.error(this.$strings.ToastFailedToUpdate)
      } finally {
        this.exporting = false
      }
    }
  }
}
</script>
