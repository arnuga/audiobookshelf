const { DataTypes, Model } = require('sequelize')

/**
 * A user's connection to their Hardcover account, and where the last sync left off.
 *
 * Fork addition: created by sequelize.sync() on startup, like UserBookReview.
 * The token is the user's own personal access token. It is never sent back to the client.
 */
class HardcoverAccount extends Model {
  constructor(values, options) {
    super(values, options)

    /** @type {string} */
    this.id
    /** @type {string} */
    this.userId
    /** @type {string} */
    this.token
    /** @type {number} */
    this.hardcoverUserId
    /** @type {string|null} */
    this.hardcoverUsername
    /** @type {string|null} library changes cursor from the SDK, null before the first sync */
    this.cursor
    /** @type {Date|null} */
    this.lastSyncAt
    /** @type {string|null} */
    this.lastError
    /** @type {Object|null} */
    this.lastSummary
  }

  toJSONForAPI() {
    return {
      connected: true,
      hardcoverUsername: this.hardcoverUsername,
      lastSyncAt: this.lastSyncAt?.valueOf() ?? null,
      lastError: this.lastError,
      lastSummary: this.lastSummary
    }
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
        token: {
          type: DataTypes.TEXT,
          allowNull: false
        },
        hardcoverUserId: DataTypes.INTEGER,
        hardcoverUsername: DataTypes.STRING,
        cursor: DataTypes.STRING,
        lastSyncAt: DataTypes.DATE,
        lastError: DataTypes.TEXT,
        lastSummary: DataTypes.JSON
      },
      {
        sequelize,
        modelName: 'hardcoverAccount',
        indexes: [
          {
            name: 'hardcover_accounts_user_unique',
            unique: true,
            fields: ['userId']
          }
        ]
      }
    )

    const { user } = sequelize.models

    user.hasOne(HardcoverAccount, { onDelete: 'CASCADE' })
    HardcoverAccount.belongsTo(user)
  }
}

module.exports = HardcoverAccount
