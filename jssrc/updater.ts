import { Estimator } from './estimator'
import { EstimatorInst, RCCTConst } from './reviewLogger/types'
import { getReviewLogger } from './reviewLogger'
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
  await estimator.save()
}
