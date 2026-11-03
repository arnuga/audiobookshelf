const Database = require('../Database')

/**
 * Fork addition: books in libraries and with tags the user can access, in the shape the matcher needs.
 * Shared by the Goodreads import and the Hardcover sync.
 *
 * @param {import('../models/User')} user
 * @returns {Promise<import('./goodreads').MatchableBook[]>}
 */
async function loadAccessibleBooks(user) {
  const libraryItems = await Database.libraryItemModel.findAll({
    where: { mediaType: 'book' },
    // mediaId is the join key; LibraryItem's afterFind hook needs mediaType to move the book to .media
    attributes: ['id', 'libraryId', 'mediaId', 'mediaType'],
    include: {
      model: Database.bookModel,
      attributes: ['id', 'title', 'isbn', 'asin', 'explicit', 'tags'],
      include: { model: Database.authorModel, attributes: ['name'], through: { attributes: [] } }
    }
  })

  return libraryItems.filter((li) => li.media && user.checkCanAccessLibraryItem(li)).map((li) => ({ id: li.media.id, libraryItemId: li.id, title: li.media.title, isbn: li.media.isbn, asin: li.media.asin, authors: (li.media.authors || []).map((a) => a.name) }))
}

module.exports = { loadAccessibleBooks }
