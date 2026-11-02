const { DataTypes, Model } = require('sequelize')

/**
 * A user's own rating and review of a book.
 *
 * Fork addition: the table is created by sequelize.sync() on startup rather than a migration,
 * because migrations are keyed to the upstream version number and this fork keeps that number.
 *
 * @typedef ReviewPayload
 * @property {number|null} [rating] 0.5-5 in half-star steps, null clears it
 * @property {string|null} [review] free text, null or blank clears it
 */
class UserBookReview extends Model {
  static MAX_REVIEW_LENGTH = 50000

  constructor(values, options) {
    super(values, options)

    /** @type {string} */
    this.id
    /** @type {number|null} */
    this.rating
    /** @type {string|null} */
    this.review
    /** @type {string} */
    this.userId
    /** @type {string} */
    this.bookId
    /** @type {Date} */
    this.createdAt
    /** @type {Date} */
    this.updatedAt
  }

  /**
   * Validate a request body. Omitted fields are left out so they stay unchanged; unknown fields are ignored.
   *
   * @param {*} body
   * @returns {ReviewPayload | { error: string }}
   */
  static parsePayload(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { error: 'Request body must be an object' }
    }

    const payload = {}

    if (body.rating !== undefined) {
      const { rating } = body
      const isValid = rating === null || (typeof rating === 'number' && rating >= 0.5 && rating <= 5 && Number.isInteger(rating * 2))
      if (!isValid) return { error: 'rating must be null or a number from 0.5 to 5 in steps of 0.5' }
      payload.rating = rating
    }

    if (body.review !== undefined) {
      const { review } = body
      if (review !== null && typeof review !== 'string') return { error: 'review must be a string or null' }
      const trimmed = review?.trim() || null
      if (trimmed && trimmed.length > this.MAX_REVIEW_LENGTH) {
        return { error: `review must be at most ${this.MAX_REVIEW_LENGTH} characters` }
      }
      payload.review = trimmed
    }

    return payload
  }

  /**
   * Create or update a user's review. Returns null when nothing is left to keep (the row is removed).
   *
   * @param {string} userId
   * @param {string} bookId
   * @param {ReviewPayload} payload already validated with parsePayload
   * @returns {Promise<UserBookReview|null>}
   */
  static async saveForUser(userId, bookId, payload) {
    const existing = await this.findOne({ where: { userId, bookId } })
    const merged = {
      rating: payload.rating !== undefined ? payload.rating : (existing?.rating ?? null),
      review: payload.review !== undefined ? payload.review : (existing?.review ?? null)
    }

    if (merged.rating === null && merged.review === null) {
      if (existing) await existing.destroy()
      return null
    }

    if (existing) return existing.update(merged)
    return this.create({ userId, bookId, ...merged })
  }

  /**
   * @param {string} libraryItemId
   */
  toJSONForAPI(libraryItemId) {
    return {
      id: this.id,
      libraryItemId,
      bookId: this.bookId,
      userId: this.userId,
      rating: this.rating,
      review: this.review,
      createdAt: this.createdAt.valueOf(),
      updatedAt: this.updatedAt.valueOf()
    }
  }

  /**
   * @param {import('../Database').sequelize} sequelize
   */
  static init(sequelize) {
    super.init(
      {
        id: {
          type: DataTypes.UUID,
          defaultValue: DataTypes.UUIDV4,
          primaryKey: true
        },
        rating: DataTypes.FLOAT,
        review: DataTypes.TEXT
      },
      {
        sequelize,
        modelName: 'userBookReview',
        indexes: [
          {
            name: 'user_book_reviews_user_book_unique',
            unique: true,
            fields: ['userId', 'bookId']
          }
        ]
      }
    )

    const { user, book } = sequelize.models

    user.hasMany(UserBookReview, { onDelete: 'CASCADE' })
    UserBookReview.belongsTo(user)

    book.hasMany(UserBookReview, { onDelete: 'CASCADE' })
    UserBookReview.belongsTo(book)
  }
}

module.exports = UserBookReview
