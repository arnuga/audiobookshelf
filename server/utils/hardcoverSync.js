/**
 * Fork addition: decide what to send to and take from Hardcover for one book.
 *
 * Works like a three-way merge: each side is compared with the values both agreed on at the last sync (the base).
 * A field changed on one side only is copied to the other. Changed on both, or never synced, the newer edit wins.
 */

const FIELDS = ['rating', 'review']

/**
 * @typedef SideState
 * @property {number|null} rating
 * @property {string|null} review
 * @property {Date|number|string|null} updatedAt
 *
 * @typedef SyncedValues
 * @property {number|null} rating
 * @property {string|null} review
 *
 * @typedef MergePlan
 * @property {Partial<SyncedValues>} push fields to write to Hardcover
 * @property {Partial<SyncedValues>} pull fields to write to Audiobookshelf
 * @property {SyncedValues} base what both sides hold once the plan is applied
 */

/**
 * @param {number|null|undefined} rating
 * @returns {number|null} 0.5-5 in half steps, or null
 */
function normalizeRating(rating) {
  if (typeof rating !== 'number' || !(rating > 0)) return null
  return Math.min(5, Math.max(0.5, Math.round(rating * 2) / 2))
}

/**
 * @param {string|null|undefined} review
 * @returns {string|null}
 */
function normalizeReview(review) {
  return typeof review === 'string' ? review.trim() || null : null
}

/**
 * @param {Partial<SideState>|null} side
 * @returns {SyncedValues}
 */
function normalize(side) {
  return { rating: normalizeRating(side?.rating), review: normalizeReview(side?.review) }
}

/**
 * @param {Partial<SideState>|null} side
 * @returns {number}
 */
function editTime(side) {
  return side?.updatedAt ? new Date(side.updatedAt).valueOf() : 0
}

/**
 * @param {Object} params
 * @param {SideState|null} params.local the user's Audiobookshelf rating and review, null when there is none
 * @param {SideState|null} params.remote the user's Hardcover library entry, null when the book is not on their shelf
 * @param {SyncedValues|null} params.base values from the last sync, null before the first one
 * @returns {MergePlan}
 */
function planMerge({ local, remote, base }) {
  const ours = normalize(local)
  const theirs = normalize(remote)
  const synced = base ? normalize(base) : null
  const localIsNewer = editTime(local) >= editTime(remote)

  /** @type {MergePlan} */
  const plan = { push: {}, pull: {}, base: { ...ours } }
  for (const field of FIELDS) {
    if (ours[field] === theirs[field]) continue

    let keepOurs
    if (!synced) {
      // First sync: fill gaps, and only a real disagreement goes to the newer edit
      if (ours[field] === null) keepOurs = false
      else if (theirs[field] === null) keepOurs = true
      else keepOurs = localIsNewer
    } else {
      const oursChanged = ours[field] !== synced[field]
      const theirsChanged = theirs[field] !== synced[field]
      keepOurs = oursChanged && theirsChanged ? localIsNewer : oursChanged
    }

    if (keepOurs) {
      plan.push[field] = ours[field]
    } else {
      plan.pull[field] = theirs[field]
      plan.base[field] = theirs[field]
    }
  }
  return plan
}

module.exports = {
  normalizeRating,
  normalizeReview,
  planMerge
}
