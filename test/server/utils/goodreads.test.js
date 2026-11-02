const { expect } = require('chai')

const goodreads = require('../../../server/utils/goodreads')

const HEADER = 'Book Id,Title,Author,Author l-f,Additional Authors,ISBN,ISBN13,My Rating,Average Rating,Publisher,Binding,Number of Pages,Year Published,Original Publication Year,Date Read,Date Added,Bookshelves,Bookshelves with positions,Exclusive Shelf,My Review,Spoiler,Private Notes,Read Count,Owned Copies'

function exportRow(values) {
  const row = {
    'Book Id': '234225',
    Title: 'Dune (Dune #1)',
    Author: 'Frank Herbert',
    'Author l-f': 'Herbert, Frank',
    'Additional Authors': '',
    ISBN: '="0441172717"',
    ISBN13: '="9780441172719"',
    'My Rating': '5',
    'Average Rating': '4.27',
    Publisher: 'Ace Books',
    Binding: 'Paperback',
    'Number of Pages': '688',
    'Year Published': '2005',
    'Original Publication Year': '1965',
    'Date Read': '2024/03/09',
    'Date Added': '2023/12/25',
    Bookshelves: '',
    'Bookshelves with positions': '',
    'Exclusive Shelf': 'read',
    'My Review': '',
    Spoiler: '',
    'Private Notes': '',
    'Read Count': '1',
    'Owned Copies': '0',
    ...values
  }
  return HEADER.split(',')
    .map((key) => `"${String(row[key]).replace(/"/g, '""')}"`)
    .join(',')
}

