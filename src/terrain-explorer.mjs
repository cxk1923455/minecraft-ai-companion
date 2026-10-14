import { performance } from 'node:perf_hooks'
import pathfinderPkg from 'mineflayer-pathfinder'
import vec3pkg from 'vec3'
import { patchedGoto } from './hiyori-skills.mjs'

const Vec3 = vec3pkg.Vec3 ?? vec3pkg
const { goals } = pathfinderPkg
const point = p => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) })
const cellKey = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
const areaKey = p => `${Math.floor(p.x / 4)},${Math.floor(p.y / 8)},${Math.floor(p.z / 4)}`
const danger = /^(?:water|lava|bubble_column|magma_block|cactus|fire|soul_fire|powder_snow|sweet_berry_bush|wither_rose|campfire|soul_campfire)$/
const built = /(?:_planks|_bricks|_door|_trapdoor|_stairs|_slab|_fence|_wall|_bed|_concrete)$|^(?:chest|trapped_chest|barrel|furnace|crafting_table|glass|bookshelf)$/
const wood = /^(?!stripped_).*(?:_log|_stem)$|^log2?$/
const oreSources = { diamond: ['diamond_ore', 'deepslate_diamond_ore'], raw_iron: ['iron_ore', 'deepslate_iron_ore'], coal: ['coal_ore', 'deepslate_coal_ore'], raw_copper: ['copper_ore', 'deepslate_copper_ore'], raw_gold: ['gold_ore', 'deepslate_gold_ore'], redstone: ['redstone_ore', 'deepslate_redstone_ore'], lapis_lazuli: ['lapis_ore', 'deepslate_lapis_ore'] }
const yieldTurn = () => new Promise(resolve => setImmediate(resolve))
const bounded = (value, fallback, min, max) => Math.min(max, Math.max(min, Number.isFinite(value) ? Math.floor(value) : fallback))

function remember(map, key, value, limit) {
  map.delete(key)
  map.set(key, value)
  while (map.size > limit) map.delete(map.keys().next().value)
}

/**
 * Non-destructive surface/cave exploration. A distant loaded landing point is
 * only a direction: each call moves along a checked, short native path segment.
 * It never treats an absent nearby resource as evidence that exploration is over.
 */
export class TerrainExplorer {
  constructor(skills, options = {}) {
    this.skills = skills
    this.taskGoals = options.taskGoals ?? skills.goals
    this.limits = {
      vertical: bounded(options.vertical, 48, 24, 64), radius: bounded(options.radius, 32, 12, 48),
      maxQueries: bounded(options.maxQueries, 6144, 128, 12288),
      maxCandidates: bounded(options.maxCandidates, 48, 8, 96),
      maxPathChecks: bounded(options.maxPathChecks, 8, 1, 16),
      pathSliceMs: bounded(options.pathSliceMs, 4, 1, 8),
      planningBudgetMs: bounded(options.planningBudgetMs, 110, 10, 250),
      segmentLength: bounded(options.segmentLength, 10, 3, 16),
      movementBudgetMs: bounded(options.movementBudgetMs, 12000, 1000, 30000),
      memorySize: bounded(options.memorySize, 512, 32, 2048),
      failureCooldownMs: bounded(options.failureCooldownMs, 30000, 1000, 120000),
    }
    this.jobs = new WeakMap()
    this.coverage = new Map()
    this.failures = new Map()
    this.bot = null
    this.dimension = null
  }

  state(job, options) {
    const bot = this.skills.bot, dimension = String(bot.game?.dimension ?? 'overworld')
    if (bot !== this.bot || dimension !== this.dimension) {
      this.coverage.clear(); this.failures.clear(); this.jobs = new WeakMap()
      this.bot = bot; this.dimension = dimension
    }
    let states = this.jobs.get(job)
    if (!states) { states = new Map(); this.jobs.set(job, states) }
    const key = `${options.purpose ?? 'resource'}:${options.item ?? ''}`
    if (!states.has(key)) states.set(key, { direction: 0, legs: 0, lastTarget: null, visited: new Map(), guides: [], guideAt: 0, guideOrigin: null })
    return states.get(key)
  }

  /** Explicit continuation may follow a server-side obstacle change. Keep the
   * successful route coverage; only failed previews/moves for this job expire. */
  resetFailures(job) {
    let cleared = 0
    for (const [key, failure] of this.failures) if (failure.job === job) {
      this.failures.delete(key)
      cleared++
    }
    return { cleared }
  }

