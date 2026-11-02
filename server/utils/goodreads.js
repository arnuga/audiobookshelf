/**
 * Fork addition: Goodreads CSV import and export.
 *
 * Goodreads has no API, so data moves through the library export CSV
 * (My Books > Import and export > Export Library) and its import page.
 */

const EXPORT_HEADER = ['Title', 'Author', 'ISBN', 'My Rating', 'Date Read', 'Date Added', 'Bookshelves', 'My Review']
const REQUIRED_IMPORT_COLUMNS = ['Title', 'Author', 'My Rating', 'Exclusive Shelf']

/**
 * RFC 4180 CSV parser: quoted fields may contain commas, doubled quotes and newlines.
 *
 * @param {string} text
 * @returns {string[][]}
 */
function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  const input = text.replace(/^﻿/, '')

  for (let i = 0; i < input.length; i++) {
    const char = input[i]
    if (inQuotes) {
      if (char === '"' && input[i + 1] === '"') {
        field += '"'
        i++
      } else if (char === '"') {
        inQuotes = false
      } else {
        field += char
      }
    } else if (char === '"') {
      inQuotes = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += char
    }
  }

  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/**
 * @param {string[]} fields
 * @returns {string}
 */
function toCsvLine(fields) {
  return fields.map((value) => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)).join(',')
}

/**
 * Goodreads writes ISBNs as ="0441172717" so spreadsheets keep the leading zero.
 *
 * @param {string} value
 * @returns {string|null}
 */
function unwrapIsbn(value) {
  const cleaned = (value || '').replace(/^="?|"$/g, '').trim()
  return cleaned || null
}

/**
 * @param {string} value Goodreads date, e.g. 2024/03/09
 * @returns {Date|null}
 */
function parseGoodreadsDate(value) {
  const match = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec((value || '').trim())
  if (!match) return null
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
}

/**
 * @param {Date|null} date
 * @returns {string}
 */
