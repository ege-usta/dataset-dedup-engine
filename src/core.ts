export interface Options {
  keyFields: string[]
  ignoreFields: string[]
  fuzzyThreshold: number
  normalizeCase: boolean
  trimWhitespace: boolean
  normalizeUrls: boolean
  removeEmptyStrings: boolean
  validateEmailFormat: boolean
  maxComparisons: number
}

export interface Analysis {
  cleaned: Array<Record<string, unknown> & { _qualityIssues?: string[] }>
  rejected: Array<{ rowType: 'rejected'; sourceIndex: number; reason: string; record?: unknown }>
  duplicateRows: Array<{ rowType: 'duplicate'; sourceIndex: number; duplicateOf: number; matchType: 'exact' | 'fuzzy'; similarity: number }>
  summary: Record<string, unknown>
}

export function analyzeDataset(rows: unknown[], options: Options): Analysis {
  const cleaned: Array<Record<string, unknown> & { _qualityIssues?: string[] }> = []
  const rejected: Analysis['rejected'] = []
  const duplicateRows: Analysis['duplicateRows'] = []
  const exact = new Map<string, number>()
  const fuzzyBuckets = new Map<string, Array<{ sourceIndex: number; signature: Set<string>; text: string }>>()
  const fieldTypes = new Map<string, Map<string, number>>()
  const missing = new Map<string, number>()
  let fieldsSeen = 0
  let invalidEmails = 0
  let comparisons = 0

  rows.forEach((raw, sourceIndex) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      rejected.push({ rowType: 'rejected', sourceIndex, reason: 'Record is not an object.', record: raw })
      return
    }
    const record = normalizeRecord(raw as Record<string, unknown>, options)
    const fields = Object.keys(record).filter((field) => !options.ignoreFields.includes(field)).sort()
    const issues: string[] = []
    for (const field of fields) {
      fieldsSeen += 1
      const value = record[field]
      const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
      const counts = fieldTypes.get(field) ?? new Map<string, number>()
      counts.set(type, (counts.get(type) ?? 0) + 1)
      fieldTypes.set(field, counts)
      if (isMissing(value)) missing.set(field, (missing.get(field) ?? 0) + 1)
      if (options.validateEmailFormat && /email/i.test(field) && typeof value === 'string' && value && !EMAIL.test(value)) {
        invalidEmails += 1
        issues.push(`invalid_email:${field}`)
      }
    }

    const text = signatureText(record, options)
    const priorExact = exact.get(text)
    if (priorExact !== undefined) {
      duplicateRows.push({ rowType: 'duplicate', sourceIndex, duplicateOf: priorExact, matchType: 'exact', similarity: 1 })
      return
    }

    const signature = tokenSet(valueText(record, options))
    const bucketKey = `${[...signature][0] ?? '_'}:${Math.floor(signature.size / 5)}`
    const bucket = fuzzyBuckets.get(bucketKey) ?? []
    let fuzzy: { sourceIndex: number; similarity: number } | undefined
    if (options.fuzzyThreshold < 1 && signature.size > 0) {
      for (const candidate of bucket) {
        if (comparisons >= options.maxComparisons) break
        comparisons += 1
        const similarity = jaccard(signature, candidate.signature)
        if (similarity >= options.fuzzyThreshold && (!fuzzy || similarity > fuzzy.similarity)) fuzzy = { sourceIndex: candidate.sourceIndex, similarity }
      }
    }
    if (fuzzy) {
      duplicateRows.push({ rowType: 'duplicate', sourceIndex, duplicateOf: fuzzy.sourceIndex, matchType: 'fuzzy', similarity: round(fuzzy.similarity) })
      return
    }

    exact.set(text, sourceIndex)
    bucket.push({ sourceIndex, signature, text })
    fuzzyBuckets.set(bucketKey, bucket)
    cleaned.push(issues.length ? { ...record, _qualityIssues: issues } : record)
  })

  const inconsistentFields = [...fieldTypes.entries()].filter(([, types]) => [...types.keys()].filter((type) => type !== 'null').length > 1).map(([field, types]) => ({ field, observedTypes: Object.fromEntries(types) }))
  const missingValues = [...missing.values()].reduce((sum, value) => sum + value, 0)
  const original = rows.length
  const duplicates = duplicateRows.length
  const malformed = rejected.length
  const denominator = Math.max(1, fieldsSeen)
  const qualityScore = Math.max(0, Math.round(100 - (duplicates / Math.max(1, original)) * 35 - (malformed / Math.max(1, original)) * 20 - (missingValues / denominator) * 30 - (invalidEmails / denominator) * 10 - Math.min(15, inconsistentFields.length * 3)))
  return {
    cleaned, rejected, duplicateRows,
    summary: {
      rowType: 'summary', originalRowCount: original, cleanedRowCount: cleaned.length, duplicatesRemoved: duplicates,
      exactDuplicates: duplicateRows.filter((row) => row.matchType === 'exact').length,
      fuzzyDuplicates: duplicateRows.filter((row) => row.matchType === 'fuzzy').length,
      malformedRecords: malformed, invalidEmailFormats: invalidEmails, missingValues,
      duplicatePercentage: round((duplicates / Math.max(1, original)) * 100), completenessScore: Math.max(0, round(100 - (missingValues / denominator) * 100)),
      qualityScore, inconsistentFields, missingByField: Object.fromEntries(missing), fuzzyComparisons: comparisons,
      comparisonLimitReached: comparisons >= options.maxComparisons,
    },
  }
}

