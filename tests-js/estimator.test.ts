import test from 'node:test'
import assert from 'node:assert/strict'
import * as utils from '../jssrc/utils'
import * as addonConfig from '../jssrc/utils/addonConfig'
import { Estimator } from '../jssrc/estimator'
import { InstLogType } from '../jssrc/reviewLogger/types'

// estimator.update()/undo() call debugLog(), which reads addon config via a
// JSONP request against the real Anki-injected ADDON_UUID global - not
// available under plain Node. Stub it out the same way we stub the clock.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(addonConfig as any).getAddonConfig = async () => false

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

function newEstimator (reviewTimeCutoff: number) {
  return new Estimator({ reviewTimeCutoff, emaWindowSamples: testWindow, rates: { weightedTime: 0, weightedCount: 0 } })
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

  for (let i = 0; i < testWindow * 2; i++) feed(estimator, clock, 10, 'good')
  const after = estimator.getRate()
  assert.ok(Math.abs(after - before) / before < 0.1, `rate ${after} did not recover close to ${before}`)
})

test('lrn-only remaining reviews produce a non-zero ETA', () => {
  const estimator = new Estimator({ reviewTimeCutoff: 1e9, emaWindowSamples: testWindow, rates: { weightedTime: 10, weightedCount: 1 } })
  const eta = estimator.getRemainingTime({ nu: 0, lrn: 5, rev: 0 })
  assert.notEqual(eta, 0)
  assert.equal(eta, 50)
})

test('getRemainingTime divides total remaining by the single blended rate', () => {
  const estimator = new Estimator({ reviewTimeCutoff: 1e9, emaWindowSamples: testWindow, rates: { weightedTime: 20, weightedCount: 4 } })
  const eta = estimator.getRemainingTime({ nu: 3, lrn: 2, rev: 5 })
  assert.equal(eta, 50)
})

test('undo() is the exact inverse of update() for the single rate', () => {
  const clock = fakeClock(0)
  const estimator = new Estimator({ reviewTimeCutoff: 1e9, emaWindowSamples: testWindow, rates: { weightedTime: 5, weightedCount: 0.5 } })
  const before = { ...estimator.rates }

  feed(estimator, clock, 8, 'new')
  assert.notEqual(estimator.rates.weightedTime, before.weightedTime)

  estimator.undo()
  assert.ok(Math.abs(estimator.rates.weightedTime - before.weightedTime) < 1e-9)
  assert.ok(Math.abs(estimator.rates.weightedCount - before.weightedCount) < 1e-9)
})

test('resetRates() zeroes the rate accumulator', () => {
  const estimator = new Estimator({ reviewTimeCutoff: 1e9, emaWindowSamples: testWindow, rates: { weightedTime: 42, weightedCount: 7 } })
  estimator.resetRates()
  assert.equal(estimator.rates.weightedTime, 0)
  assert.equal(estimator.rates.weightedCount, 0)
})
