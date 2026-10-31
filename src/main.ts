import { Actor, log } from 'apify'
import { analyzeDataset, validateOptions } from './core'

interface Input { records?: unknown[]; datasetId?: string; maxRows?: number; outputMode?: 'cleaned_and_issues' | 'cleaned_only' | 'summary_only'; keyFields?: string[]; ignoreFields?: string[]; fuzzyThreshold?: number; normalizeCase?: boolean; trimWhitespace?: boolean; normalizeUrls?: boolean; removeEmptyStrings?: boolean; validateEmailFormat?: boolean; maxComparisons?: number }

await Actor.init()
  const input = (await Actor.getInput<Input>()) ?? {}
  const manager = Actor.getChargingManager()
  const pricing = manager.getPricingInfo()
  if (pricing.isPayPerEvent && !('record-processed' in pricing.perEventPrices)) throw new Error('Missing record-processed pricing event.')
  if (pricing.isPayPerEvent && 'apify-default-dataset-item' in pricing.perEventPrices) throw new Error('Remove the automatic dataset-item event before using input-row billing to prevent duplicate charges.')
  const free = ['false', '0'].includes(String(Actor.getEnv().userIsPaying).toLowerCase())
  const remaining = pricing.isPayPerEvent ? manager.calculateMaxEventChargeCountWithinLimit('record-processed') : Infinity
  const maxRows = Math.min(integer(input.maxRows, 5000, 1, 20000, 'maxRows'), free ? 100 : Infinity, remaining)
  if (maxRows < 1) await Actor.exit({ statusMessage: 'Run budget does not cover another input row.' })
  if (free) log.info('Free-plan sample: up to 100 input rows per run. An Apify paid plan enables larger batches.')
  const outputMode = input.outputMode ?? 'cleaned_and_issues'
  if (!['cleaned_and_issues', 'cleaned_only', 'summary_only'].includes(outputMode)) throw new Error('outputMode is invalid.')
  const rows = await loadRows(input, maxRows)
  if (!rows.length) throw new Error('The input dataset is empty.')
  const result = analyzeDataset(rows, validateOptions(input))
  if (outputMode !== 'summary_only') {
    for (const [cleanIndex, record] of result.cleaned.entries()) await Actor.pushData({ rowType: 'cleaned', cleanIndex, ...record })
    if (outputMode === 'cleaned_and_issues') {
      for (const duplicate of result.duplicateRows) await Actor.pushData(duplicate)
      for (const rejected of result.rejected) await Actor.pushData(rejected)
    }
  }
  await Actor.pushData(result.summary)
  const receipt = await Actor.charge({ eventName: 'record-processed', count: rows.length })
  if (pricing.isPayPerEvent && receipt.chargedCount !== rows.length) throw new Error('Incomplete record billing receipt.')
  log.info(`${rows.length} rows analyzed; ${result.cleaned.length} clean rows; ${result.duplicateRows.length} duplicates.`)
await Actor.exit()

async function loadRows(input: Input, limit: number): Promise<unknown[]> {
  if (input.records !== undefined) {
    if (!Array.isArray(input.records)) throw new Error('records must be an array.')
    return input.records.slice(0, limit)
  }
  if (input.datasetId !== undefined) {
    if (typeof input.datasetId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.datasetId)) throw new Error('datasetId has an invalid format.')
    return (await (await Actor.openDataset(input.datasetId)).getData({ limit })).items
  }
  throw new Error('Provide records or datasetId.')
}
function integer(value: unknown, fallback: number, min: number, max: number, name: string): number { const number = value ?? fallback; if (typeof number !== 'number' || !Number.isInteger(number) || number < min || number > max) throw new Error(`${name} must be an integer from ${min} to ${max}.`); return number }
