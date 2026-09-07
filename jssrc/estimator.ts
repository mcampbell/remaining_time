/**
 * Port of ExponentialSmoother.py
 */

import ankiPersistentStorage from './utils/ankiPersistentStorage'
import { pakob64Deflate, pakob64Inflate } from './utils/pakob64'
import { now, RemainingCardCounts } from './utils'
import { InstLogType } from './reviewLogger/types'
import { getAddonConfig } from './utils/addonConfig'
import { RateState } from './utils/deckRate'
import { isAnkiDroid } from './utils/apiAnkiDroid'
import { debugLog } from './utils/debugLog'

const minimumRate = 1e-6

export interface LogEntry {
  epoch: number;
  dt: number;
  logType: InstLogType;
  reviewHash: number | null; // May be null to save spaces on ankidroid
  // Whether this entry was the one that seeded rates.emaSeconds (i.e.
  // rates.emaSeconds was null immediately before it). Not persisted - a
  // deserialized entry always reports false, since by the time logs are
  // reloaded the associated rate (persisted separately, deck-scoped) has
  // already been seeded in a prior sitting in every realistic case. Undoing
  // a deserialized entry that happens to be the true all-time first sample
  // is the one edge case this gets wrong (reverseRateSample will blend-invert
  // instead of resetting to null) - deliberately accepted, since undoing a
  // review from a previous Anki session is already an edge case.
  wasSeed: boolean;
}

const ESTIMATOR_SCHEMA_VERSION = 6

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
    // their reviewHash read. wasSeed is never persisted - see LogEntry.
    logs.push({ epoch, dt, logType, reviewHash: null, wasSeed: false })
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
  emaWindowSamples: number;
  rates: RateState;
}

export function emptyRateState (): RateState {
  return { emaSeconds: null }
}

export class Estimator {
  logs: LogEntry[] = []
  // A standard single-value EMA of seconds-per-card, blended across every
  // answered card regardless of new/lrn/rev, and shared across every deck
  // touched in the sitting (immune to per-card deck-switching, e.g.
  // reviewing a large parent deck spanning many subdecks) - persisted
  // alongside logs/startTime, not scoped to any one deck.
  rates: RateState

  private startTime = now()
  private reviewTimeCutoff: number
  // Standard EMA step size: alpha = 2/(N+1) for an N-sample window. Every
  // sample after the seed moves emaSeconds by exactly this fraction toward
  // the new value, regardless of how many samples came before - unlike a
  // ratio-of-two-decayed-accumulators design, there's no warm-up period
  // where an early sample carries more than its steady-state weight.
  private historyAlpha: number
  // eslint-disable-next-line no-use-before-define
  private static cache: Estimator | null = null

  constructor (args: EstimatorInitializer) {
    this.reviewTimeCutoff = args.reviewTimeCutoff
    this.historyAlpha = 2 / (args.emaWindowSamples + 1)
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
    // this.rates is deliberately left untouched - it's long-run learned
    // pace for the whole sitting, not scoped to the log being cleared here.
  }

  // Aggressive counterpart to reset(), used only by the manual reset button:
  // unlike reset(), this discards the deck's long-run learned pace too,
  // since that's what a user explicitly asking for "a fresh value" wants.
  resetRates () {
    this.rates = emptyRateState()
  }

  /**
   * Folds one sample into the blended running pace. dt is the raw elapsed
   * time between this card and the previous one - nothing else is folded
   * in. Clamped to reviewTimeCutoff (a real gap longer than that is
   * scheduler/AFK wait time, not review pace). Returns whether this sample
   * seeded emaSeconds (it was null beforehand), so update() can record that
   * on the log entry for undo to invert correctly.
   */
  private applyRateSample (dt: number): boolean {
    const state = this.rates
    const cappedDt = Math.min(dt, this.reviewTimeCutoff)
    const wasSeed = state.emaSeconds === null
    const oldEmaSeconds = state.emaSeconds
    state.emaSeconds = wasSeed
      ? cappedDt
      : this.historyAlpha * cappedDt + (1 - this.historyAlpha) * (state.emaSeconds as number)
    debugLog(`[applyRateSample] dt ${dt}, emaSeconds ${oldEmaSeconds} -> ${state.emaSeconds}`)
    return wasSeed
  }

  /** Exact inverse of applyRateSample, for undo. */
  private reverseRateSample (dt: number, wasSeed: boolean) {
    const state = this.rates
    if (wasSeed) {
      state.emaSeconds = null
      return
    }
    const cappedDt = Math.min(dt, this.reviewTimeCutoff)
    state.emaSeconds = ((state.emaSeconds as number) - this.historyAlpha * cappedDt) / (1 - this.historyAlpha)
  }

  update (reviewHash: number, logType: InstLogType) {
    const logLength = this.logs.length
    const epoch = now()
    const dt =
      logLength
        ? epoch - this.logs[this.logs.length - 1].epoch
        : epoch - this.startTime

    const wasSeed = this.applyRateSample(dt)

    this.logs.push({ reviewHash, epoch, dt, logType, wasSeed })
  }

  undo () {
    const removed = this.logs.pop()
    if (!removed) return

    this.reverseRateSample(removed.dt, removed.wasSeed)
  }

  /** Cards/sec pace, blended across every answered card. */
  getRate () {
    const { emaSeconds } = this.rates
    // No persisted history and no real data yet - nothing to compute from.
    if (emaSeconds === null) return minimumRate
    // Guard against an absurd rate if a sample's dt was near-zero.
    return 1 / Math.max(emaSeconds, 1)
  }

  /** Total remaining count (new + lrn + rev), divided by the blended pace. */
  getRemainingTime (remainingReviews: RemainingCardCounts) {
    return (
      (remainingReviews.nu + remainingReviews.lrn + remainingReviews.rev) / this.getRate()
    )
  }

  async save () {
    // serialize. rates.emaSeconds is the sitting's single shared rate.
    const s: unknown[] = [ESTIMATOR_SCHEMA_VERSION, this.rates.emaSeconds, this.startTime]
    s.push(...serializeLogs(this.logs))

    const storage = (isAnkiDroid()) ? localStorage : ankiPersistentStorage
    await storage.setItem(
      kRtEstimatorSchema,
      pakob64Deflate(JSON.stringify(s, function (_key, val) {
        return typeof val === 'number' ? Number(val.toFixed(1)) : val
      }))
    )
  }

  static async instance (): Promise<Estimator> {
    if (Estimator.cache) return Estimator.cache

    const storage = (isAnkiDroid()) ? localStorage : ankiPersistentStorage
    const content = await storage.getItem(kRtEstimatorSchema)
    const reviewTimeCutoff = (await getAddonConfig('reviewTimeCutoff')) as number
    const emaWindowSamples = (await getAddonConfig('emaWindowSamples')) as number

    if (!content) Estimator.cache = new Estimator({ reviewTimeCutoff, emaWindowSamples, rates: emptyRateState() })
    else {
      try {
        const s = JSON.parse(pakob64Inflate(content))
        let cursor = 0
        if (s[cursor++] !== ESTIMATOR_SCHEMA_VERSION) {
          throw new Error('Old schema')
        }
        const sittingEmaSeconds = s[cursor++] as number | null
        const rates: RateState = { emaSeconds: sittingEmaSeconds }
        const obj = new Estimator({ reviewTimeCutoff, emaWindowSamples, rates })
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
        Estimator.cache = new Estimator({ reviewTimeCutoff, emaWindowSamples, rates: emptyRateState() })
      }
    }
    return Estimator.cache
  }
}
