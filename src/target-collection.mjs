import pathfinderPkg from 'mineflayer-pathfinder'
import { assessExcavationFluidRisk, patchedGoto } from './hiyori-skills.mjs'

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

function pickupGrace(bot, target, before, ms, signal) {
  signal?.throwIfAborted()
  if (stock(bot, target) > before) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const done = error => { clearTimeout(timer); bot.inventory?.off?.('updateSlot', update); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve() }
    const update = () => { if (stock(bot, target) > before) done() }
    const abort = () => done(Object.assign(new Error('采集已中断'), { mcAborted: true }))
    const timer = setTimeout(done, ms)
    bot.inventory?.on?.('updateSlot', update)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort(); else update()
  })
}
const DROPS = { stone: 'cobblestone', deepslate: 'cobbled_deepslate', grass_block: 'dirt', diamond_ore: 'diamond', coal_ore: 'coal',
  iron_ore: 'raw_iron', gold_ore: 'raw_gold', copper_ore: 'raw_copper', redstone_ore: 'redstone', lapis_ore: 'lapis_lazuli' }
const stock = (bot, target) => {
  const name = target.name.replace(/^deepslate_/, ''), drop = DROPS[name]
  return (bot.inventory?.items?.() ?? []).filter(item => item.name === target.name || item.name === drop).reduce((n, item) => n + item.count, 0)
}

/** Harvest and pick up through independently cancellable, bounded steps. The
 * legacy collector waits indefinitely for entityGone and ten physics ticks;
 * clearing its targets cannot settle those waits. Real Mineflayer bodies never
 * enter that wait, even when a drop disappears before listeners are attached. */
async function harvest(skills, bot, target, policy, signal, budgetMs) {
  const started = Date.now(), before = stock(bot, target), drops = []
  const remaining = cap => {
    signal?.throwIfAborted()
    const left = Math.min(cap, budgetMs - (Date.now() - started))
    if (left <= 0) throw Object.assign(new Error('采集时间预算耗尽'), { mcTimeout: true })
    return left
  }
  const go = async (goal, cap) => {
    const result = await skills.guarded(patchedGoto(bot, goal, { signal }), signal, remaining(cap))
    if (!result.ok) throw new Error(result.message ?? result.reason ?? '资源没有可达路径')
  }
  const dropListener = entity => {
    if (drops.length < 8 && entity?.position && entity.position.distanceTo(target.position.offset(0.5, 0.5, 0.5)) <= 2) drops.push(entity)
  }
  bot.on('itemDrop', dropListener)
  try {
    // Approach with a walking policy. Only the explicit manual dig may harvest
    // the target; the pathfinder must not mine it merely to stand in its cell.
    bot.pathfinder.setMovements(skills.movements(bot))
    let block = bot.blockAt(target.position)
    if (!block || block.type !== target.type || !policy.safeToBreak(block)) return { outcome: 'blocked', reason: '目标已变化或不符合安全采集条件' }
    await go(new pathfinderPkg.goals.GoalLookAtBlock(block.position, bot.world), 12000)
    block = bot.blockAt(target.position)
    if (!block || block.type !== target.type || !policy.safeToBreak(block)) return { outcome: 'blocked', reason: '接近后目标变化或不符合安全采集条件' }
    await skills.guarded(bot.tool.equipForBlock(block, { requireHarvest: true, getFromChest: false, maxTools: 1 }), signal, remaining(5000))
    signal?.throwIfAborted()
    if (typeof block.canHarvest === 'function' && !block.canHarvest(bot.heldItem?.type ?? null)) throw new Error(`当前工具不能获得 ${block.name} 的掉落物`)
    await skills.guarded(bot.dig(block), signal, remaining(15000))
    // Wall time advances even when physics simulation is paused. Do not wait
    // for an entityGone event: inventory is the authoritative completion test.
    await pickupGrace(bot, target, before, remaining(400), signal)
    for (const drop of drops) {
      if (stock(bot, target) > before) break
      if (drop.isValid === false || !drop.position || bot.entities?.[drop.id] !== drop) continue
      await go(new pathfinderPkg.goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 1), 4000)
      await pickupGrace(bot, target, before, remaining(200), signal)
    }
    if (skills.inventoryBarrier) await skills.guarded(skills.inventoryBarrier(bot, signal), signal, remaining(5000))
    const current = bot.blockAt(target.position)
    const mined = Boolean(current && current.type !== target.type)
    return { outcome: stock(bot, target) > before ? 'succeeded' : 'partial', mined, collected: stock(bot, target) > before,
      reason: stock(bot, target) > before ? null : '方块挖掘已结束，尚无服务器背包拾取证据；继续搜索其他可达资源' }
  } finally {
    bot.off('itemDrop', dropListener)
  }
}

/** Restore policy only when actual equip/dig promises have settled. Minimal
 * embedders without the Mineflayer action API keep their existing adapter. */
export async function collectTarget(skills, bot, target, signal, budgetMs = 45000, extraGuard = () => null) {
  signal?.throwIfAborted()
  const walking = skills.movements(bot), previous = bot.collectBlock.movements
  const harvesting = targetCollectionMovements(walking, bot, target, extraGuard)
  bot.collectBlock.movements = harvesting
  bot.pathfinder.setMovements(harvesting)
  const operation = Promise.resolve().then(() => {
    signal?.throwIfAborted()
    if (typeof bot.dig === 'function' && typeof bot.pathfinder.setGoal === 'function' && typeof bot.world?.raycast === 'function') return harvest(skills, bot, target, harvesting, signal, budgetMs)
    return bot.collectBlock.collect(target, { ignoreNoPath: false })
  }).finally(() => {
    if (bot.collectBlock.movements === harvesting) bot.collectBlock.movements = previous
    if (!bot.pathfinder.movements || bot.pathfinder.movements === harvesting) bot.pathfinder.setMovements(walking)
  })
  return skills.guarded(operation, signal, budgetMs)
}
