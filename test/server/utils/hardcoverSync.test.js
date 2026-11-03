const { expect } = require('chai')

const { planMerge } = require('../../../server/utils/hardcoverSync')

describe('hardcoverSync', () => {
  describe('planMerge', () => {
    const older = new Date('2026-01-01T00:00:00Z')
    const newer = new Date('2026-02-01T00:00:00Z')

    it('does nothing when both sides agree', () => {
      const plan = planMerge({ local: { rating: 4, review: 'Good', updatedAt: older }, remote: { rating: 4, review: 'Good', updatedAt: newer }, base: null })
      expect(plan.push).to.deep.equal({})
      expect(plan.pull).to.deep.equal({})
      expect(plan.base).to.deep.equal({ rating: 4, review: 'Good' })
    })

    it('fills gaps both ways on the first sync', () => {
      const plan = planMerge({ local: { rating: 4, review: null, updatedAt: older }, remote: { rating: null, review: 'From Hardcover', updatedAt: older }, base: null })
      expect(plan.push).to.deep.equal({ rating: 4 })
      expect(plan.pull).to.deep.equal({ review: 'From Hardcover' })
      expect(plan.base).to.deep.equal({ rating: 4, review: 'From Hardcover' })
    })

    it('pushes a book Hardcover does not have yet', () => {
      const plan = planMerge({ local: { rating: 3.5, review: 'Fine', updatedAt: older }, remote: null, base: null })
      expect(plan.push).to.deep.equal({ rating: 3.5, review: 'Fine' })
      expect(plan.pull).to.deep.equal({})
    })

    it('pulls a book Audiobookshelf has no review for', () => {
      const plan = planMerge({ local: null, remote: { rating: 5, review: null, updatedAt: older }, base: null })
      expect(plan.pull).to.deep.equal({ rating: 5 })
      expect(plan.push).to.deep.equal({})
    })

    it('lets the newer edit win when the first sync finds two different values', () => {
      expect(planMerge({ local: { rating: 2, review: null, updatedAt: newer }, remote: { rating: 4, review: null, updatedAt: older }, base: null }).push).to.deep.equal({ rating: 2 })
      expect(planMerge({ local: { rating: 2, review: null, updatedAt: older }, remote: { rating: 4, review: null, updatedAt: newer }, base: null }).pull).to.deep.equal({ rating: 4 })
    })

    it('sends a change made only in Audiobookshelf, even when Hardcover was touched more recently', () => {
      const plan = planMerge({ local: { rating: 5, review: 'Loved it', updatedAt: older }, remote: { rating: 3, review: 'Loved it', updatedAt: newer }, base: { rating: 3, review: 'Loved it' } })
      expect(plan.push).to.deep.equal({ rating: 5 })
      expect(plan.pull).to.deep.equal({})
    })

    it('takes a change made only on Hardcover', () => {
      const plan = planMerge({ local: { rating: 3, review: 'Old', updatedAt: newer }, remote: { rating: 3, review: 'Edited', updatedAt: older }, base: { rating: 3, review: 'Old' } })
      expect(plan.pull).to.deep.equal({ review: 'Edited' })
      expect(plan.push).to.deep.equal({})
    })

    it('lets the newer edit win when both sides changed since the last sync', () => {
      const base = { rating: 3, review: null }
      expect(planMerge({ local: { rating: 4, review: null, updatedAt: newer }, remote: { rating: 2, review: null, updatedAt: older }, base }).push).to.deep.equal({ rating: 4 })
      expect(planMerge({ local: { rating: 4, review: null, updatedAt: older }, remote: { rating: 2, review: null, updatedAt: newer }, base }).pull).to.deep.equal({ rating: 2 })
    })

    it('sends a cleared value after a sync', () => {
      const plan = planMerge({ local: null, remote: { rating: 4, review: 'Gone', updatedAt: older }, base: { rating: 4, review: 'Gone' } })
      expect(plan.push).to.deep.equal({ rating: null, review: null })
      expect(plan.base).to.deep.equal({ rating: null, review: null })
    })

    it('takes a value cleared on Hardcover after a sync', () => {
      const plan = planMerge({ local: { rating: 4, review: 'Kept', updatedAt: older }, remote: { rating: null, review: 'Kept', updatedAt: older }, base: { rating: 4, review: 'Kept' } })
      expect(plan.pull).to.deep.equal({ rating: null })
    })

    it('treats blank reviews and surrounding whitespace as no difference', () => {
      const plan = planMerge({ local: { rating: null, review: 'Same', updatedAt: older }, remote: { rating: null, review: '  Same\n', updatedAt: newer }, base: null })
      expect(plan.push).to.deep.equal({})
      expect(plan.pull).to.deep.equal({})
      expect(planMerge({ local: null, remote: { rating: 4, review: '   ', updatedAt: older }, base: null }).pull).to.deep.equal({ rating: 4 })
    })

    it('rounds Hardcover ratings that are not half steps to the nearest half star', () => {
      expect(planMerge({ local: null, remote: { rating: 3.8, review: null, updatedAt: older }, base: null }).pull).to.deep.equal({ rating: 4 })
    })
  })
})
