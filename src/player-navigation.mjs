import pathfinderPkg from 'mineflayer-pathfinder'
import vec3pkg from 'vec3'
import { protectMovementsFromFluid } from './hiyori-skills.mjs'

const { Movements, goals } = pathfinderPkg
const Vec3 = vec3pkg.Vec3 ?? vec3pkg
// Copper doors can also be operated by hand (unlike iron doors).
export const isDoor = block => Boolean(block && /(?:_door|_fence_gate|_trapdoor)$/.test(block.name))
export const canHandOpen = block => isDoor(block) && !/^iron_/.test(block.name)
export const blockProperties = block => block?.getProperties?.() ?? {}
export const blockIsOpen = block => [true, 'true', 1].includes(blockProperties(block).open)

/** Door halves are one obstruction. Always click the lower half. */
export function doorBase(bot, block) {
  return /_door$/.test(block?.name ?? '') && blockProperties(block).half === 'upper'
    ? bot.blockAt(block.position.offset(0, -1, 0)) ?? block : block
}

/** Check collision shapes, rather than accepting a short distance through a wall. */
export function lineOfSight(bot, from, to, allowedBlock) {
  const delta = to.minus(from), length = delta.norm()
  if (length < 0.05) return true
  if (bot.world?.raycast) {
    try {
      const hit = bot.world.raycast(from, delta.scaled(1 / length), length)
      return !hit || Boolean(allowedBlock && hit.position?.equals(allowedBlock))
        || Boolean(hit.intersect && hit.intersect.distanceTo(from) >= length - 0.15)
    } catch { return false }
  }
  if (!bot.blockAt) return true
  for (let t = 0.2; t < length; t += 0.2) {
    const p = from.plus(delta.scaled(t / length)).floored()
    if (allowedBlock?.equals(p)) continue
    const block = bot.blockAt(p)
    if (!block || block.boundingBox === 'block' && !(canHandOpen(block) && blockIsOpen(block))) return false
  }
  return true
}

export function playerInReach(bot, target, range) {
  return Boolean(target?.position && bot.entity?.position && bot.entity.position.distanceTo(target.position) <= range
    && lineOfSight(bot, bot.entity.position.offset(0, 1.5, 0), target.position.offset(0, 1.2, 0)))
}

export class PlayerFollowGoal extends goals.GoalFollow {
  constructor(bot, entity, range) { super(entity, range); this.bot = bot }
  isEnd(node) {
    return super.isEnd(node) && lineOfSight(this.bot, new Vec3(node.x + 0.5, node.y + 1.5, node.z + 0.5), this.entity.position.offset(0, 1.2, 0))
  }
}
export class PlayerNearGoal extends goals.GoalNear {
  constructor(bot, point, range) { super(point.x, point.y, point.z, range); this.bot = bot; this.point = point }
  isEnd(node) {
    return super.isEnd(node) && lineOfSight(this.bot, new Vec3(node.x + 0.5, node.y + 1.5, node.z + 0.5), this.point.offset(0, 1.2, 0))
  }
}
export class InteractionGoal extends goals.GoalGetToBlock {
  constructor(bot, block) { super(block.position.x, block.position.y, block.position.z); this.bot = bot; this.block = block }
  isEnd(node) {
    return super.isEnd(node) && lineOfSight(this.bot, new Vec3(node.x + 0.5, node.y + 1.5, node.z + 0.5), this.block.position.offset(0.5, 0.5, 0.5), this.block.position)
  }
}