function formatGoodreadsDate(date) {
  if (!date) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())}`
}

/**
 * Goodreads reviews are HTML fragments. Keep line breaks, drop tags, decode the common entities.
 *
 * @param {string} html
 * @returns {string|null}
 */
function reviewToText(html) {
  const text = (html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim()
  return text || null
}

/**
 * @typedef GoodreadsEntry
 * @property {number} row line number in the file, header is line 1
 * @property {string} goodreadsId
 * @property {string} title
 * @property {string} author
 * @property {string|null} isbn10
 * @property {string|null} isbn13
 * @property {number|null} rating 1-5, null when unrated
 * @property {string|null} review
 * @property {string} shelf read, currently-reading, to-read or a custom exclusive shelf
 * @property {Date|null} dateRead
 * @property {Date|null} dateAdded
 */

/**
 * @param {string} text contents of goodreads_library_export.csv
 * @returns {{ entries: GoodreadsEntry[] } | { error: string }}
 */
function parseGoodreadsExport(text) {
  const [header, ...rows] = parseCsv(text || '')
  if (!header || REQUIRED_IMPORT_COLUMNS.some((column) => !header.includes(column))) {
    return { error: 'This does not look like a Goodreads library export (goodreads_library_export.csv)' }
  }

  const column = Object.fromEntries(header.map((name, index) => [name, index]))
  const entries = []
  rows.forEach((fields, index) => {
    const get = (name) => (column[name] === undefined ? '' : (fields[column[name]] ?? '').trim())
    if (!get('Title')) return

    const rating = Number(get('My Rating'))
    entries.push({
      row: index + 2,
      goodreadsId: get('Book Id'),
      title: get('Title'),
      author: get('Author'),
      isbn10: unwrapIsbn(get('ISBN')),
      isbn13: unwrapIsbn(get('ISBN13')),
      rating: rating >= 1 && rating <= 5 ? rating : null,
      review: reviewToText(get('My Review')),
      shelf: get('Exclusive Shelf'),
      dateRead: parseGoodreadsDate(get('Date Read')),
      dateAdded: parseGoodreadsDate(get('Date Added'))
    })
  })
  return { entries }
}

/**
 * @param {string|null} value an ISBN-10 or ISBN-13, with or without dashes
 * @returns {string|null} the ISBN-13, or null when the value is not an ISBN
 */
function toIsbn13(value) {
  const compact = (value || '').replace(/[\s-]/g, '').toUpperCase()
  if (/^97[89]\d{10}$/.test(compact)) return compact
  if (!/^\d{9}[\dX]$/.test(compact)) return null

  const body = `978${compact.slice(0, 9)}`
  const sum = [...body].reduce((total, digit, i) => total + Number(digit) * (i % 2 ? 3 : 1), 0)
  return `${body}${(10 - (sum % 10)) % 10}`
}

/**
 * Reduce a title to the part both services agree on: no series marker, subtitle, leading article or punctuation.
 *
 * @param {string} title
 * @returns {string}
 */
function normalizeTitle(title) {
  return (title || '')
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*$/, '')
    .split(':')[0]
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(the|a|an) /, '')
}

/**
 * @param {string} name
 * @returns {string}
 */
function normalizeAuthor(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * @typedef MatchableBook
 * @property {string} id
 * @property {string} libraryItemId
 * @property {string} title
 * @property {string|null} isbn
 * @property {string|null} asin
 * @property {string[]} authors
 *
 * @typedef MatchResult
 * @property {MatchableBook|null} book
 * @property {'isbn'|'title-author'|null} method
 * @property {boolean} [ambiguous] more than one book fit, so none was picked
 */

/**
 * Build a lookup that matches Goodreads entries to library books by ISBN first, then title and author.
 * The ASIN field is checked too, since Kindle and print ASINs are often the ISBN-10.
 *
 * @param {MatchableBook[]} books
 * @returns {(entry: Pick<GoodreadsEntry, 'isbn10'|'isbn13'|'title'|'author'>) => MatchResult}
 */
function createMatcher(books) {
  /** @type {Map<string, MatchableBook[]>} */
  const byIsbn = new Map()
  /** @type {Map<string, MatchableBook[]>} */
  const byTitleAuthor = new Map()
  const add = (map, key, book) => {
    if (!map.has(key)) map.set(key, [])
    if (!map.get(key).includes(book)) map.get(key).push(book)
  }

  for (const book of books) {
    for (const value of [book.isbn, book.asin]) {
      const isbn = toIsbn13(value)
      if (isbn) add(byIsbn, isbn, book)
    }
    const title = normalizeTitle(book.title)
    for (const author of book.authors) {
      add(byTitleAuthor, `${title}|${normalizeAuthor(author)}`, book)
    }
  }

  return (entry) => {
    const isbns = [...new Set([toIsbn13(entry.isbn13), toIsbn13(entry.isbn10)].filter(Boolean))]
    for (const isbn of isbns) {
      const found = byIsbn.get(isbn)
      if (found?.length === 1) return { book: found[0], method: 'isbn' }
      if (found?.length > 1) return { book: null, method: null, ambiguous: true }
    }

    const found = byTitleAuthor.get(`${normalizeTitle(entry.title)}|${normalizeAuthor(entry.author)}`)
    if (found?.length === 1) return { book: found[0], method: 'title-author' }
    if (found?.length > 1) return { book: null, method: null, ambiguous: true }
    return { book: null, method: null }
  }
}

/**
 * @typedef ExportEntry
 * @property {string} title
 * @property {string} author
 * @property {string|null} [isbn]
 * @property {number|null} [rating] 0.5-5; rounded up to whole stars
 * @property {string|null} [review]
 * @property {string} [shelf]
 * @property {Date|null} [dateRead]
 * @property {Date|null} [dateAdded]
 */

/**
 * Write a CSV that the Goodreads import page accepts.
 *
 * @param {ExportEntry[]} entries
 * @returns {string}
 */
function buildGoodreadsCsv(entries) {
  const lines = [toCsvLine(EXPORT_HEADER)]
  for (const entry of entries) {
    lines.push(toCsvLine([entry.title || '', entry.author || '', toIsbn13(entry.isbn) || '', entry.rating ? String(Math.ceil(entry.rating)) : '', formatGoodreadsDate(entry.dateRead || null), formatGoodreadsDate(entry.dateAdded || null), entry.shelf || '', entry.review || '']))
  }
  return `${lines.join('\n')}\n`
}

module.exports = {
  parseCsv,
  parseGoodreadsExport,
  toIsbn13,
  normalizeTitle,
  createMatcher,
  buildGoodreadsCsv
}
