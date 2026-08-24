/**
 * Port of ExponentialSmoother.py
 */

import ankiPersistentStorage from './utils/ankiPersistentStorage'
import { pakob64Deflate, pakob64Inflate } from './utils/pakob64'
import { now, RemainingCardCounts } from './utils'
import { InstLogType } from './reviewLogger/types'
import { getAddonConfig } from './utils/addonConfig'
import { getCurrentDeckName, getDeckRates, RateState } from './utils/deckRate'
import { isAnkiDroid } from './utils/apiAnkiDroid'
import { debugLog } from './utils/debugLog'

// Short-window EMA: N=7 samples of memory, decay = (N-1)/(N+1).
const historyDecay = 6 / 8
const minimumRate = 1e-6

export interface LogEntry {
  epoch: number;
  dt: number;
  logType: InstLogType;
  reviewHash: number | null; // May be null to save spaces on ankidroid
}

const ESTIMATOR_SCHEMA_VERSION = 5

// How many of the most recent log entries keep their reviewHash on
// serialization. Only mobileReviewLogger ever reads a persisted reviewHash
// back (its edit/undo checks look at the newest 1-2 entries; 10 gives
// headroom for a run of several undos in one poll) - desktopReviewLogger
// dedupes via its own seq counter instead, so on desktop there's no reason
// to pay to persist a reviewHash (high-entropy CRC32, doesn't compress) for
// any entry at all.
const persistedReviewHashTailLength = isAnkiDroid() ? 10 : 0

const logTypeCodes: InstLogType[] = ['new', 'good', 'again', 'rev-good', 'rev-again', 'unknown']

// epoch and reviewHash are dropped from the serialized form (epoch is
// reconstructed by accumulating dt from startTime; reviewHash is only kept
// for the newest `persistedReviewHashTailLength` entries) to keep a long
// session's payload small - see the module comment on why this data lives in
// a size-limited cookie on AnkiDroid.
function serializeLogs (logs: LogEntry[]): unknown[] {
  const s: unknown[] = [logs.length]
  for (const log of logs) {
    s.push(log.dt, logTypeCodes.indexOf(log.logType))
  }
  const tailStart = Math.max(0, logs.length - persistedReviewHashTailLength)
  s.push(logs.length - tailStart)
  for (let i = tailStart; i < logs.length; i++) {
    s.push(logs[i].reviewHash)
  }
  return s
}

function deserializeLogs (s: unknown[], cursor: number, startTime: number): { logs: LogEntry[]; cursor: number } {
  const count = s[cursor++] as number
  const logs: LogEntry[] = []
  let epoch = startTime
  for (let i = 0; i < count; i++) {
    const dt = s[cursor++] as number
    const logType = logTypeCodes[s[cursor++] as number]
    epoch += dt
    // Patched in below for the persisted tail; older entries never have
    // their reviewHash read.
    logs.push({ epoch, dt, logType, reviewHash: null })
  }

  const tailCount = s[cursor++] as number
  const tailStart = logs.length - tailCount
  for (let i = tailStart; i < logs.length; i++) {
    logs[i].reviewHash = s[cursor++] as number
  }

  return { logs, cursor }
}

// Persistence
export const kRtEstimatorSchema = '__rt__estimator__schema__'

// Implementation

interface EstimatorInitializer {
  reviewTimeCutoff: number;
  rates: RateState;
}

function emptyRateState (): RateState {
  return { weightedTime: 0, weightedCount: 0 }
}

export class Estimator {
  logs: LogEntry[] = []
  // A pure exponential smoother's raw accumulator (decayed weighted
  // seconds / decayed weighted count), blended across every answered card
  // regardless of new/lrn/rev or which sitting it happened in. This is the
  // same object the persisted per-deck rate is loaded into and saved from
  // (see updater.ts) - there's no separate "seed" concept blended in
  // through a second, differently-tuned smoother; continuing to decay this
  // state across a sitting boundary *is* how the rate persists.
  rates: RateState

  private startTime = now()
  private reviewTimeCutoff: number
  // eslint-disable-next-line no-use-before-define
  private static cache: Estimator | null = null

  constructor (args: EstimatorInitializer) {
    this.reviewTimeCutoff = args.reviewTimeCutoff
    this.rates = args.rates
  }

  get elapsedTime () {
    return now() - this.startTime
  }

  /** Epoch of the most recent review, or the sitting's start if none yet. */
  get lastActivityEpoch () {
    return this.logs.length ? this.logs[this.logs.length - 1].epoch : this.startTime
  }

