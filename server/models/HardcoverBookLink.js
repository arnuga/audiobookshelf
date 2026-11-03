const { DataTypes, Model } = require('sequelize')

/**
 * Pairs a library book with a Hardcover book for one user, and keeps the rating and review
 * both sides held after the last sync, which is the base for the next three-way merge.
 *
 * Fork addition: created by sequelize.sync() on startup, like UserBookReview.
 */
class HardcoverBookLink extends Model {
  constructor(values, options) {
    super(values, options)

    /** @type {string} */
    this.id
    /** @type {string} */
    this.userId
    /** @type {string} */
    this.bookId
    /** @type {number} */
    this.hardcoverBookId
    /** @type {number|null} the user's Hardcover library entry, null until the book is on their shelf */
    this.userBookId
    /** @type {number|null} */
    this.syncedRating
    /** @type {string|null} */
    this.syncedReview
    /** @type {Date} */
    this.syncedAt
  }

  /** @returns {import('../utils/hardcoverSync').SyncedValues} */
  get base() {
    return { rating: this.syncedRating, review: this.syncedReview }
  }

  /**
   * @param {import('sequelize').Sequelize} sequelize
   */
  static init(sequelize) {
    super.init(
      {
        id: {
          type: DataTypes.UUID,
          defaultValue: DataTypes.UUIDV4,
          primaryKey: true
        },
        hardcoverBookId: {
          type: DataTypes.INTEGER,
          allowNull: false
        },
        userBookId: DataTypes.INTEGER,
        syncedRating: DataTypes.FLOAT,
        syncedReview: DataTypes.TEXT,
        syncedAt: DataTypes.DATE
      },
      {
        sequelize,
        modelName: 'hardcoverBookLink',
        indexes: [
          {
            name: 'hardcover_book_links_user_book_unique',
            unique: true,
            fields: ['userId', 'bookId']
          }
        ]
      }
    )

    const { user, book } = sequelize.models

    user.hasMany(HardcoverBookLink, { onDelete: 'CASCADE' })
    HardcoverBookLink.belongsTo(user)

    book.hasMany(HardcoverBookLink, { onDelete: 'CASCADE' })
    HardcoverBookLink.belongsTo(book)
  }
}

module.exports = HardcoverBookLink