  check(job, signal) {
    job.controller?.signal.throwIfAborted()
    signal?.throwIfAborted()
    if (Number.isFinite(job.deadline) && Date.now() >= job.deadline) throw new Error('探索时间预算耗尽；保留已探索方向与实际位置')
    if (this.bot !== this.skills.bot || this.dimension !== String(this.skills.bot.game?.dimension ?? 'overworld')) throw new Error('游戏身体或维度已变化，探索路线已停止')
  }

  guides(bot, state, options) {
    if (Array.isArray(options.targets)) return options.targets.filter(p => p && [p.x, p.y, p.z].every(Number.isFinite)).map(p => new Vec3(p.x, p.y, p.z)).slice(0, 12)
    if (!bot.findBlocks || !bot.registry?.blocksByName) return []
    if (state.guideOrigin && bot.entity.position.distanceTo(state.guideOrigin) < 6 && Date.now() - state.guideAt < 5000) return state.guides
    const entries = bot.registry.blocksArray ?? Object.values(bot.registry.blocksByName)
    const names = options.purpose === 'wood' || wood.test(options.item ?? '') || options.item === 'log'
      ? entries.filter(b => wood.test(b.name)).map(b => b.name)
      : oreSources[options.item] ?? (options.item ? [options.item] : [])
    const ids = names.map(name => bot.registry.blocksByName[name]?.id).filter(Number.isInteger)
    // A forest thirty horizontal blocks away and thirty below the player is
    // outside a radius-32 sphere despite being visible in the loaded terrain.
    const guideRadius = Math.min(64, Math.ceil(Math.hypot(this.limits.radius, this.limits.vertical)))
    state.guides = ids.length ? (bot.findBlocks({ matching: ids, maxDistance: guideRadius, count: 8 }) ?? []).slice(0, 8).map(p => new Vec3(p.x, p.y, p.z)) : []
    state.guideAt = Date.now(); state.guideOrigin = bot.entity.position.clone()
    return state.guides
  }

  context(job, signal) {
    const started = performance.now(), cache = new Map(), metrics = { queries: 0, candidates: 0, pathChecks: 0, pathNodes: 0, planningMs: 0, yielded: 0 }
    const clock = { pausedMs: 0 }
    const elapsed = () => performance.now() - started - clock.pausedMs
    const read = p => {
      this.check(job, signal)
      const cell = p.floored(), key = cellKey(cell)
      if (cache.has(key)) return cache.get(key)
      if (metrics.queries >= this.limits.maxQueries || elapsed() >= this.limits.planningBudgetMs) return null
      metrics.queries++
      const block = this.skills.bot.blockAt(cell)
      cache.set(key, block)
      return block
    }
    const standing = (p, route = false) => {
      const floor = read(p.offset(0, -1, 0)), feet = read(p), head = read(p.offset(0, 1, 0))
      if (!floor || !feet || !head || danger.test(floor.name) || danger.test(feet.name) || danger.test(head.name)) return false
      if (floor.boundingBox !== 'block' || floor.shapes?.length && !floor.shapes.some(s => s[1] < 1 && s[4] >= 0.99 && s[0] <= 0.3 && s[3] >= 0.7 && s[2] <= 0.3 && s[5] >= 0.7)) return false
      const clear = block => block.boundingBox === 'empty' || route && /(?:_door|_fence_gate)$/.test(block.name) && (!/^iron_/.test(block.name) || [true, 'true', 1].includes(block.getProperties?.().open))
      return clear(feet) && clear(head)
    }
    return { started, cache, metrics, read, standing, clock, elapsed,
      exhausted: () => metrics.queries >= this.limits.maxQueries || elapsed() >= this.limits.planningBudgetMs,
      scanExhausted: () => metrics.queries >= this.limits.maxQueries * 0.75 || elapsed() >= this.limits.planningBudgetMs * 0.7 }
  }

  score(origin, target, state, options, guides, context) {
    const dx = target.x - origin.x, dz = target.z - origin.z, distance = Math.hypot(dx, dz)
    const area = areaKey(target), last = this.coverage.get(area), local = state.visited.get(area)
    if ((this.failures.get(cellKey(target))?.until ?? 0) > Date.now()) return -Infinity
    if (state.lastTarget === cellKey(target)) return -Infinity
    let score = Math.min(distance, 24) * 0.45 + Math.cos(Math.atan2(dz, dx) - state.direction) * 5
    if (last) score -= 24 / Math.max(1, (Date.now() - last) / 30000)
    if (local) score -= 32
    if (options.preferLower || options.purpose === 'cave') score += Math.max(-12, Math.min(24, origin.y - target.y)) * 0.7
    if (guides.length) {
      const before = Math.min(...guides.map(p => p.distanceTo(origin)))
      const after = Math.min(...guides.map(p => p.distanceTo(target)))
      score += Math.max(-24, Math.min(24, before - after)) * 2.5
    }
    const floor = context.read(target.offset(0, -1, 0))
    if (built.test(floor?.name ?? '')) score -= 12
    if (/_leaves$/.test(floor?.name ?? '')) score -= 8
    // Only loaded landings are used. Adjacent unknown columns mark where walking
    // can load a new section, rather than asking pathfinding to traverse null air.
    for (const [x, z] of [[3, 0], [-3, 0], [0, 3], [0, -3]]) if (!context.read(target.offset(x, 0, z))) score += 3
    return score
  }

