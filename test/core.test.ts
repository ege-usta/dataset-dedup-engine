import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzeDataset, validateOptions } from '../src/core'

test('normalizes, deduplicates, validates email format, and reports quality', () => {
  const options = validateOptions({ keyFields: ['name', 'url'], fuzzyThreshold: 1 })
  const result = analyzeDataset([
    { name: ' Acme  ', url: 'https://EXAMPLE.com/product/?utm_source=x', email: 'bad' },
    { name: 'acme', url: 'https://example.com/product/', email: 'bad' },
    { name: 'Beta', url: 'https://example.com/beta', email: 'ok@example.com' },
    'malformed'
  ], options)
  assert.equal(result.duplicateRows.length, 1)
  assert.equal(result.rejected.length, 1)
  assert.equal(result.cleaned.length, 2)
  assert.equal(result.summary.invalidEmailFormats, 2)
})

test('detects fuzzy duplicates inside a bounded bucket', () => {
  const result = analyzeDataset([{ name: 'Acme cloud platform service enterprise alpha' }, { name: 'Acme cloud platform service enterprise beta' }], validateOptions({ keyFields: ['name'], fuzzyThreshold: 0.7 }))
  assert.equal(result.duplicateRows[0]?.matchType, 'fuzzy')
})

test('strips tracking parameters and trailing slashes from URLs', () => {
  const result = analyzeDataset([
    { url: 'https://Shop.example.com/item/42/?utm_campaign=fall&gclid=abc#reviews' },
    { url: 'https://shop.example.com/item/42' }
  ], validateOptions({ keyFields: ['url'], fuzzyThreshold: 1 }))
  assert.equal(result.cleaned.length, 1)
  assert.equal(result.cleaned[0]?.url, 'https://shop.example.com/item/42')
  assert.equal(result.summary.exactDuplicates, 1)
})

test('ignoreFields keeps volatile columns out of the duplicate key', () => {
  const rows = [{ sku: 'A1', scrapedAt: '2026-10-01' }, { sku: 'A1', scrapedAt: '2026-10-02' }]
  assert.equal(analyzeDataset(rows, validateOptions({ fuzzyThreshold: 1 })).duplicateRows.length, 0)
  assert.equal(analyzeDataset(rows, validateOptions({ ignoreFields: ['scrapedAt'], fuzzyThreshold: 1 })).duplicateRows.length, 1)
})

test('reports missing values and fields with mixed types', () => {
  const result = analyzeDataset([{ price: 10, title: 'a' }, { price: '10', title: '' }, { price: null, title: 'c' }], validateOptions({ fuzzyThreshold: 1 }))
  assert.deepEqual(result.summary.missingByField, { title: 1, price: 1 })
  const inconsistent = result.summary.inconsistentFields as Array<{ field: string }>
  assert.deepEqual(inconsistent.map((row) => row.field), ['price'])
  assert.ok((result.summary.qualityScore as number) < 100)
})

test('a clean dataset scores 100', () => {
  const result = analyzeDataset([{ id: 'a' }, { id: 'b' }], validateOptions({}))
  assert.equal(result.summary.qualityScore, 100)
  assert.equal(result.summary.completenessScore, 100)
})

test('stops fuzzy matching at the comparison limit', () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({ name: `acme widget model number ${i}` }))
  const result = analyzeDataset(rows, validateOptions({ fuzzyThreshold: 0.99, maxComparisons: 1000 }))
  assert.equal(result.summary.fuzzyComparisons, 1000)
  assert.equal(result.summary.comparisonLimitReached, true)
})

test('rejects invalid options', () => {
  assert.throws(() => validateOptions({ fuzzyThreshold: 0.2 }), /fuzzyThreshold/)
  assert.throws(() => validateOptions({ maxComparisons: 1500.5 }), /integer/)
  assert.throws(() => validateOptions({ keyFields: [''] }), /keyFields/)
})

test('field names alone never make two records fuzzy duplicates', () => {
  const result = analyzeDataset([{ productId: 'x' }, { productId: 'y' }], validateOptions({ fuzzyThreshold: 0.7 }))
  assert.equal(result.duplicateRows.length, 0)
})
