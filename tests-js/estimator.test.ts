import test from 'node:test'
import assert from 'node:assert/strict'
import * as utils from '../jssrc/utils'
import * as addonConfig from '../jssrc/utils/addonConfig'
import ankiPersistentStorage from '../jssrc/utils/ankiPersistentStorage'
import { pakob64Inflate } from '../jssrc/utils/pakob64'
import { Estimator } from '../jssrc/estimator'
import { InstLogType } from '../jssrc/reviewLogger/types'

// estimator.update()/undo() call debugLog(), which reads addon config via a
// JSONP request against the real Anki-injected ADDON_UUID global - not
// available under plain Node. Stub it out the same way we stub the clock.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(addonConfig as any).getAddonConfig = async () => false

// estimator.save() routes through ankiPersistentStorage.setItem, which under
// plain Node (not AnkiDroid) calls callPyFunc -> the real Anki `pycmd`
// bridge, not available here. Stub it to capture the serialized payload
// instead.
let lastSavedPayload: string | null = null
ankiPersistentStorage.setItem = async (_key: string, data: string) => { lastSavedPayload = data }

// Seam: estimator.ts calls utils.now() by property lookup on every
// invocation (never destructures it at import time), so monkeypatching the
// exported function here lets us drive a fully deterministic fake clock
// without touching estimator.ts itself.
function fakeClock (startEpoch: number) {
  let t = startEpoch
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(utils as any).now = () => t
  return { advance: (dt: number) => { t += dt } }
}

const testWindow = 7
const testAlpha = 2 / (testWindow + 1) // 0.25

function newEstimator (reviewTimeCutoff: number) {
  return new Estimator({ reviewTimeCutoff, emaWindowSamples: testWindow, rates: { emaSeconds: null } })
}

function feed (estimator: Estimator, clock: { advance: (dt: number) => void }, dt: number, logType: InstLogType) {
  clock.advance(dt)
  estimator.update(1, logType)
}

test('blended average converges toward true mean dt across mixed log types', () => {
  const clock = fakeClock(0)
  const estimator = newEstimator(1e9)
  const types: InstLogType[] = ['new', 'good', 'again', 'rev-good', 'rev-again']
  for (let i = 0; i < 30; i++) {
    feed(estimator, clock, 10, types[i % types.length])
  }
  assert.ok(Math.abs(estimator.getRate() - 0.1) < 1e-6, `rate ${estimator.getRate()} not close to 0.1`)
})

test('short-window rate recovers close to pre-outlier rate within ~N samples', () => {
  const clock = fakeClock(0)
  const cutoff = 60
  const estimator = newEstimator(cutoff)
  for (let i = 0; i < 20; i++) feed(estimator, clock, 10, 'good')
  const before = estimator.getRate()
  assert.ok(Math.abs(before - 0.1) < 1e-6)

  feed(estimator, clock, 1000, 'good') // outlier, capped by reviewTimeCutoff
  assert.ok(Math.abs(estimator.getRate() - before) > 0.01, 'outlier should visibly perturb rate')
  const afterOutlierEma = estimator.rates.emaSeconds as number
  assert.ok(Math.abs(afterOutlierEma - 22.5) < 1e-9)

  const recoverySamples = testWindow * 2
  for (let i = 0; i < recoverySamples; i++) feed(estimator, clock, 10, 'good')

  // Each ordinary post-outlier sample moves emaSeconds by exactly alpha
  // toward 10, so after k samples emaSeconds = 10 + (afterOutlierEma-10)*(1-alpha)^k.
  const expectedEma = 10 + (afterOutlierEma - 10) * Math.pow(1 - testAlpha, recoverySamples)
  assert.ok(
    Math.abs((estimator.rates.emaSeconds as number) - expectedEma) < 1e-9,
    `emaSeconds ${estimator.rates.emaSeconds} !== ${expectedEma}`
  )
  const expectedRate = 1 / Math.max(expectedEma, 1)
  assert.ok(Math.abs(estimator.getRate() - expectedRate) < 1e-9)
})

test('a capped outlier sample blends in exactly alpha*cutoff + (1-alpha)*previous', () => {
  // Regression guard for the old two-accumulator design, where a capped dt
  // added weighted time but (via a separate bug) sometimes failed to add a
  // matching weighted count. That whole bug class is structurally impossible
  // now - there's no separate count - but the capped value must still land
  // exactly on the standard EMA blend, not something ad hoc.
  const clock = fakeClock(0)
  const cutoff = 60
  const estimator = new Estimator({ reviewTimeCutoff: cutoff, emaWindowSamples: testWindow, rates: { emaSeconds: 100 } })

  feed(estimator, clock, 1000, 'good') // dt >> cutoff, so cappedDt = 60

  const expectedEma = testAlpha * 60 + (1 - testAlpha) * 100 // 90
  assert.ok(Math.abs((estimator.rates.emaSeconds as number) - expectedEma) < 1e-9)
  assert.ok(Math.abs(estimator.getRate() - 1 / Math.max(expectedEma, 1)) < 1e-9)
})