  async candidates(origin, state, options, context, job, signal) {
    const guides = this.guides(this.bot, state, options), columns = new Map(), candidates = []
    const add = (x, z) => {
      x = Math.floor(x); z = Math.floor(z)
      const distance = Math.hypot(x - origin.x, z - origin.z)
      if (distance >= 2 && distance <= this.limits.radius + 1) columns.set(`${x},${z}`, { x, z })
    }
    for (const guide of guides) for (const [x, z] of [[-2, 0], [2, 0], [0, -2], [0, 2]]) add(guide.x + x, guide.z + z)
    const angles = Array.from({ length: 12 }, (_, i) => state.direction + i * Math.PI / 6)
    for (const radius of [4, 8, 12, 18, 24, 32, 48].filter(r => r <= this.limits.radius)) for (const angle of angles) add(origin.x + Math.round(Math.cos(angle) * radius), origin.z + Math.round(Math.sin(angle) * radius))
    const heights = [0]
    for (let dy = 1; dy <= this.limits.vertical; dy++) heights.push(-dy, dy)
    let chunkAt = performance.now(), processed = 0
    for (const { x, z } of columns.values()) {
      this.check(job, signal)
      if (context.scanExhausted() || candidates.length >= this.limits.maxCandidates) break
      // Null at the current height identifies an unloaded whole column. It may
      // not be interpreted as an empty space below the player's feet.
      if (!context.read(new Vec3(x, origin.y, z))) continue
      for (const dy of heights) {
        if (context.scanExhausted()) break
        const p = new Vec3(x, origin.y + dy, z)
        if (context.standing(p)) {
          const score = this.score(origin, p, state, options, guides, context)
          if (Number.isFinite(score)) candidates.push({ target: p, score })
          break
        }
        if (performance.now() - chunkAt >= 3) {
          context.metrics.yielded++; await yieldTurn(); this.check(job, signal); chunkAt = performance.now()
        }
      }
      if (++processed % 12 === 0) { context.metrics.yielded++; await yieldTurn(); this.check(job, signal); chunkAt = performance.now() }
    }
    context.metrics.candidates = candidates.length
    return candidates.sort((a, b) => b.score - a.score)
  }

