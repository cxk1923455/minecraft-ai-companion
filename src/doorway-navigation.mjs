import vec3pkg from 'vec3'
import { patchedGoto } from './hiyori-skills.mjs'
import { blockIsOpen, canHandOpen, doorBase, isDoor, PlayerNearGoal, playerInReach } from './player-navigation.mjs'

const Vec3 = vec3pkg.Vec3 ?? vec3pkg
const attachments = new WeakMap()
const plainPosition = p => p ? { x: Number(p.x.toFixed(2)), y: Number(p.y.toFixed(2)), z: Number(p.z.toFixed(2)) } : null
const traversableDoor = block => isDoor(block) && !/_trapdoor$/.test(block.name) && (canHandOpen(block) || blockIsOpen(block))

/** Correct upstream's habit of treating an open vertical door panel as a floor. */
export function correctDoorwayPath(bot, result) {
  if (!Array.isArray(result?.path)) return result
  let afterDoorUse = false
  result.path = result.path.map(point => {
    const raw = new Vec3(Math.floor(point.x), Math.floor(point.y), Math.floor(point.z))
    let observed = bot.blockAt(raw)
    if (!traversableDoor(observed)) {
      const below = bot.blockAt(raw.offset(0, -1, 0))
      if (traversableDoor(below)) observed = below
    }
    const door = traversableDoor(observed) ? doorBase(bot, observed) : null
    const actions = point.toPlace ?? []
    if (actions.some(action => !action.useOne)) afterDoorUse = false
    if (door || actions.some(action => action.useOne && traversableDoor(bot.blockAt(new Vec3(action.x, action.y, action.z))))) afterDoorUse = true
    if (!door && !afterDoorUse) return point
    const copy = Object.assign(Object.create(Object.getPrototypeOf(point)), point)
    if (door) {
      copy.x = door.position.x + 0.5
      copy.y = door.position.y
      copy.z = door.position.z + 0.5
    } else if (afterDoorUse && Number.isInteger(copy.x) && Number.isInteger(copy.z)) {
      // Upstream stops centering the rest of a path at the first interaction.
      // A door click, unlike scaffold placement, does not change the floor.
      copy.x += 0.5
      copy.z += 0.5
    }
    return copy
  })
  return result
}

/** Returns an idempotent detach function. All partial/replanned paths are covered. */
export function attachDoorwayNavigation(bot) {
  if (attachments.has(bot)) return attachments.get(bot).detach
  const state = { revision: 0, pendingReplan: false, detached: false }
  const pathfinder = bot.pathfinder, original = pathfinder?.getPathFromTo
  const wrapped = original && function* (...args) {
    for (const value of original.apply(this, args)) {
      correctDoorwayPath(bot, value.result)
      yield value
    }
  }
  if (wrapped) pathfinder.getPathFromTo = wrapped
  const onPath = result => correctDoorwayPath(bot, result)
  const onUpdate = (oldBlock, newBlock) => {
    if (!isDoor(oldBlock) && !isDoor(newBlock)) return
    if (oldBlock?.stateId === newBlock?.stateId) return
    state.revision++
    bot.emit('doorway_changed', { position: newBlock?.position ?? oldBlock?.position, revision: state.revision })
    if (!traversableDoor(newBlock) || !blockIsOpen(newBlock) || !pathfinder?.goal || state.pendingReplan) return
    const goal = pathfinder.goal
    state.pendingReplan = true
    queueMicrotask(() => {
      state.pendingReplan = false
      if (state.detached || pathfinder.goal !== goal) return
      // useOne otherwise leaves upstream in its scaffold-placement branch after
      // the click. Recompute from the acknowledged open doorway, not prediction.
      pathfinder.setGoal(goal, Boolean(goal.entity))
    })
  }
  bot.prependListener('path_update', onPath)
  bot.on('blockUpdate', onUpdate)
  state.detach = () => {
    if (state.detached) return
    state.detached = true
    bot.off('path_update', onPath)
    bot.off('blockUpdate', onUpdate)
    if (wrapped && pathfinder.getPathFromTo === wrapped) pathfinder.getPathFromTo = original
    attachments.delete(bot)
  }
  attachments.set(bot, state)
  return state.detach
}

export const doorwayRevision = bot => attachments.get(bot)?.revision ?? 0

