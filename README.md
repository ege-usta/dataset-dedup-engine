# Dataset Dedup Engine

[![CI](https://github.com/ege-usta/dataset-dedup-engine/actions/workflows/ci.yml/badge.svg)](https://github.com/ege-usta/dataset-dedup-engine/actions/workflows/ci.yml)

Cleans scraped JSON records before they go into a spreadsheet, CRM or database. It removes exact and near-duplicate rows, normalizes text and URLs, and reports how healthy the dataset is. No AI model, no external API: the same input always gives the same output.

I built it to clean the output of my own web scrapers. It also runs as a paid tool on the Apify Store: [Dataset Cleaner & Deduplicator](https://apify.com/egeusta/dataset-quality-deduplication-engine).

## What it checks

| Check | How |
|---|---|
| Exact duplicates | Records are normalized, then compared on the key fields you choose |
| Near duplicates | Jaccard similarity over value tokens, inside small buckets with a hard comparison limit so large files stay fast |
| URL noise | Lowercases the host, drops `utm_*`, `gclid`, `fbclid`, fragments and trailing slashes |
| Missing values | Counts `null` and empty strings per field |
| Type drift | Flags fields that mix types, e.g. `price` as both number and string |
| Email format | Syntax check only; it never contacts mail servers |

Each run returns the cleaned rows, the removed duplicates (with which row they duplicate), rejected non-object rows, and a summary with a 0–100 quality score.

## Run it locally

```bash
npm ci
npm run clean -- examples/products.json --ignore scrapedAt --out cleaned.json
```

On the sample file this removes the tracking-parameter duplicate, rejects the malformed row and flags `price` for mixing numbers and strings:

```json
{
  "originalRowCount": 5,
  "cleanedRowCount": 3,
  "exactDuplicates": 1,
  "malformedRecords": 1,
  "qualityScore": 84,
  "inconsistentFields": [{ "field": "price", "observedTypes": { "number": 2, "string": 1, "null": 1 } }]
}
```

Options: `--key <field>` (repeatable) picks the fields that define a duplicate, `--ignore <field>` leaves volatile columns such as timestamps out, `--threshold 0.7–1` sets near-duplicate sensitivity (1 turns fuzzy matching off).

## Quality score

Starts at 100 and subtracts weighted penalties for duplicates (35), malformed rows (20), missing values (30), invalid emails (10) and up to 15 for type-inconsistent fields. It measures dataset health, not whether values are true.

## Project layout

```
src/core.ts      pure analysis logic (no I/O)
src/cli.ts       local command-line entry point
src/main.ts      Apify Actor entry point (input, billing, dataset output)
test/            node:test unit tests
.actor/          Apify input/output schemas
```

## Tests

```bash
npm run typecheck && npm test
```

Writing the edge-case tests caught a real bug: field names were counted as tokens in the similarity check, so `{ "id": "a" }` and `{ "id": "b" }` were reported as near duplicates. Fuzzy matching now uses values only.

## Limitations

Near-duplicate matching works on word tokens, so very short values (one character) are only matched exactly. Nested objects are kept and compared, but the quality metrics look at top-level fields.

## License

MIT