export function validateOptions(value: Partial<Options>): Options {
  return {
    keyFields: stringList(value.keyFields, 'keyFields', 50),
    ignoreFields: stringList(value.ignoreFields, 'ignoreFields', 50),
    fuzzyThreshold: number(value.fuzzyThreshold, 0.9, 0.7, 1, 'fuzzyThreshold'),
    normalizeCase: boolean(value.normalizeCase, true, 'normalizeCase'),
    trimWhitespace: boolean(value.trimWhitespace, true, 'trimWhitespace'),
    normalizeUrls: boolean(value.normalizeUrls, true, 'normalizeUrls'),
    removeEmptyStrings: boolean(value.removeEmptyStrings, false, 'removeEmptyStrings'),
    validateEmailFormat: boolean(value.validateEmailFormat, true, 'validateEmailFormat'),
    maxComparisons: integer(value.maxComparisons, 100000, 1000, 1000000, 'maxComparisons'),
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function normalizeRecord(record: Record<string, unknown>, options: Options): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  for (const [field, raw] of Object.entries(record)) {
    let value: unknown = raw
    if (typeof raw === 'string') {
      let text = raw
      if (options.trimWhitespace) text = text.trim().replace(/\s+/g, ' ')
      if (options.normalizeUrls && /^https?:\/\//i.test(text)) text = normalizeUrl(text)
      else if (options.normalizeCase) text = text.toLowerCase()
      value = options.removeEmptyStrings && text === '' ? null : text
    }
    output[field] = value
  }
  return output
}

function signatureText(record: Record<string, unknown>, options: Options): string {
  const fields = keyFieldsOf(record, options)
  return JSON.stringify(
    Object.fromEntries(fields.map((field) => [field, stable(record[field])]))
  )
}

// Fuzzy tokens come from values only; field names would make every record look alike.
function valueText(record: Record<string, unknown>, options: Options): string {
  return keyFieldsOf(record, options).map((field) => JSON.stringify(stable(record[field])) ?? '').join(' ')
}

function keyFieldsOf(record: Record<string, unknown>, options: Options): string[] {
  return (options.keyFields.length ? options.keyFields : Object.keys(record)).filter((field) => !options.ignoreFields.includes(field)).sort()
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]))
  return value
}

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value)
    url.hash = ''
    ;['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid'].forEach((key) => url.searchParams.delete(key))
    url.hostname = url.hostname.toLowerCase()
    if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '')
    url.searchParams.sort()
    return url.toString()
  } catch { return value }
}

function tokenSet(value: string): Set<string> { return new Set(value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((token) => token.length > 1)) }
function jaccard(a: Set<string>, b: Set<string>): number { const intersection = [...a].filter((item) => b.has(item)).length; const union = new Set([...a, ...b]).size; return union ? intersection / union : 0 }
function isMissing(value: unknown): boolean { return value === null || value === undefined || value === '' }
function round(value: number): number { return Math.round(value * 100) / 100 }
function stringList(value: unknown, name: string, max: number): string[] { if (value === undefined) return []; if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== 'string' || !item.trim() || item.length > 200)) throw new Error(`${name} must contain at most ${max} field names.`); return [...new Set(value.map((item) => String(item).trim()))] }
function number(value: unknown, fallback: number, min: number, max: number, name: string): number { const result = value ?? fallback; if (typeof result !== 'number' || !Number.isFinite(result) || result < min || result > max) throw new Error(`${name} must be from ${min} to ${max}.`); return result }
function integer(value: unknown, fallback: number, min: number, max: number, name: string): number { const result = number(value, fallback, min, max, name); if (!Number.isInteger(result)) throw new Error(`${name} must be an integer.`); return result }
function boolean(value: unknown, fallback: boolean, name: string): boolean { const result = value ?? fallback; if (typeof result !== 'boolean') throw new Error(`${name} must be a boolean.`); return result }
