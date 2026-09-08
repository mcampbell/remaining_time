
import { Estimator } from '../estimator'
import { RemainingCardCounts, t2s } from '../utils'
import { getAddonConfig } from '../utils/addonConfig'

function zf (n: number, cnt: number) {
  const s = n.toString()
  return '0'.repeat(cnt - s.length) + s
}

function HHmmFormat (date: Date) {
  return `${zf(date.getHours(), 2)}:${zf(date.getMinutes(), 2)}`
}

function HHmmFormat12 (date: Date) {
  const amPm = date.getHours() >= 12 ? 'PM' : 'AM'
  return `${zf((date.getHours() - 1) % 12 + 1, 2)}:${zf(date.getMinutes(), 2)} ${amPm}`
}

export async function getMessage (estimator: Estimator, remainingReviews: RemainingCardCounts): Promise<string> {
  const elapsedTime = estimator.elapsedTime
  const remainingTime = estimator.getRemainingTime(remainingReviews)
  const totalTime = elapsedTime + remainingTime
  // The pace actually driving remainingTime/ETA above - the inverse of the
  // same blended EMA rate - unlike CPM, which is an unrelated whole-sitting
  // average.
  const timePerCard = 1 / estimator.getRate()
  // Actual observed pace this sitting - cards answered per minute - rather
  // than any one category's rate.
  const CPM = (elapsedTime > 0 ? (estimator.logs.length / elapsedTime) * 60 : 0).toFixed(2)
  const ETA = new Date()
  ETA.setSeconds(ETA.getSeconds() + remainingTime)
  const ETAString24 = (remainingTime >= 86400) ? '> day' : HHmmFormat(ETA)
  const ETAString12 = (remainingTime >= 86400) ? '> day' : HHmmFormat12(ETA)

  // Correct/total for learning+review answers. 'new' is excluded: AnkiDroid
  // can't tell a new card's ease apart (see mobileReviewLogger.ts).
  const correctCount = estimator.logs.filter(x => x.logType === 'good' || x.logType === 'rev-good').length
  const incorrectCount = estimator.logs.filter(x => x.logType === 'again' || x.logType === 'rev-again').length
  const gradedCount = correctCount + incorrectCount
  const retentionRateString = gradedCount > 0 ? `${(100 * correctCount / gradedCount).toFixed(1)}%` : 'N/A'

  let message = (await getAddonConfig()).messageFormat as string
  message = message.replace('%(elapsedTime)', t2s(elapsedTime))
  message = message.replace('%(remainingTime)', t2s(remainingTime))
  message = message.replace('%(totalTime)', t2s(totalTime))
  message = message.replace('%(timePerCard)', t2s(timePerCard))
  message = message.replace('%(ETA)', ETAString24)
  message = message.replace('%(ETA12)', ETAString12)
  message = message.replace('%(CPM)', CPM)
  message = message.replace('%(RR)', retentionRateString)

  return message
}
