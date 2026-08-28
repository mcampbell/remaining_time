import { callPyFunc } from './pyfunc'
import ankiPersistentStorage from './ankiPersistentStorage'
import { isAnkiDroid, getAnkiDroidApi } from './apiAnkiDroid'

// A standard single-value EMA of seconds-per-card: emaSeconds = alpha*dt +
// (1-alpha)*emaSeconds. null means no sample has ever been folded in yet
// (nothing to seed from) - the first real sample sets emaSeconds directly
// rather than blending against a fake zero/undefined baseline, so a fresh
// deck's very first card doesn't bias every estimate after it.
export interface RateState {
  emaSeconds: number | null;
}

export interface DeckRates {
  rate?: RateState;
}

export async function getCurrentDeckName (): Promise<string | null> {
  if (isAnkiDroid()) {
    // AnkiDroid's js-api.js has a bug: handleRequest special-cases any
    // endpoint whose name contains "deckName" (or "nextTime") to return the
    // raw, un-JSON.parse()'d fetch response text instead of a parsed
    // {success, value} object, unlike every other AnkiDroidJS method. Handle
    // both shapes defensively rather than assuming the declared type holds.
    const raw = await getAnkiDroidApi().ankiGetDeckName() as AnkiDroidApiResult<string> | string
    const result = typeof raw === 'string' ? JSON.parse(raw) as AnkiDroidApiResult<string> : raw
    return result.value
  } else {
    return callPyFunc('getCurrentDeckName')
  }
}

function isRateState (value: unknown): value is RateState {
  return (
    typeof value === 'object' &&
    value !== null &&
    (typeof (value as RateState).emaSeconds === 'number' || (value as RateState).emaSeconds === null)
  )
}

function sanitizeDeckRates (raw: unknown): DeckRates {
  // old schema (storing raw number instead of object) -> ignore
  if (typeof raw !== 'object' || raw === null) return {}

  const { rate } = raw as DeckRates
  // old per-category schema (`{new, rev}`) or old two-accumulator schema
  // (`{weightedTime, weightedCount}`) -> treat as no persisted rate, same
  // defensive spirit as the raw-number case above.
  return { rate: isRateState(rate) ? rate : undefined }
}

export async function getDeckRates (deckName: string): Promise<DeckRates | null> {
  const store = await getDeckRateStore()
  return store[deckName] ? sanitizeDeckRates(store[deckName]) : null
}

export async function saveDeckRates (deckName: string, rates: DeckRates): Promise<void> {
  const store = await getDeckRateStore()
  store[deckName] = { ...sanitizeDeckRates(store[deckName]), ...rates }
  await setDeckRateStore(store)
}

export const kDeckRates = '__rt__deckrates__'

async function getDeckRateStore (): Promise<Record<string, DeckRates>> {
  const s = await ankiPersistentStorage.getItem(kDeckRates)
  return s ? JSON.parse(s) : {}
}

async function setDeckRateStore (rates: Record<string, DeckRates>): Promise<void> {
  await ankiPersistentStorage.setItem(kDeckRates, JSON.stringify(rates))
}
