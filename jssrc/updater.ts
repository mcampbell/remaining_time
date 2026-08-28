import { Estimator } from './estimator'
import { EstimatorInst, RCCTConst } from './reviewLogger/types'
import { getReviewLogger } from './reviewLogger'
import { getCurrentDeckName, saveDeckRates } from './utils/deckRate'
import { debugLog } from './utils/debugLog'

function applyInstruction (estimator: Estimator, instruction: EstimatorInst) {
  switch (instruction.instType) {
    case RCCTConst.IGNORE:
      break

    case RCCTConst.UNDO:
      estimator.undo()
      break

    case RCCTConst.RESET:
      estimator.reset()
      break

    case RCCTConst.UPDATE:
      estimator.update(instruction.reviewHash, instruction.logType)
      break
  }
}

export async function updateEstimator () {
  const estimator = await Estimator.instance()
  const logger = await getReviewLogger()
  const instructions = await logger.poll()

  for (const instruction of instructions) {
    await debugLog(`[updateEstimator] new instruction: ${JSON.stringify(instruction)}`)
    applyInstruction(estimator, instruction)
  }
  estimator.save()

  // Under sharedETACalc the rate is already fully persisted via
  // estimator.save() above (part of the sitting's own blob) - writing it to
  // the CURRENT CARD's deck bucket here would just be per-card noise, since
  // nothing reads it back while sharedETACalc is on.
  const anyUpdated = instructions.some(instruction => instruction.instType === RCCTConst.UPDATE)
  if (anyUpdated && !estimator.sharedETACalc) {
    const deckName = await getCurrentDeckName()
    if (deckName) {
      await saveDeckRates(deckName, { rate: estimator.rates })
    }
  }
}
