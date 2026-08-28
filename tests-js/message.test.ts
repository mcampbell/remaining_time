import test from 'node:test'
import assert from 'node:assert/strict'
import * as addonConfig from '../jssrc/utils/addonConfig'
import { Estimator } from '../jssrc/estimator'
import { getMessage } from '../jssrc/barRender/message'

// Same seam as estimator.test.ts: getMessage() reads messageFormat via the
// no-arg getAddonConfig() call, which does a real JSONP request against
// ADDON_UUID under real Anki - not available under plain Node.
function stubMessageFormat (messageFormat: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (addonConfig as any).getAddonConfig = async () => ({ messageFormat })
}

const testWindow = 7

function estimatorWithRate (emaSeconds: number) {
  return new Estimator({ reviewTimeCutoff: 1e9, emaWindowSamples: testWindow, sharedETACalc: false, rates: { emaSeconds } })
}

test('%(timePerCard) substitutes to t2s(1/getRate())', async () => {
  stubMessageFormat('%(timePerCard)')
  const estimator = estimatorWithRate(5) // emaSeconds = 5 -> 1/getRate() = 5s
  const message = await getMessage(estimator, { nu: 0, lrn: 0, rev: 0 })
  assert.equal(message, '5s')
})

test('%(timePerCard) coexists with other variables in the same template', async () => {
  stubMessageFormat('Pace: %(timePerCard)/card, CPM %(CPM)')
  const estimator = estimatorWithRate(10) // emaSeconds = 10 -> 1/getRate() = 10s
  const message = await getMessage(estimator, { nu: 0, lrn: 0, rev: 0 })
  assert.equal(message, 'Pace: 10s/card, CPM 0.00') // no logs recorded -> CPM is 0
})