describe('goodreads utils', () => {
  describe('parseCsv', () => {
    it('parses quoted fields containing commas, quotes and newlines', () => {
      const rows = goodreads.parseCsv('a,b,c\n"x, y","say ""hi""","line1\nline2"\n')
      expect(rows).to.deep.equal([
        ['a', 'b', 'c'],
        ['x, y', 'say "hi"', 'line1\nline2']
      ])
    })

    it('handles CRLF line endings, a byte order mark and a missing final newline', () => {
      expect(goodreads.parseCsv('﻿a,b\r\n1,2')).to.deep.equal([
        ['a', 'b'],
        ['1', '2']
      ])
    })

    it('keeps empty fields', () => {
      expect(goodreads.parseCsv('a,,c\n')).to.deep.equal([['a', '', 'c']])
    })
  })

  describe('parseGoodreadsExport', () => {
    it('reads a Goodreads library export row', () => {
      const { entries } = goodreads.parseGoodreadsExport(`${HEADER}\n${exportRow({ 'My Review': 'Spice!<br/><br/>Must read &amp; reread.' })}\n`)
      expect(entries).to.have.length(1)
      const [entry] = entries
      expect(entry).to.include({ row: 2, goodreadsId: '234225', title: 'Dune (Dune #1)', author: 'Frank Herbert', isbn10: '0441172717', isbn13: '9780441172719', rating: 5, shelf: 'read', review: 'Spice!\n\nMust read & reread.' })
      expect(entry.dateRead.toISOString()).to.equal('2024-03-09T00:00:00.000Z')
      expect(entry.dateAdded.toISOString()).to.equal('2023-12-25T00:00:00.000Z')
    })

    it('treats a 0 rating, empty ISBN and blank date as missing', () => {
      const { entries } = goodreads.parseGoodreadsExport(`${HEADER}\n${exportRow({ 'My Rating': '0', ISBN: '=""', ISBN13: '=""', 'Date Read': '' })}`)
      expect(entries[0]).to.include({ rating: null, isbn10: null, isbn13: null, dateRead: null, review: null })
    })

    it('rejects a file that is not a Goodreads export', () => {
      expect(goodreads.parseGoodreadsExport('name,score\nx,1').error).to.be.a('string')
      expect(goodreads.parseGoodreadsExport('').error).to.be.a('string')
    })
  })

  describe('isbn helpers', () => {
    it('normalizes ISBN-10 and ISBN-13 to the same ISBN-13', () => {
      expect(goodreads.toIsbn13('0-441-17271-7')).to.equal('9780441172719')
      expect(goodreads.toIsbn13('978-0-441-17271-9')).to.equal('9780441172719')
      expect(goodreads.toIsbn13('080442957X')).to.equal('9780804429573')
    })

    it('returns null for things that are not ISBNs, such as Audible ASINs', () => {
      for (const value of ['B002V1OF70', '', null, '12345', 'abcdefghij']) {
        expect(goodreads.toIsbn13(value), String(value)).to.be.null
      }
    })
  })

  describe('normalizeTitle', () => {
    it('drops series markers, subtitles, leading articles, punctuation and case', () => {
      expect(goodreads.normalizeTitle('Dune (Dune #1)')).to.equal('dune')
      expect(goodreads.normalizeTitle('The Hobbit, or There and Back Again')).to.equal('hobbit or there and back again')
      expect(goodreads.normalizeTitle('Sapiens: A Brief History of Humankind')).to.equal('sapiens')
      expect(goodreads.normalizeTitle('  The   Martian ')).to.equal('martian')
    })
  })

  describe('createMatcher', () => {
    const books = [
      { id: 'b1', libraryItemId: 'li1', title: 'Dune', isbn: '9780441172719', asin: null, authors: ['Frank Herbert'] },
      { id: 'b2', libraryItemId: 'li2', title: 'The Martian', isbn: null, asin: 'B00EMXBDMA', authors: ['Andy Weir'] },
      { id: 'b3', libraryItemId: 'li3', title: 'Project Hail Mary', isbn: null, asin: '0593135202', authors: ['Andy Weir'] },
      { id: 'b4', libraryItemId: 'li4', title: 'Emma', isbn: null, asin: null, authors: ['Jane Austen'] },
      { id: 'b5', libraryItemId: 'li5', title: 'Emma', isbn: null, asin: null, authors: ['Jane Austen'] }
    ]
    const match = goodreads.createMatcher(books)

    it('matches by ISBN, converting ISBN-10 to ISBN-13', () => {
      expect(match({ isbn10: '0441172717', isbn13: null, title: 'x', author: 'y' })).to.deep.include({ method: 'isbn' })
      expect(match({ isbn10: '0441172717', isbn13: null, title: 'x', author: 'y' }).book.id).to.equal('b1')
    })

    it('matches an ISBN-10 stored in the ASIN field', () => {
      const result = match({ isbn10: null, isbn13: '9780593135204', title: 'x', author: 'y' })
      expect(result.book.id).to.equal('b3')
      expect(result.method).to.equal('isbn')
    })

    it('falls back to title and author', () => {
      const result = match({ isbn10: null, isbn13: '9780000000002', title: 'The Martian (Kindle Edition)', author: 'Andy  Weir' })
      expect(result.book.id).to.equal('b2')
      expect(result.method).to.equal('title-author')
    })

    it('does not match a title by a different author', () => {
      expect(match({ isbn10: null, isbn13: null, title: 'Dune', author: 'Someone Else' }).book).to.be.null
    })

    it('reports ambiguous title matches instead of guessing', () => {
      const result = match({ isbn10: null, isbn13: null, title: 'Emma', author: 'Jane Austen' })
      expect(result.book).to.be.null
      expect(result.ambiguous).to.be.true
    })
  })

  describe('buildGoodreadsCsv', () => {
    it('writes a Goodreads import file that parses back', () => {
      const csv = goodreads.buildGoodreadsCsv([
        { title: 'Dune', author: 'Frank Herbert', isbn: '9780441172719', rating: 4.5, review: 'Spice, "melange"\nand more', shelf: 'read', dateRead: new Date('2024-03-09T00:00:00Z'), dateAdded: new Date('2023-12-25T00:00:00Z') },
        { title: 'Emma', author: 'Jane Austen', isbn: null, rating: null, review: null, shelf: 'currently-reading', dateRead: null, dateAdded: null }
      ])
      const [header, dune, emma] = goodreads.parseCsv(csv)
      expect(header).to.deep.equal(['Title', 'Author', 'ISBN', 'My Rating', 'Date Read', 'Date Added', 'Bookshelves', 'My Review'])
      expect(dune).to.deep.equal(['Dune', 'Frank Herbert', '9780441172719', '5', '2024/03/09', '2023/12/25', 'read', 'Spice, "melange"\nand more'])
      expect(emma).to.deep.equal(['Emma', 'Jane Austen', '', '', '', '', 'currently-reading', ''])
    })

    it('rounds half stars up because Goodreads only takes whole stars', () => {
      const ratings = [0.5, 3, 3.5].map((rating) => goodreads.parseCsv(goodreads.buildGoodreadsCsv([{ title: 't', author: 'a', rating }]))[1][3])
      expect(ratings).to.deep.equal(['1', '3', '4'])
    })
  })
})
