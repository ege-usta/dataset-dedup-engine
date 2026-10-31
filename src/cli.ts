import { readFile, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { analyzeDataset, validateOptions } from './core'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    key: { type: 'string', multiple: true },
    ignore: { type: 'string', multiple: true },
    threshold: { type: 'string' },
    out: { type: 'string' },
  },
})

const file = positionals[0]
if (!file) {
  console.error('Usage: npm run clean -- <records.json> [--key url] [--ignore scrapedAt] [--threshold 0.9] [--out cleaned.json]')
  process.exit(1)
}

const rows: unknown = JSON.parse(await readFile(file, 'utf8'))
if (!Array.isArray(rows)) throw new Error('Input file must contain a JSON array.')
const result = analyzeDataset(rows, validateOptions({
  keyFields: values.key,
  ignoreFields: values.ignore,
  fuzzyThreshold: values.threshold === undefined ? undefined : Number(values.threshold),
}))

if (values.out) await writeFile(values.out, JSON.stringify(result.cleaned, null, 2))
console.log(JSON.stringify(result.summary, null, 2))
