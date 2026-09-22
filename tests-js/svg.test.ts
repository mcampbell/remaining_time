import test from 'node:test'
import assert from 'node:assert/strict'
import { getSVG } from '../jssrc/barRender/svg'
import { Estimator, LogEntry } from '../jssrc/estimator'

// getSVG only reads elapsedTime, logs, and getRemainingTime() off the
// estimator it's given, so a duck-typed stub avoids Estimator's private
// startTime/now() plumbing.
function fakeEstimator (logs: Array<Pick<LogEntry, 'dt' | 'logType'>>, elapsedTime: number, remainingTime: number) {
  return {
    elapsedTime,
    logs: logs.map(l => ({ ...l, epoch: 0, reviewHash: null, wasSeed: false })),
    getRemainingTime: () => remainingTime
  } as unknown as Estimator
}

function totalPaintedWidth (svgHtml: string): number {
  const widths = [...svgHtml.matchAll(/rt-log-segment rt-log-[\w-]+" d="M[\d.]+ 0 h([\d.]+)/g)]
    .map(m => Number(m[1]))
  return widths.reduce((a, b) => a + b, 0)
}

test('a long idle gap (X segment) does not shrink total painted width below progress', () => {
  const logs: Array<Pick<LogEntry, 'dt' | 'logType'>> = [
    { dt: 5000, logType: 'good' }, // idle gap, clamped to 1800s for display
    { dt: 10, logType: 'good' },
    { dt: 10, logType: 'good' }
  ]
  const elapsedTime = 5020
  const remainingTime = 100
  const estimator = fakeEstimator(logs, elapsedTime, remainingTime)
  const progress = elapsedTime / (elapsedTime + remainingTime)

  const svgHtml = getSVG(estimator, { nu: 0, lrn: 0, rev: 0 }, { fixedWidth: false })
  const totalWidth = totalPaintedWidth(svgHtml)

  assert.ok(Math.abs(totalWidth - progress) < 1e-9, `expected total width ~${progress}, got ${totalWidth}`)
})