/** Vanilla doors have two collision blocks; upstream only handles fence gates. */
export class PlayerMovements extends Movements {
  constructor(bot, { doors = true, blocked = new Map() } = {}) {
    super(bot)
    this.doorAssist = doors
    this.blockedDoors = blocked
    this.canDig = false
    this.allow1by1towers = false
    this.allowParkour = false
    this.maxDropDown = 3
    this.infiniteLiquidDropdownDistance = false
    this.scafoldingBlocks = []
    this.canOpenDoors = doors
    this.exclusionAreasPlace.push(() => Infinity)
    // Do not allow route generation to place inventory blocks in somebody's house.
    this.exclusionAreasStep.push(block => (this.blockedDoors.get(doorBase(bot, block)?.position?.toString()) ?? 0) > Date.now() ? 100 : 0)
  }
  getBlock(pos, dx, dy, dz) {
    const block = super.getBlock(pos, dx, dy, dz)
    if (!block?.name || !this.doorAssist || !isDoor(block) || /_trapdoor$/.test(block.name) || !canHandOpen(block) && !blockIsOpen(block)) return block
    const properties = blockProperties(block)
    block.physical = false
    block.safe = true
    block.height = block.position.y
    block.openable = !blockIsOpen(block) && properties.half !== 'upper'
    // Head clearance must include the door's upper half, but click only once.
    if (properties.half === 'upper' || blockIsOpen(block)) block.shapes = []
    return block
  }
  getMoveForward(node, dir, neighbors) {
    const start = neighbors.length
    super.getMoveForward(node, dir, neighbors)
    for (let i = start; i < neighbors.length; i++) {
      const uses = neighbors[i].toPlace.filter(p => p.useOne).length
      neighbors[i].remainingBlocks += uses // Clicking a door consumes no scaffolding.
    }
  }
  getMoveDiagonal(node, dir, neighbors) {
    // A diagonal shortcut cannot silently pass through a closed door without a useOne step.
    const cells = [[dir.x, dir.z], [dir.x, 0], [0, dir.z]]
    if (cells.some(([x, z]) => [0, 1].some(y => {
      const b = this.bot.blockAt(new Vec3(node.x + x, node.y + y, node.z + z))
      return isDoor(b) && !/_trapdoor$/.test(b.name) && !blockIsOpen(b)
    }))) return
    super.getMoveDiagonal(node, dir, neighbors)
  }
  getNeighbors(node) {
    const result = super.getNeighbors(node)
    for (const next of result) {
      const b = this.bot.blockAt(new Vec3(next.x, next.y, next.z))
      if (!this.doorAssist || !canHandOpen(b) || /_trapdoor$/.test(b.name) || blockIsOpen(b)) continue
      const base = doorBase(this.bot, b)
      if (!next.toPlace.some(p => p.useOne && p.x === base.position.x && p.y === base.position.y && p.z === base.position.z)) {
        next.toPlace.push({ ...base.position, dx: 0, dy: 0, dz: 0, useOne: true })
      }
    }
    return result
  }
}
export function playerMovements(bot, options) { return protectMovementsFromFluid(bot, new PlayerMovements(bot, options)) }

/** Idempotent and acknowledged. No toggling an already open door back shut. */
export async function setDoorState(bot, block, wanted, { signal, activate = bot.activateBlock.bind(bot), timeoutMs = 1800 } = {}) {
  block = doorBase(bot, block)
  signal?.throwIfAborted()
  if (blockIsOpen(bot.blockAt(block.position) ?? block) === wanted) return { outcome: 'succeeded', confirmed: true, open: wanted, changed: false }
  if (!canHandOpen(block)) return { outcome: 'blocked', confirmed: false, reason: '铁门/铁活板门需要红石控制，不能徒手打开', block: block?.name }
  let off, timer, abort
  const confirmation = new Promise((resolve, reject) => {
    const finish = error => { clearTimeout(timer); off?.(); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve() }
    const update = () => { if (blockIsOpen(bot.blockAt(block.position)) === wanted) finish() }
    abort = () => finish(new Error('开门动作已中断'))
    bot.on('blockUpdate', update); off = () => bot.off('blockUpdate', update)
    signal?.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => finish(new Error('门的状态没有得到服务器确认；可能被领地保护或路径阻挡')), timeoutMs)
    if (signal?.aborted) abort()
  })
  // Keep the rejection handled even if activateBlock throws or does not settle promptly.
  void confirmation.catch(() => {})
  try {
    await activate(block)
    signal?.throwIfAborted()
    await confirmation
    return { outcome: 'succeeded', confirmed: true, open: wanted, changed: true }
  } finally { clearTimeout(timer); off?.(); signal?.removeEventListener('abort', abort) }
}
