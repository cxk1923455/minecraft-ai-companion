import vec3pkg from 'vec3'
import pathfinderPkg from 'mineflayer-pathfinder'
import { patchedGoto, assessExcavationFluidRisk } from './hiyori-skills.mjs'
import { collectTarget } from './target-collection.mjs'
import { isNaturalLog, materialCount } from './material-supply.mjs'
import { TerrainExplorer } from './terrain-explorer.mjs'

const Vec3 = vec3pkg.Vec3 ?? vec3pkg
const { goals } = pathfinderPkg
const count = materialCount
const point = p => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) })
const key = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
const AIR = new Set(['air', 'cave_air', 'void_air'])
const NATURAL = new Set(['stone', 'deepslate', 'granite', 'diorite', 'andesite', 'tuff', 'calcite', 'dirt', 'coarse_dirt', 'rooted_dirt', 'grass_block', 'podzol', 'mycelium', 'netherrack', 'blackstone', 'basalt', 'end_stone'])
const FALLING = /^(?:sand|red_sand|gravel|suspicious_sand|suspicious_gravel|powder_snow|.+_concrete_powder)$/
const BUILT = /(?:_planks|_bricks|_door|_trapdoor|_stairs|_slab|_fence|_wall|_glass|_bed|_concrete|_terracotta)$|^(?:chest|trapped_chest|barrel|furnace|blast_furnace|smoker|crafting_table|glass|bookshelf|bricks|cobblestone|cobbled_deepslate|stone_bricks|iron_block|gold_block|diamond_block)$/
const FOODS = new Set(['cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'cooked_salmon', 'cooked_cod', 'bread', 'baked_potato', 'carrot', 'apple', 'melon_slice'])
const DIRECTIONS = [[1, 0], [0, 1], [-1, 0], [0, -1]]
const SOURCES = { diamond: ['diamond_ore', 'deepslate_diamond_ore'], raw_iron: ['iron_ore', 'deepslate_iron_ore'], raw_gold: ['gold_ore', 'deepslate_gold_ore'], raw_copper: ['copper_ore', 'deepslate_copper_ore'], coal: ['coal_ore', 'deepslate_coal_ore'], redstone: ['redstone_ore', 'deepslate_redstone_ore'], lapis_lazuli: ['lapis_ore', 'deepslate_lapis_ore'], cobblestone: ['stone'], cobbled_deepslate: ['deepslate'], dirt: ['dirt', 'grass_block'], sand: ['sand'], gravel: ['gravel'] }
const TOOLS = { diamond: 'iron_pickaxe', raw_gold: 'iron_pickaxe', redstone: 'iron_pickaxe', raw_iron: 'stone_pickaxe', raw_copper: 'stone_pickaxe', lapis_lazuli: 'stone_pickaxe', coal: 'wooden_pickaxe', cobblestone: 'wooden_pickaxe', cobbled_deepslate: 'wooden_pickaxe' }
const TIER = { wooden: 1, golden: 1, stone: 2, iron: 3, diamond: 4, netherite: 5 }

/** Version-aware targets are preferences, not promises that terrain contains an ore. */
export function resourceStrategy(bot, item) {
  const version = String(bot.version ?? '').match(/^(\d+)\.(\d+)/)
  const modern = Boolean(version && (+version[1] > 1 || +version[2] >= 18))
  const dimension = String(bot.game?.dimension ?? 'overworld')
  const minY = Number.isInteger(bot.game?.minY) ? bot.game.minY : modern && !/nether|end/.test(dimension) ? -64 : 0
  const heights = { diamond: modern ? -54 : 11, raw_iron: modern ? 16 : 32, raw_gold: modern ? -16 : 24, raw_copper: 48, coal: 48, redstone: modern ? -54 : 11, lapis_lazuli: modern ? -30 : 14, cobbled_deepslate: -8, cobblestone: Math.max(minY + 5, Math.floor(bot.entity?.position?.y ?? 64) - 3) }
  const underground = Object.hasOwn(heights, item)
  const targetY = underground ? Math.max(minY + 5, heights[item]) : null
  return { item, version: bot.version ?? null, dimension, minY, targetY, underground, valid: !(underground && /nether|end/.test(dimension)), method: underground ? 'loaded-caves-and-safe-staircase-then-branches' : 'loaded-surface-exploration' }
}

/** A bounded resource executor under TaskGoals' existing body ownership. No second bot or model. */
export class ResourceExpedition {
  constructor(skills, taskGoals, limits = {}) {
    this.skills = skills
    this.taskGoals = taskGoals
    this.terrain = new TerrainExplorer(skills, { taskGoals })
    this.limits = { maxSteps: 384, maxMined: 896, maxFailures: 16, ...limits }
    this.states = new WeakMap()
    this.memory = new Map()
    this.body = null
    this.dimension = null
  }
  resetFailures(job) {
    for (const state of this.states.get(job)?.values() ?? []) {
      state.stepBudgetBase = state.steps; state.minedBudgetBase = state.mined
      for (const p of state.failedVisits ?? []) { state.visited.delete(p); this.memory.delete(`${state.strategy.dimension}:${p}`) }
      state.failedVisits?.clear()
      state.failures = 0; state.reason = null; state.unreachable.clear(); state.rejected.clear()
    }
    this.terrain.resetFailures?.(job)
  }
  state(job, item) {
    const bot = this.skills.bot
    const dimension = String(bot.game?.dimension ?? 'overworld')
    if (this.body !== bot || this.dimension !== dimension) { this.memory.clear(); this.body = bot; this.dimension = dimension }
    let states = this.states.get(job)
    if (!states) { states = new Map(); this.states.set(job, states) }
    if (!states.has(item)) states.set(item, { item, strategy: resourceStrategy(bot, item), initial: count(bot, item), explored: 0, mined: 0, steps: 0, failures: 0, visited: new Set(), rejected: new Map(), unreachable: new Map(), scans: new Set(), direction: 0, branchLength: 0, reason: null, warning: null })
    return states.get(item)
  }
  async ready(job, state) {
    await this.taskGoals.ready(job)
    job.controller.signal.throwIfAborted()
    const deadline = job.deadline ?? job.deadlineAt
    if (Number.isFinite(deadline) && Date.now() >= deadline) throw new Error('资源远征时间预算耗尽；可查看当前深度后继续新目标')
    const bot = this.skills.bot
    if (this.body !== bot || String(bot.game?.dimension ?? 'overworld') !== state.strategy.dimension) throw new Error('游戏身体或维度已变化，旧采矿路线已停止')
    if ((bot.health ?? 20) <= (this.skills.settings?.healthThreshold ?? 6)) throw new Error('需要补给：血量过低，停止继续下矿')
    if ((bot.food ?? 20) <= 6 && !(bot.inventory.items() ?? []).some(item => FOODS.has(item.name))) throw new Error('需要补给：饥饿且没有可用食物，已暂停下矿')
    const canMerge = bot.inventory.items().some(item => (state.item === 'log' ? isNaturalLog(item.name) : item.name === state.item) && item.count < (bot.registry.itemsByName[item.name]?.stackSize ?? 64))
    if ((bot.inventory.emptySlotCount?.() ?? 1) === 0 && count(bot, state.item) < (state.total ?? Infinity) && !canMerge) throw new Error('需要卸货：背包已满，不能确认新资源拾取')
    this.publish(job, state)
  }
  publish(job, state) {
    job.progress ??= {}
    job.progress.expedition = { item: state.item, targetY: state.strategy.targetY, currentY: Math.floor(this.skills.bot.entity.position.y), position: point(this.skills.bot.entity.position), explored: state.explored, mined: state.mined, visited: state.visited.size, steps: state.steps, reason: state.reason, warning: state.warning }
  }
  remember(state, p, reason = null) {
    const id = `${state.strategy.dimension}:${key(p)}`
    this.memory.set(id, reason ?? 'visited')
    if (this.memory.size > 1024) this.memory.delete(this.memory.keys().next().value)
    state.visited.add(key(p))
    if (reason) { state.rejected.set(key(p), reason); state.reason = reason; (state.failedVisits ??= new Set()).add(key(p)) }
    this.publish(this.currentJob, state)
  }
  picks(bot, required = 'wooden_pickaxe') {
    const minTier = TIER[required.split('_')[0]] ?? 1
    return bot.inventory.items().filter(item => item.name.endsWith('_pickaxe') && (TIER[item.name.split('_')[0]] ?? 0) >= minTier)
      .map(item => ({ item, remaining: (bot.registry.itemsByName[item.name]?.maxDurability ?? 250) - (item.durabilityUsed ?? 0) }))
      .filter(entry => entry.remaining > 0).sort((a, b) => Number(b.remaining > 24) - Number(a.remaining > 24) || (TIER[b.item.name.split('_')[0]] ?? 0) - (TIER[a.item.name.split('_')[0]] ?? 0) || b.remaining - a.remaining)
  }
  async prepare(job, state, ancestry) {
    await this.ready(job, state)
    const required = TOOLS[state.item]
    if (required && !this.picks(this.skills.bot, required).some(entry => entry.remaining > 12)) {
      job.phase = `准备 ${required}（采矿工具与损耗检查）`
      await this.taskGoals.ensure(job, required, count(this.skills.bot, required) + 1, ancestry)
      if (!this.picks(this.skills.bot, required).length) throw new Error(`准备失败：背包没有能采集 ${state.item} 的 ${required}`)
    }
    await this.ready(job, state)
    const bot = this.skills.bot
    if ((bot.food ?? 20) <= 12 && bot.inventory.items().some(item => FOODS.has(item.name)) && this.skills.eat) await this.taskGoals.step(job, '补给进食', signal => this.skills.eat(signal))
    if (state.strategy.underground && !bot.inventory.items().some(item => FOODS.has(item.name))) state.warning = '背包未携带食物；饥饿或低血量时会停止下矿并报告补给需求'
  }
  names(bot, item) { return item === 'log' ? (bot.registry.blocksArray ?? []).filter(block => isNaturalLog(block.name)).map(block => block.name) : SOURCES[item] ?? [item] }
  nearby(state, radius) {
    const bot = this.skills.bot
    const ids = this.names(bot, state.item).map(name => bot.registry.blocksByName[name]?.id).filter(id => id !== undefined)
    if (!ids.length) return []
    return (bot.findBlocks({ matching: ids, maxDistance: Math.min(radius ?? 32, 48), count: 32 }) ?? [])
      .map(p => bot.blockAt(p)).filter(block => {
        if (!block || state.rejected.has(key(block.position))) return false
        const failure = state.unreachable.get(key(block.position))
        return !failure || state.mined >= failure.mined + 6 || bot.entity.position.distanceTo(failure.origin) >= 6
      })
      .sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position))
  }
  constructionNear(p) {
    const bot = this.skills.bot
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (let dy = -1; dy <= 2; dy++) {
      const block = bot.blockAt(p.offset(dx, dy, dz))
      if (block && BUILT.test(block.name)) return block.name
    }
    return null
  }
  safeStanding(p) {
    const bot = this.skills.bot
    const floor = bot.blockAt(p.offset(0, -1, 0)), feet = bot.blockAt(p), head = bot.blockAt(p.offset(0, 1, 0))
    return Boolean(floor?.boundingBox === 'block' && !/lava|water|magma|cactus|fire|powder_snow/.test(floor.name) && feet && head && AIR.has(feet.name) && AIR.has(head.name))
  }
  unsafeBreak(p, origin) {
    const bot = this.skills.bot, block = bot.blockAt(p)
    if (!block) return '路线区块尚未加载'
    if (AIR.has(block.name)) return null
    if (p.x === origin.x && p.z === origin.z && p.y < origin.y) return '禁止挖脚下直落'
    if (!NATURAL.has(block.name) && !/_ore$/.test(block.name)) return `保留非自然或危险方块 ${block.name}`
    if (block.name === 'bedrock' || p.y <= stateMinY(bot)) return '保留基岩与世界底部'
    const built = this.constructionNear(p)
    if (built) return `保护建筑：附近有 ${built}`
    for (const [dx, dy, dz] of [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
      const adjacent = bot.blockAt(p.offset(dx, dy, dz))
      if (!adjacent) return '路线相邻区块尚未加载'
      if (FALLING.test(adjacent.name)) return `上方或侧面有落沙危险 ${adjacent.name}`
    }
    const risk = assessExcavationFluidRisk(bot, p)
    return risk.unsafe ? `路线会引入 ${risk.liquid}` : null
  }
  async collectSeen(job, state, block) {
    const bot = this.skills.bot, before = count(bot, state.item)
    const origin = bot.entity.position.floored()
    if (block.position.x === origin.x && block.position.z === origin.z && block.position.y < origin.y) { state.rejected.set(key(block.position), '禁止挖脚下直落'); state.reason = '禁止挖脚下直落'; return false }
    const hazard = this.unsafeBreak(block.position, origin)
    const fluid = assessExcavationFluidRisk(bot, block.position)
    if (fluid.unsafe) { state.rejected.set(key(block.position), `资源邻近 ${fluid.liquid}`); state.reason = `资源邻近 ${fluid.liquid}`; return false }
    // Tree resources are intentionally collected by the existing helper; tunnel excavation never breaks logs.
    const surfaceLoose = ['sand', 'gravel'].includes(state.item) && block.name === state.item && block.position.y >= bot.entity.position.y - 1 && !FALLING.test(bot.blockAt(block.position.offset(0, 1, 0))?.name ?? '')
    if (hazard && !isNaturalLog(block.name) && !surfaceLoose) { state.rejected.set(key(block.position), hazard); state.reason = hazard; return false }
    if (this.constructionNear(block.position)) { state.rejected.set(key(block.position), '保护建筑中的资源方块'); return false }
    try {
      await this.taskGoals.step(job, `采集已观察到的 ${state.item}`, signal => this.skills.run(`收取 ${block.name}`, signal, async (s, b) => {
        await collectTarget(this.skills, b, block, s, 25000, candidate => this.constructionNear(candidate.position))
        s.throwIfAborted()
        await this.skills.inventoryBarrier(b, s)
      }, 26000))
    } catch (error) {
      job.controller.signal.throwIfAborted()
      state.unreachable.set(key(block.position), { origin: bot.entity.position.clone(), mined: state.mined }); state.reason = `资源可见但暂时不可达：${error.message}`
    }
    await this.ready(job, state)
    if (count(bot, state.item) <= before) { state.unreachable.set(key(block.position), { origin: bot.entity.position.clone(), mined: state.mined }); state.reason ??= '挖掘后没有实际拾取'; return false }
    return true
  }
  async walk(job, state, target, phase, exact = false) {
    const bot = this.skills.bot, before = bot.entity.position.clone()
    let result
    if (exact) result = await this.taskGoals.step(job, phase, signal => this.skills.run(phase, signal, async (s, b) => {
      b.pathfinder.setMovements(this.skills.movements(b))
      this.skills.host._selfMovingAt = Date.now()
      return this.skills.guarded(patchedGoto(b, new goals.GoalBlock(target.x, target.y, target.z), { signal: s }), s, 12000)
    }, 13000))
    else result = await this.taskGoals.step(job, phase, signal => this.skills.navigate({ ...point(target), range: 1, budgetMs: 12000 }, signal))
    await this.ready(job, state)
    const moved = bot.entity.position.distanceTo(before) >= 0.6
    const reached = exact ? key(bot.entity.position) === key(target) : bot.entity.position.distanceTo(target) <= 2
    if (result?.ok && moved && reached) { state.explored++; this.remember(state, bot.entity.position); return true }
    state.failures++; this.remember(state, target, `路线未实际到达：${result?.reason ?? '未移动'}`)
    return false
  }
  async explore(job, state, preferLower = false) {
    const terrain = await this.terrain.advance(job, { purpose: state.item === 'log' || /_log$|_stem$/.test(state.item) ? 'wood' : preferLower ? 'cave' : 'resource', item: state.item, preferLower })
    if (terrain.moved) {
      state.explored++; state.failures = 0
      this.remember(state, this.skills.bot.entity.position)
      return true
    }
    state.reason = terrain.reason ?? state.reason
    const bot = this.skills.bot, origin = bot.entity.position.floored(), candidates = []
    const vertical = preferLower ? [-1, -2, -3, -4, -5, 0, 1, 2] : [0, -1, 1, -2, 2, -3, -4]
    for (const distance of [4, 8, 12]) for (let direction = 0; direction < 8; direction++) {
      const angle = (direction + state.direction) * Math.PI / 4
      const x = origin.x + Math.round(Math.cos(angle) * distance), z = origin.z + Math.round(Math.sin(angle) * distance)
      for (const dy of vertical) {
        const target = new Vec3(x, origin.y + dy, z)
        if (state.visited.has(key(target)) || this.memory.has(`${state.strategy.dimension}:${key(target)}`) || !this.safeStanding(target)) continue
        const building = this.constructionNear(target)
        candidates.push({ target, score: (preferLower ? -dy * 4 : 0) + distance / 4 - (building ? 20 : 0) })
        break
      }
    }
    candidates.sort((a, b) => b.score - a.score)
    for (const { target } of candidates.slice(0, 6)) {
      try { if (await this.walk(job, state, target, preferLower && target.y < origin.y ? '进入已加载的天然洞穴' : '换区域寻找资源')) return true }
      catch (error) { job.controller.signal.throwIfAborted(); state.failures++; this.remember(state, target, error.message) }
    }
    return false
  }
  async excavate(job, state, ancestry, known = []) {
    const bot = this.skills.bot, origin = bot.entity.position.floored()
    const descending = origin.y > state.strategy.targetY
    const ascending = origin.y < state.strategy.targetY - 4
    const choices = DIRECTIONS.map(([dx, dz], index) => ({ dx, dz, index, score: index === state.direction ? -3 : 0 }))
    const closeOre = known.find(block => Math.abs(block.position.y - origin.y) <= 3 && bot.entity.position.distanceTo(block.position) <= 12)
    if (closeOre && !descending && !ascending) for (const choice of choices) choice.score -= (closeOre.position.x - origin.x) * choice.dx + (closeOre.position.z - origin.z) * choice.dz
    choices.sort((a, b) => a.score - b.score)
    for (const { dx, dz, index } of choices) {
      await this.ready(job, state)
      const target = origin.offset(dx, descending ? -1 : ascending ? 1 : 0, dz)
      if (target.y < state.strategy.minY + 5 || state.visited.has(key(target)) || state.rejected.has(key(target))) continue
      const floor = bot.blockAt(target.offset(0, -1, 0))
      if (!floor || floor.boundingBox !== 'block' || /lava|water|magma|cactus|fire|powder_snow/.test(floor.name)) { state.rejected.set(key(target), '没有已加载的稳固落脚地板，防止坠落'); state.reason = '没有稳固落脚地板，不能直挖或跌落'; continue }
      const cells = [target.offset(0, descending ? 2 : 1, 0), target.offset(0, 1, 0), target]
      if (ascending) cells.unshift(origin.offset(0, 2, 0))
      const unique = cells.filter((p, i) => cells.findIndex(q => key(q) === key(p)) === i)
      const hazard = unique.map(p => this.unsafeBreak(p, origin)).find(Boolean)
      if (hazard) { state.rejected.set(key(target), hazard); state.reason = hazard; continue }
      if (state.mined - (state.minedBudgetBase ?? 0) + unique.filter(p => !AIR.has(bot.blockAt(p).name)).length > this.limits.maxMined) { state.reason = '自然岩层挖掘预算耗尽'; return false }
      const miningTool = TOOLS[state.item] ?? 'wooden_pickaxe'
      if (!this.picks(bot, miningTool).some(entry => entry.remaining > 12)) await this.taskGoals.ensure(job, miningTool, count(bot, miningTool) + 1, ancestry)
      try {
        await this.taskGoals.step(job, descending ? `安全阶梯下矿：Y${origin.y} → ${target.y}，目标 ${state.strategy.targetY}` : ascending ? `安全阶梯返回矿层：Y${origin.y} → ${target.y}` : `矿层分支搜索：Y${origin.y}`, signal => this.skills.run('自然岩层阶梯开挖', signal, async (s, b) => {
          const pick = this.picks(b, miningTool)[0]?.item
          if (!pick) throw new Error('工具损耗后没有可用镐，需要补给')
          await this.skills.guarded(b.equip(pick, 'hand'), s, 5000)
          for (const p of unique) {
            s.throwIfAborted()
            const block = b.blockAt(p)
            if (!block || AIR.has(block.name)) continue
            const recheck = this.unsafeBreak(p, b.entity.position.floored())
            if (recheck) throw new Error(recheck)
            if (block.canHarvest && !block.canHarvest(b.heldItem?.type ?? pick.type)) throw new Error(`当前镐无法采集 ${block.name}`)
            if (b.canDigBlock && !b.canDigBlock(block)) throw new Error(`前方 ${block.name} 不在实际挖掘距离内`)
            await this.skills.guarded(b.dig(block), s, 15000)
            s.throwIfAborted()
            const actual = b.blockAt(p)
            if (!actual || !AIR.has(actual.name)) throw new Error('服务器没有确认岩层已挖开，停止重复开挖')
            state.mined++
            this.publish(job, state)
          }
          if (!this.safeStanding(target)) throw new Error('挖开后落脚地板或头部空间变化，停止前进')
        }, 50000))
        if (await this.walk(job, state, target, '走入已验证的阶梯/矿道', true)) {
          state.failures = 0
          state.direction = index; state.branchLength++
          if (!descending && state.branchLength >= 24) { state.direction = (index + 1) % 4; state.branchLength = 0 }
          return true
        }
      } catch (error) { job.controller.signal.throwIfAborted(); state.failures++; state.rejected.set(key(target), error.message); state.reason = error.message }
    }
    return false
  }
  async verify(job, state, total) {
    if (count(this.skills.bot, state.item) < total) return false
    await this.taskGoals.step(job, '核对服务器实际库存', signal => this.skills.run('资源库存验收', signal, (s, b) => this.skills.inventoryBarrier(b, s), 6000))
    return count(this.skills.bot, state.item) >= total
  }
  async obtain(job, item, total, ancestry = []) {
    this.currentJob = job
    const state = this.state(job, item), start = count(this.skills.bot, item)
    state.total = total
    let initialAttemptDone = false
    // A later preparation batch may need more of a resource that was previously obtained here.
    state.scans.clear()
    if (!Number.isInteger(total) || total < 0) throw new Error('目标资源库存必须是非负整数')
    await this.taskGoals.ready(job)
    job.controller.signal.throwIfAborted()
    if (await this.verify(job, state, total)) return this.result(state, start, total)
    if (!state.strategy.valid) throw new Error(`${state.strategy.dimension} 没有自然生成的 ${item}；请先通过正常传送门回到主世界`)
    await this.prepare(job, state, ancestry)
    const limit = this.limits.maxSteps + (state.stepBudgetBase ?? 0)
    for (; state.steps < limit && state.failures < this.limits.maxFailures; state.steps++) {
      await this.ready(job, state)
      if (await this.verify(job, state, total)) return this.result(state, start, total)
      const bot = this.skills.bot, origin = bot.entity.position.floored(), scanKey = key(origin)
      const known = this.nearby(state, job.radius)
      let gained = false
      for (const block of known.slice(0, 4)) {
        const exposed = DIRECTIONS.some(([dx, dz]) => AIR.has(bot.blockAt(block.position.offset(dx, 0, dz))?.name)) || AIR.has(bot.blockAt(block.position.offset(0, 1, 0))?.name)
        if (state.strategy.underground && (!exposed || bot.entity.position.distanceTo(block.position) > 8)) continue
        if (await this.collectSeen(job, state, block)) { gained = true; if (count(bot, item) >= total) break }
      }
      if (gained) continue
      // A single near-resource attempt permits existing adapters, but an empty area is never polled repeatedly.
      if (!state.scans.has(scanKey)) {
        state.scans.add(scanKey)
        if (!known.length && !initialAttemptDone) {
          initialAttemptDone = true
          const before = count(bot, item)
          const remaining = Math.max(1000, (job.deadline ?? Date.now() + 15000) - Date.now())
          try {
            const result = await this.taskGoals.step(job, `附近初次检查 ${item}`, signal => count(bot, item) >= total ? { outcome: 'succeeded' } : this.skills.collect({ item, count: Math.max(1, Math.min(64, total - count(bot, item))), radius: job.radius ?? 32, budgetMs: Math.min(15000, remaining) }, signal))
            if (count(bot, item) > before) { state.failures = 0; continue }
            state.reason = result.reason ?? '当前位置没有可采集资源；开始实际换区域/下矿'
          } catch (error) {
            job.controller.signal.throwIfAborted()
            state.reason = `附近尝试受阻，继续实际探索：${error.message}`
          }
        }
      }
      this.remember(state, origin)
      if (state.strategy.underground) {
        // Prefer real cave descent when a safe, loaded lower landing exists, then excavate a staircase.
        if (bot.entity.position.y > state.strategy.targetY && state.steps % 8 === 0 && await this.explore(job, state, true)) continue
        if (await this.excavate(job, state, ancestry, known)) continue
        if (await this.explore(job, state, bot.entity.position.y > state.strategy.targetY)) continue
      } else if (await this.explore(job, state)) continue
      state.reason ??= '已加载范围没有新的安全路线，不能破坏建筑、跨越液体或猜测未加载地形'
      break
    }
    return this.result(state, start, total)
  }
  result(state, start, total) {
    const actual = count(this.skills.bot, state.item), collected = Math.max(0, actual - start), succeeded = actual >= total
    return { outcome: succeeded ? 'succeeded' : collected ? 'partial' : 'blocked', item: state.item, collected, requested: Math.max(0, total - start), actual, reason: succeeded ? null : `资源远征未完成：${state.reason ?? '路线/时间预算结束'}（已移动 ${state.explored} 次、挖开 ${state.mined} 个自然方块，当前 Y${Math.floor(this.skills.bot.entity.position.y)}，目标层 ${state.strategy.targetY ?? '地表'}）`, explored: state.explored, mined: state.mined, strategy: state.strategy }
  }
}

function stateMinY(bot) { return resourceStrategy(bot, 'diamond').minY }