/** Retry a blocked follow once when the server actually opens a blocked door. */
export function shouldResumeBlockedFollow(bot, state, target, blockedDoors = new Map(), now = Date.now()) {
  if (!target?.position) return false
  if (state.targetPosition && state.targetPosition.distanceTo(target.position) >= 2) return true
  let opened = false
  for (const [key, until] of blockedDoors) {
    const values = key.replace(/[()]/g, '').split(',').map(Number)
    if (values.length !== 3 || !values.every(Number.isFinite)) continue
    const block = bot.blockAt(new Vec3(...values))
    if (block && (blockIsOpen(block) || !isDoor(block))) { blockedDoors.delete(key); opened = true }
    else if (until <= now) blockedDoors.delete(key)
  }
  const revision = doorwayRevision(bot)
  const changed = state.blockedDoorwayRevision !== undefined && state.blockedDoorwayRevision !== revision
  state.blockedDoorwayRevision = revision
  return opened || changed
}

/** Explicit room entry ends beside the interior target, never at the threshold. */
export function enterRoom(skills, args = {}, signal) {
  const budget = Number(args.budgetMs ?? 45000)
  if (!Number.isInteger(budget) || budget < 1000 || budget > 120000) throw new Error('budgetMs 必须为 1000–120000 毫秒')
  return skills.run('进入房间', signal, async (s, bot) => {
    const start = bot.entity.position.clone(), startedAt = Date.now()
    const coordinate = ['x', 'y', 'z'].every(k => args[k] !== null && args[k] !== undefined && Number.isFinite(Number(args[k])))
    let who = args.who ?? (coordinate ? null : skills.follow)
    if (!who && !coordinate) {
      who = Object.entries(bot.players ?? {}).filter(([, player]) => player.entity?.position && player.entity !== bot.entity)
        .sort((a, b) => start.distanceTo(a[1].entity.position) - start.distanceTo(b[1].entity.position))[0]?.[0]
    }
    if (!who && !coordinate) throw new Error('进房间需要可见玩家 who，或房间内部的 x/y/z 落脚点')
    const targetNow = () => who ? skills.findPlayer(String(who))?.position : new Vec3(Number(args.x), Number(args.y), Number(args.z))
    let result, attempts = 0, previousTarget, previousRevision
    do {
      s?.throwIfAborted()
      const point = targetNow()
      if (!point) return { outcome: 'blocked', arrived: false, entered: false, confirmed: false, reason: '目标玩家已不可见', player: who }
      if (attempts && point.distanceTo(previousTarget) < 1 && doorwayRevision(bot) === previousRevision) break
      previousTarget = point.clone(); previousRevision = doorwayRevision(bot); attempts++
      bot.pathfinder.setMovements(skills.movements(bot))
      skills.host._selfMovingAt = Date.now()
      const goal = new PlayerNearGoal(bot, point.clone(), 1)
      const preview = bot.pathfinder.getPathTo?.(bot.pathfinder.movements, goal)
      if (preview?.status === 'noPath') {
        // Upstream may return a partial closest-point path with noPath status.
        // Following it cannot cross the sole blocked entrance; do not spend
        // another fifteen seconds walking into it before reporting the barrier.
        result = { ok: false, reason: 'noPath', message: '找不到通往房间内部的完整路线；入口可能需要红石控制、被保护或缺少可通行的落脚点' }
        break
      }
      result = await skills.guarded(patchedGoto(bot, goal, { signal: s }), s, Math.max(1, budget - (Date.now() - startedAt)))
      const current = targetNow(), entity = current ? { position: current } : null
      if (result.ok && playerInReach(bot, entity, 1.75)) {
        return { ...result, outcome: 'succeeded', arrived: true, entered: true, confirmed: true, attempts, player: who ?? null,
          position: plainPosition(bot.entity.position), target: plainPosition(current), distance: Number(bot.entity.position.distanceTo(current).toFixed(2)),
          moved: Number(start.distanceTo(bot.entity.position).toFixed(2)), note: '实际位置已到室内目标同侧，门槛外、隔墙和门中间均不算进入。' }
      }
    } while (attempts < 3 && Date.now() - startedAt < budget - 200)
    const target = targetNow()
    return { ...result, outcome: 'blocked', arrived: false, entered: false, confirmed: false, attempts, player: who ?? null,
      position: plainPosition(bot.entity.position), target: plainPosition(target), reason: result?.message ?? '未能到达房间内部的落脚点；请检查门的服务器状态和可通行入口' }
  }, budget + 500)
}