  nativePath(target, context) {
    const bot = this.bot, movement = context.movement ?? this.skills.movements(bot)
    // Do not mutate the cached movement policy to enable mining or scaffolding.
    if (movement.canDig !== false && movement.canDig !== undefined) return { status: 'unsafePolicy', path: [] }
    const goal = new goals.GoalBlock(target.x, target.y, target.z)
    if (bot.pathfinder?.getPathFromTo) {
      const generator = bot.pathfinder.getPathFromTo(movement, bot.entity.position, goal, {
        timeout: this.limits.pathSliceMs, tickTimeout: this.limits.pathSliceMs,
        searchRadius: this.limits.radius + 4, optimizePath: false,
      })
      try { return generator.next().value?.result ?? { status: 'noPath', path: [] } }
      finally { generator.return?.() }
    }
    if (bot.pathfinder?.getPathTo) return bot.pathfinder.getPathTo(movement, goal, this.limits.pathSliceMs)
    // Compatibility for small embedders without a native search API: only a
    // connected local cardinal route with known floor and head clearance.
    const start = bot.entity.position.floored(), queue = [{ p: start, path: [] }], seen = new Set([cellKey(start)])
    let best = queue[0], bestDistance = start.distanceTo(target)
    for (let i = 0; i < queue.length && i < 128 && !context.exhausted(); i++) {
      const node = queue[i]
      if (node.p.equals(target)) return { status: 'success', path: node.path }
      for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) for (const dy of [0, -1, 1]) {
        const p = node.p.offset(dx, dy, dz), key = cellKey(p)
        if (seen.has(key) || start.distanceTo(p) > this.limits.segmentLength || !context.standing(p)) continue
        if (dy === 1 && context.read(node.p.offset(0, 2, 0))?.boundingBox !== 'empty') continue
        if (dy === -1 && context.read(p.offset(0, 2, 0))?.boundingBox !== 'empty') continue
        seen.add(key)
        const next = { p, path: [...node.path, { ...point(p), toBreak: [], toPlace: [] }] }
        queue.push(next)
        const distance = p.distanceTo(target)
        if (distance < bestDistance) { best = next; bestDistance = distance }
        break
      }
    }
    return { status: best.path.length ? 'partial' : 'noPath', path: best.path }
  }

  walkingPolicy(bot) {
    const base = this.skills.movements(bot)
    if (base.canDig !== false && base.canDig !== undefined) return base
    const policy = Object.assign(Object.create(Object.getPrototypeOf(base)), base)
    policy.canDig = false
    policy.allowParkour = false
    policy.allow1by1towers = false
    policy.maxDropDown = Math.min(base.maxDropDown ?? 2, 2)
    policy.infiniteLiquidDropdownDistance = false
    policy.scafoldingBlocks = []
    policy.exclusionAreasPlace = [...(base.exclusionAreasPlace ?? []), () => Infinity]
    policy.exclusionAreasStep = [...(base.exclusionAreasStep ?? []), block => danger.test(block?.name ?? '') ? Infinity : 0]
    policy.entityIntersections = {}
    if (base.blocksToAvoid) policy.blocksToAvoid = new Set(base.blocksToAvoid)
    for (const block of bot.registry?.blocksArray ?? []) if (danger.test(block.name)) policy.blocksToAvoid?.add(block.id)
    if (base.getNeighbors) {
      policy.getNeighbors = function(node) {
        return base.getNeighbors.call(this, node).filter(next => {
          if (next.toBreak?.length || next.toPlace?.some(action => !action.useOne)) return false
          const p = new Vec3(next.x, next.y, next.z)
          return [-1, 0, 1].every(dy => {
            const block = bot.blockAt(p.offset(0, dy, 0))
            return block && !danger.test(block.name)
          })
        })
      }
    }
    return policy
  }

  async move(next, phase, budgetMs, signal, context) {
    const bot = this.bot, native = bot.pathfinder?.getPathFromTo || bot.pathfinder?.getPathTo
    // Keep old embedders/test stubs compatible. Real bodies use the same safe
    // policy for preview and execution so goto cannot select a new water route.
    if (!native || !this.skills.run || !this.skills.guarded || !bot.pathfinder?.setMovements) return this.skills.navigate({ ...point(next), range: 1, budgetMs }, signal)
    return this.skills.run(phase, signal, async (bodySignal, body) => {
      body.pathfinder.setMovements(context.movement)
      if (this.skills.host) this.skills.host._selfMovingAt = Date.now()
      const result = await this.skills.guarded(patchedGoto(body, new goals.GoalBlock(next.x, next.y, next.z), { signal: bodySignal }), bodySignal, budgetMs)
      const arrived = body.entity.position.distanceTo(next.offset(0.5, 0, 0.5)) <= 1.5
      return { ...result, ok: Boolean(result.ok && arrived), reason: arrived ? result.reason : result.reason ?? '实际身体未接近该段落脚点' }
    }, budgetMs + 500)
  }

  segment(result, origin, state, context) {
    let endpoint = null, length = 0, previous = origin
    for (const node of result.path ?? []) {
      context.metrics.pathNodes++
      const p = new Vec3(Math.floor(node.x), Math.floor(node.y), Math.floor(node.z))
      if (node.toBreak?.length || node.toPlace?.some(action => !action.useOne) || !context.standing(p, true)) break
      if (Math.abs(p.y - previous.y) > 3) break
      length += p.distanceTo(previous)
      if (length > this.limits.segmentLength + 1) break
      previous = p
      if (origin.distanceTo(p) >= 2 && context.standing(p) && state.lastTarget !== cellKey(p) && !((this.failures.get(cellKey(p))?.until ?? 0) > Date.now())) endpoint = p
    }
    return endpoint
  }

  publish(job, state, result) {
    job.progress ??= {}
    job.progress.terrain = {
      purpose: result.purpose, position: result.position, frontier: result.frontier ?? null,
      moved: result.moved, legs: state.legs, visitedAreas: state.visited.size,
      reason: result.reason ?? null, metrics: result.metrics,
    }
    return result
  }

  async advance(job, options = {}) {
    if (!job || typeof job !== 'object') throw new Error('地形探索需要当前任务对象')
    const state = this.state(job, options), bot = this.bot
    const signal = options.signal && job.controller?.signal && options.signal !== job.controller.signal
      ? AbortSignal.any([options.signal, job.controller.signal]) : options.signal ?? job.controller?.signal
    this.check(job, signal)
    await this.taskGoals?.ready?.(job)
    this.check(job, signal)
    const origin = bot.entity.position.floored(), context = this.context(job, signal)
    context.movement = this.walkingPolicy(bot)
    remember(this.coverage, areaKey(origin), Date.now(), this.limits.memorySize)
    remember(state.visited, areaKey(origin), Date.now(), this.limits.memorySize)
    const candidates = await this.candidates(origin, state, options, context, job, signal)
    let attempts = 0, finalReason = '已加载地形中没有安全可走的落脚点；保留任务目标以便恢复'
    for (const candidate of candidates) {
      this.check(job, signal)
      if (attempts >= this.limits.maxPathChecks || context.exhausted()) break
      attempts++; context.metrics.pathChecks++
      const path = this.nativePath(candidate.target, context)
      const next = this.segment(path, origin, state, context)
      if (!next) {
        remember(this.failures, cellKey(candidate.target), { job, until: Date.now() + this.limits.failureCooldownMs, reason: path.status }, this.limits.memorySize)
        finalReason = '当前方向没有安全的非破坏性路线，正在记忆受阻方向并轮换探索'
        await yieldTurn(); context.metrics.yielded++
        continue
      }
      context.metrics.planningMs = Number(context.elapsed().toFixed(2))
      const before = bot.entity.position.clone(), phase = options.purpose === 'wood' ? '沿实际山坡换区域寻找可用木材' : options.preferLower || options.purpose === 'cave' ? '沿已加载地形寻找天然下降路线' : '沿安全地面推进探索前沿'
      const remaining = Number.isFinite(job.deadline) ? job.deadline - Date.now() : this.limits.movementBudgetMs
      const budgetMs = Math.min(this.limits.movementBudgetMs, remaining)
      if (budgetMs < 1000) throw new Error('探索时间预算耗尽；没有启动下一段移动')
      let action
      const movingAt = performance.now()
      try {
        const move = taskSignal => this.move(next, phase, budgetMs, taskSignal && signal && taskSignal !== signal ? AbortSignal.any([taskSignal, signal]) : signal ?? taskSignal, context)
        action = this.taskGoals?.step ? await this.taskGoals.step(job, phase, move) : await move(signal)
      } catch (error) {
        this.check(job, signal)
        action = { reason: error.message }
      } finally {
        context.clock.pausedMs += performance.now() - movingAt
      }
      this.check(job, signal)
      const actual = bot.entity.position, moved = actual.distanceTo(before) >= 0.8
      // Movement itself may partially succeed before a later path failure. Real
      // position progress matters; a tool's optimistic status never suffices.
      if (moved) {
        const heading = Math.atan2(actual.z - before.z, actual.x - before.x)
        state.direction = Number.isFinite(heading) ? heading : state.direction
        state.lastTarget = cellKey(next); state.legs++
        remember(state.visited, areaKey(actual), Date.now(), this.limits.memorySize)
        remember(this.coverage, areaKey(actual), Date.now(), this.limits.memorySize)
        return this.publish(job, state, { outcome: action?.ok ? 'succeeded' : 'partial', moved: true, position: point(actual), purpose: options.purpose ?? 'resource', frontier: point(candidate.target), segment: point(next), attempts, reason: action?.ok ? null : action?.reason ?? '已推进一段实际路线，下一轮会从当前位置重新规划', metrics: context.metrics })
      }
      finalReason = action?.reason ?? '路线未产生实际位移；记忆该落脚点并换方向'
      remember(this.failures, cellKey(next), { job, until: Date.now() + this.limits.failureCooldownMs, reason: finalReason }, this.limits.memorySize)
      remember(this.failures, cellKey(candidate.target), { job, until: Date.now() + this.limits.failureCooldownMs, reason: finalReason }, this.limits.memorySize)
      state.direction += Math.PI / 3
      await yieldTurn(); context.metrics.yielded++
    }
    context.metrics.planningMs = Number(context.elapsed().toFixed(2))
    state.direction += Math.PI / 2
    return this.publish(job, state, { outcome: 'blocked', moved: false, position: point(bot.entity.position), purpose: options.purpose ?? 'resource', frontier: candidates[0] ? point(candidates[0].target) : null, attempts, reason: finalReason, metrics: context.metrics })
  }
}