test('newest sample has a constant alpha weight regardless of prior sample count', () => {
  // The bug this whole redesign fixes: under the old ratio-of-two-decayed-
  // accumulators design, a newest sample's effective weight in the average
  // started at 100% and only slowly decayed toward its steady-state share
  // over ~N samples, no matter how large N was. A standard single-value EMA
  // has a constant per-step weight of exactly alpha from the very first
  // blended sample onward - prove the step size a single differing sample
  // produces is identical whether it lands on sample #2 or sample #52.
  const seedDt = 10
  const newDt = 50

  const clockShort = fakeClock(0)
  const shortEstimator = newEstimator(1e9)
  feed(shortEstimator, clockShort, seedDt, 'good') // seeds emaSeconds = 10
  const shortBefore = shortEstimator.rates.emaSeconds as number
  feed(shortEstimator, clockShort, newDt, 'good')
  const shortStep = Math.abs((shortEstimator.rates.emaSeconds as number) - shortBefore)

  const clockLong = fakeClock(0)
  const longEstimator = newEstimator(1e9)
  feed(longEstimator, clockLong, seedDt, 'good') // seeds emaSeconds = 10
  for (let i = 0; i < 50; i++) feed(longEstimator, clockLong, seedDt, 'good') // identical-dt "history"
  const longBefore = longEstimator.rates.emaSeconds as number
  feed(longEstimator, clockLong, newDt, 'good')
  const longStep = Math.abs((longEstimator.rates.emaSeconds as number) - longBefore)

  assert.ok(Math.abs(shortBefore - longBefore) < 1e-9, 'both should be at the seeded/converged value of 10 before the perturbation')
  const expectedStep = testAlpha * Math.abs(newDt - shortBefore)
  assert.ok(Math.abs(shortStep - expectedStep) < 1e-9, `shortStep ${shortStep} !== ${expectedStep}`)
  assert.ok(Math.abs(longStep - expectedStep) < 1e-9, `longStep ${longStep} !== ${expectedStep}`)
  assert.equal(shortStep, longStep, 'step size must not depend on how many prior samples exist')
})

test('lrn-only remaining reviews produce a non-zero ETA', () => {
  const estimator = new Estimator({ reviewTimeCutoff: 1e9, emaWindowSamples: testWindow, rates: { emaSeconds: 10 } })
  const eta = estimator.getRemainingTime({ nu: 0, lrn: 5, rev: 0 })
  assert.notEqual(eta, 0)
  assert.equal(eta, 50)
})

test('getRemainingTime divides total remaining by the single blended rate', () => {
  const estimator = new Estimator({ reviewTimeCutoff: 1e9, emaWindowSamples: testWindow, rates: { emaSeconds: 5 } })
  const eta = estimator.getRemainingTime({ nu: 3, lrn: 2, rev: 5 })
  assert.equal(eta, 50)
})

test('undo() is the exact inverse of update() for the single rate', () => {
  const clock = fakeClock(0)
  const estimator = new Estimator({ reviewTimeCutoff: 1e9, emaWindowSamples: testWindow, rates: { emaSeconds: 10 } })
  const before = { ...estimator.rates }

  feed(estimator, clock, 8, 'new')
  assert.notEqual(estimator.rates.emaSeconds, before.emaSeconds)

  estimator.undo()
  assert.ok(Math.abs((estimator.rates.emaSeconds as number) - (before.emaSeconds as number)) < 1e-9)
})

test('undo() of the very first-ever sample resets emaSeconds back to null', () => {
  const clock = fakeClock(0)
  const estimator = newEstimator(1e9)
  assert.equal(estimator.rates.emaSeconds, null)

  feed(estimator, clock, 8, 'new')
  assert.notEqual(estimator.rates.emaSeconds, null)

  estimator.undo()
  assert.equal(estimator.rates.emaSeconds, null)
})

test('resetRates() nulls the rate accumulator', () => {
  const estimator = new Estimator({ reviewTimeCutoff: 1e9, emaWindowSamples: testWindow, rates: { emaSeconds: 42 } })
  estimator.resetRates()
  assert.equal(estimator.rates.emaSeconds, null)
})

test('save() includes rates.emaSeconds in its serialized payload', () => {
  const estimator = new Estimator({ reviewTimeCutoff: 1e9, emaWindowSamples: testWindow, rates: { emaSeconds: 12.3 } })
  lastSavedPayload = null
  estimator.save()
  assert.ok(lastSavedPayload, 'save() should have written a payload')
  const s = JSON.parse(pakob64Inflate(lastSavedPayload as string))
  // Serialized shape: [ESTIMATOR_SCHEMA_VERSION, rates.emaSeconds, startTime, ...logs]
  assert.equal(s[1], 12.3, 'emaSeconds not persisted in slot 1')
})

test('save() serializes a null emaSeconds without throwing (manual reset path)', () => {
  const estimator = new Estimator({ reviewTimeCutoff: 1e9, emaWindowSamples: testWindow, rates: { emaSeconds: 42 } })
  estimator.resetRates()
  lastSavedPayload = null
  assert.doesNotThrow(() => estimator.save())
  assert.ok(lastSavedPayload, 'save() should have written a payload')
  const s = JSON.parse(pakob64Inflate(lastSavedPayload as string))
  assert.equal(s[1], null, 'null emaSeconds should round-trip as null in slot 1')
})