  reset () {
    this.logs = []
    this.startTime = now()
    // this.rates is deliberately left untouched - it's the deck's long-run
    // learned pace, not sitting-scoped state.
  }

  /** Folds one sample into the blended running pace. */
  private applyRateSample (dt: number) {
    const state = this.rates
    const withinCutoff = dt <= this.reviewTimeCutoff
    const cappedDt = withinCutoff ? dt : this.reviewTimeCutoff
    const oldWeightedTime = state.weightedTime
    const oldWeightedCount = state.weightedCount
    state.weightedTime = state.weightedTime * historyDecay + cappedDt
    state.weightedCount = state.weightedCount * historyDecay + (withinCutoff ? 1 : 0)
    debugLog(`[applyRateSample] dt ${dt}, weightedTime ${oldWeightedTime} -> ${state.weightedTime}, weightedCount ${oldWeightedCount} -> ${state.weightedCount}`)
  }

  /** Exact inverse of applyRateSample, for undo. */
  private reverseRateSample (dt: number) {
    const state = this.rates
    const withinCutoff = dt <= this.reviewTimeCutoff
    const cappedDt = withinCutoff ? dt : this.reviewTimeCutoff
    state.weightedTime = (state.weightedTime - cappedDt) / historyDecay
    state.weightedCount = (state.weightedCount - (withinCutoff ? 1 : 0)) / historyDecay
  }

  update (reviewHash: number, logType: InstLogType) {
    const logLength = this.logs.length
    const epoch = now()
    const dt =
      logLength
        ? epoch - this.logs[this.logs.length - 1].epoch
        : epoch - this.startTime

    this.applyRateSample(dt)

    this.logs.push({ reviewHash, epoch, dt, logType })
  }

  undo () {
    const removed = this.logs.pop()
    if (!removed) return

    this.reverseRateSample(removed.dt)
  }

  /** Cards/sec pace, blended across every answered card. */
  getRate () {
    const { weightedTime, weightedCount } = this.rates
    // No persisted history and no real data yet - nothing to compute from.
    if (weightedTime <= 0) return minimumRate
    if (weightedTime < 1) return 1
    return Math.max(weightedCount / weightedTime, minimumRate)
  }

  /** Total remaining count (new + lrn + rev), divided by the blended pace. */
  getRemainingTime (remainingReviews: RemainingCardCounts) {
    return (
      (remainingReviews.nu + remainingReviews.lrn + remainingReviews.rev) / this.getRate()
    )
  }

  save () {
    // serialize
    const s: unknown[] = [ESTIMATOR_SCHEMA_VERSION, this.startTime]
    s.push(...serializeLogs(this.logs))

    const storage = (isAnkiDroid()) ? localStorage : ankiPersistentStorage
    storage.setItem(
      kRtEstimatorSchema,
      pakob64Deflate(JSON.stringify(s, function (_key, val) {
        return val.toFixed ? Number(val.toFixed(1)) : val
      }))
    )
  }

  static async instance (): Promise<Estimator> {
    if (Estimator.cache) return Estimator.cache

    const storage = (isAnkiDroid()) ? localStorage : ankiPersistentStorage
    const content = await storage.getItem(kRtEstimatorSchema)
    const reviewTimeCutoff = (await getAddonConfig('reviewTimeCutoff')) as number

    const deckName = await getCurrentDeckName()
    const persistedRates = deckName ? await getDeckRates(deckName) : null
    const rates: RateState = persistedRates?.rate ?? emptyRateState()

    if (!content) Estimator.cache = new Estimator({ reviewTimeCutoff, rates })
    else {
      try {
        const s = JSON.parse(pakob64Inflate(content))
        let cursor = 0
        if (s[cursor++] !== ESTIMATOR_SCHEMA_VERSION) {
          throw new Error('Old schema')
        }
        const obj = new Estimator({ reviewTimeCutoff, rates })
        obj.startTime = s[cursor++]
        const deserialized = deserializeLogs(s, cursor, obj.startTime)
        obj.logs = deserialized.logs
        cursor = deserialized.cursor
        if (cursor !== s.length) {
          throw new Error('Length mismatch - RTT')
        }

        // re-update elapsed time
        Estimator.cache = obj
      } catch {
        Estimator.cache = new Estimator({ reviewTimeCutoff, rates })
      }
    }
    return Estimator.cache
  }
}
