import { assessExcavationFluidRisk } from './hiyori-skills.mjs'

const key = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
const FALLING = /^(?:sand|red_sand|gravel|suspicious_sand|suspicious_gravel|powder_snow|.+_concrete_powder)$/

/** Enable only the explicit harvest cell, without changing the cached walking policy. */
export function targetCollectionMovements(base, bot, target, extraGuard = () => null) {
  const movements = Object.assign(Object.create(Object.getPrototypeOf(base)), base)
  movements.canDig = true
  movements.allow1by1towers = false
  movements.allowParkour = false
  movements.maxDropDown = Math.min(base.maxDropDown ?? 1, 1)
  // collectblock sets these to false before harvesting. Retain the guards through that assignment.
  for (const name of ['dontCreateFlow', 'dontMineUnderFallingBlock']) Object.defineProperty(movements, name, { enumerable: true, configurable: true, get: () => true, set: () => {} })
  movements.exclusionAreasBreak = [...(base.exclusionAreasBreak ?? []), block => {
    if (!block?.position || key(block.position) !== key(target.position) || block.type !== target.type) return 100
    const current = bot.blockAt(block.position)
    if (!current || current.type !== target.type) return 100
    const origin = bot.entity.position.floored()
    if (block.position.x === origin.x && block.position.z === origin.z && block.position.y < origin.y) return 100
    for (const [dx, dy, dz] of [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]]) {
      const neighbor = bot.blockAt(block.position.offset(dx, dy, dz))
      if (!neighbor || /^(?:lava|flowing_lava|water|flowing_water)$/.test(neighbor.name) || dy >= 0 && FALLING.test(neighbor.name)) return 100
    }
    if (assessExcavationFluidRisk(bot, block.position).unsafe || extraGuard(block)) return 100
    return 0
  }]
  return movements
}

/** Restore policy only when the actual library call settles, including after guarded timeout. */
export async function collectTarget(skills, bot, target, signal, budgetMs = 45000, extraGuard = () => null) {
  signal?.throwIfAborted()
  const walking = skills.movements(bot), previous = bot.collectBlock.movements
  const harvesting = targetCollectionMovements(walking, bot, target, extraGuard)
  bot.collectBlock.movements = harvesting
  const operation = Promise.resolve().then(() => {
    signal?.throwIfAborted()
    return bot.collectBlock.collect(target, { ignoreNoPath: false })
  }).finally(() => {
    if (bot.collectBlock.movements === harvesting) bot.collectBlock.movements = previous
    if (!bot.pathfinder.movements || bot.pathfinder.movements === harvesting) bot.pathfinder.setMovements(walking)
  })
  return skills.guarded(operation, signal, budgetMs)
}
