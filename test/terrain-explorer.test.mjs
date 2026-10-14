import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { TerrainExplorer } from '../src/terrain-explorer.mjs'
import { PlayerMovements } from '../src/player-navigation.mjs'

const require = createRequire(import.meta.url), mfRequire = createRequire(require.resolve('mineflayer'))
const registry = mfRequire('prismarine-registry')('1.21.11')
const Block = mfRequire('prismarine-block')(registry), { Vec3 } = mfRequire('vec3')
const { Physics, PlayerState } = mfRequire('prismarine-physics')
const { pathfinder, goals } = require('mineflayer-pathfinder')
const flush = () => new Promise(resolve => setImmediate(resolve))
const controls = () => ({ forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false })

/** Real registry collision shapes, native A*, and vanilla player physics. */
function terrain({ height = () => 64, bounds = p => p.x >= -16 && p.x <= 48 && Math.abs(p.z) <= 16, start = new Vec3(0.5, 64, 0.5), modify, nativeBody = false } = {}) {
  const bot = new EventEmitter(), blocks = new Map(), moves = [], paths = [], phases = []
  let queries = 0, waterTicks = 0
  const put = (name, p) => blocks.set(p.toString(), name)
  Object.assign(bot, {
    username: 'ExplorerAI', version: '1.21.11', registry, health: 20, food: 20,
    game: { dimension: 'overworld', minY: -64 }, inventory: { slots: Array(46).fill(null), items: () => [] },
    controlState: controls(), entities: {}, players: {},
    entity: { position: start, velocity: new Vec3(0, 0, 0), height: 1.8, width: 0.6,
      yaw: -Math.PI / 2, pitch: 0, onGround: true, effects: {}, attributes: {}, isInWater: false, isInLava: false },
    blockAt(p) {
      queries++
      const position = p.floored()
      if (!bounds(position) || position.y < -64 || position.y > 319) return null
      const h = height(position), replaced = modify?.(position)
      const name = replaced ?? blocks.get(position.toString()) ?? (position.y < h ? 'stone' : 'air')
      const spec = registry.blocksByName[name], b = Block.fromStateId(spec.minStateId, 0)
      b.position = position
      return b
    },
    findBlocks({ matching, maxDistance, count }) {
      return [...blocks].filter(([key, name]) => matching.includes(registry.blocksByName[name].id))
        .map(([key]) => { const [x, y, z] = key.slice(1, -1).split(',').map(Number); return new Vec3(x, y, z) })
        .filter(p => p.distanceTo(bot.entity.position) <= maxDistance).sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position)).slice(0, count)
    },
    setControlState(key, value) { this.controlState[key] = value }, clearControlStates() { this.controlState = controls() },
    look(yaw, pitch) { this.entity.yaw = yaw; this.entity.pitch = pitch }, lookAt: async () => {},
    stopDigging() {}, equip: async () => {},
    dig() { throw new Error('Explorer must never dig') }, placeBlock() { throw new Error('Explorer must never place') },
  })
  bot.physics = Physics(registry, { getBlock: p => bot.blockAt(p) })
  pathfinder(bot)
  const movement = new PlayerMovements(bot)
  bot.pathfinder.setMovements(movement)
  bot.pathfinder.thinkTimeout = 100
  bot.pathfinder.tickTimeout = 5
  bot.pathfinder.searchRadius = 40
  bot.on('path_update', p => paths.push({ ...p, path: p.path.map(node => ({ x: node.x, y: node.y, z: node.z })) }))
  const controller = new AbortController(), job = { controller, progress: {}, deadline: Date.now() + 120000 }
  const skills = {
    bot, movements: () => movement, goals: {
      ready: async job => job.controller.signal.throwIfAborted(),
      step: async (job, phase, action) => { phases.push(phase); return action(job.controller.signal) },
    },
    async navigate(args, signal) {
      signal?.throwIfAborted()
      moves.push({ ...args })
      const target = new Vec3(args.x, args.y, args.z)
      bot.pathfinder.setGoal(new goals.GoalNear(args.x, args.y, args.z, args.range ?? 1))
      for (let i = 0; i < 320 && bot.pathfinder.goal; i++) {
        signal?.throwIfAborted()
        bot.emit('physicsTick')
        const state = new PlayerState(bot, bot.controlState)
        bot.physics.simulatePlayer(state, { getBlock: p => bot.blockAt(p) }).apply(bot)
        if (bot.entity.isInWater || bot.entity.isInLava) waterTicks++
        await flush()
      }
      const ok = bot.entity.position.distanceTo(target) <= 1.5
      bot.pathfinder.setGoal(null)
      return { ok, outcome: ok ? 'succeeded' : 'partial', reason: ok ? null : '实际物理路线未完全到达' }
    },
  }
  if (nativeBody) {
    skills.guarded = async (promise, signal) => { signal.throwIfAborted(); const value = await promise; signal.throwIfAborted(); return value }
    skills.run = async (_, signal, operation) => {
      let finished = false, result, error
      const pending = operation(signal, bot).then(value => { result = value; finished = true }, failure => { error = failure; finished = true })
      const goal = bot.pathfinder.goal
      if (goal) moves.push({ x: goal.x, y: goal.y, z: goal.z })
      for (let i = 0; i < 400 && !finished; i++) {
        bot.emit('physicsTick')
        bot.physics.simulatePlayer(new PlayerState(bot, bot.controlState), { getBlock: p => bot.blockAt(p) }).apply(bot)
        if (bot.entity.isInWater || bot.entity.isInLava) waterTicks++
        await flush()
      }
      if (!finished) { bot.pathfinder.setGoal(null); await flush() }
      await pending
      if (error) throw error
      return result
    }
  }
  return { bot, skills, job, controller, moves, paths, phases, put, movement, queries: () => queries, waterTicks: () => waterTicks }
}

test('native path and player physics descend a mountain toward a visible forest thirty blocks below', async () => {
  const f = terrain({ height: p => 120 - Math.max(0, p.x), start: new Vec3(0.5, 120, 0.5), nativeBody: true })
  for (let y = 90; y <= 95; y++) f.put('oak_log', new Vec3(30, y, 0))
  const explorer = new TerrainExplorer(f.skills)
  for (let leg = 0; leg < 12 && f.bot.entity.position.x < 25; leg++) {
    const result = await explorer.advance(f.job, { purpose: 'wood', item: 'oak_log' })
    assert.equal(result.moved, true, JSON.stringify(result))
    assert.ok(result.metrics.pathChecks <= explorer.limits.maxPathChecks)
  }
  assert.ok(f.bot.entity.position.x >= 25, `must walk down the slope toward the forest, actual ${f.bot.entity.position}`)
  assert.ok(f.bot.entity.position.y <= 96, `must change elevation, actual ${f.bot.entity.position}`)
  assert.ok(f.paths.some(p => p.path.some(node => node.y < 116)))
  assert.equal(f.movement.canDig, false)
  assert.ok(f.phases.every(phase => phase.includes('木材')))
})

test('uphill exploration finds a loaded surface twenty four blocks above rather than requiring equal altitude', async () => {
  const f = terrain({ height: p => 64 + Math.max(0, p.x), start: new Vec3(0.5, 64, 0.5), nativeBody: true })
  for (let y = 88; y <= 92; y++) f.put('birch_log', new Vec3(24, y, 0))
  const explorer = new TerrainExplorer(f.skills)
  for (let leg = 0; leg < 14 && f.bot.entity.position.x < 18; leg++) {
    const result = await explorer.advance(f.job, { purpose: 'wood', item: 'log' })
    assert.equal(result.moved, true, JSON.stringify(result))
  }
  assert.ok(f.bot.entity.position.x >= 18, `actual ${f.bot.entity.position}`)
  assert.ok(f.bot.entity.position.y >= 81, `actual ${f.bot.entity.position}`)
  assert.ok(f.moves.some(p => p.y >= 80))
})

test('a partial native search advances its checked prefix instead of rejecting the entire distant goal', async () => {
  const f = terrain({ height: p => 112 - Math.max(0, p.x), start: new Vec3(0.5, 112, 0.5) })
  for (let y = 84; y < 90; y++) f.put('oak_log', new Vec3(28, y, 0))
  const original = f.bot.pathfinder.getPathFromTo
  let partial = 0
  f.bot.pathfinder.getPathFromTo = function* (...args) {
    const generator = original(...args), value = generator.next().value
    generator.return()
    if (value?.result.path.length > 4) { value.result.path = value.result.path.slice(0, 4); value.result.status = 'partial'; partial++ }
    yield value
  }
  const result = await new TerrainExplorer(f.skills).advance(f.job, { purpose: 'wood' })
  assert.equal(result.moved, true, JSON.stringify(result))
  assert.ok(partial > 0)
  assert.ok(f.bot.entity.position.distanceTo(new Vec3(0.5, 112, 0.5)) >= 1)
  assert.ok(Math.hypot(result.segment.x, result.segment.z) <= 10)
})

test('wood observations override the initial direction and find a forest on the opposite slope', async () => {
  const f = terrain({ bounds: p => p.x >= -48 && p.x <= 16 && Math.abs(p.z) <= 16,
    height: p => 120 - Math.max(0, -p.x), start: new Vec3(0.5, 120, 0.5), nativeBody: true })
  for (let y = 90; y <= 95; y++) f.put('acacia_log', new Vec3(-30, y, 0))
  const explorer = new TerrainExplorer(f.skills)
  for (let leg = 0; leg < 12 && f.bot.entity.position.x > -24; leg++) {
    const result = await explorer.advance(f.job, { purpose: 'wood', item: 'log' })
    assert.equal(result.moved, true, JSON.stringify(result))
  }
  assert.ok(f.bot.entity.position.x <= -24, `actual ${f.bot.entity.position}`)
  assert.ok(f.bot.entity.position.y <= 97)
})

test('the same non-destructive policy previews and physically walks around water without mutating cached movements', async () => {
  const f = terrain({ nativeBody: true, modify: p => p.x >= 3 && p.x <= 8 && Math.abs(p.z) <= 2 && p.y === 63 ? 'water' : undefined })
  for (let y = 64; y <= 68; y++) f.put('oak_log', new Vec3(22, y, 0))
  const originalStepCount = f.movement.exclusionAreasStep.length
  const originalAvoids = [...f.movement.blocksToAvoid]
  const explorer = new TerrainExplorer(f.skills)
  for (let leg = 0; leg < 8 && f.bot.entity.position.x < 17; leg++) {
    const result = await explorer.advance(f.job, { purpose: 'wood' })
    assert.equal(result.moved, true, JSON.stringify(result))
  }
  assert.ok(f.bot.entity.position.x >= 17, `actual ${f.bot.entity.position}`)
  assert.equal(f.waterTicks(), 0)
  assert.equal(f.movement.exclusionAreasStep.length, originalStepCount)
  assert.deepEqual([...f.movement.blocksToAvoid], originalAvoids)
  assert.equal(f.movement.canDig, false)
  assert.notEqual(f.bot.pathfinder.movements, f.movement)
})

test('unknown chunk boundaries are approached from a known short frontier without traversing unloaded air', async () => {
  const f = terrain({ bounds: p => p.x >= -2 && p.x <= 9 && p.z >= -6 && p.z <= 6 })
  const explorer = new TerrainExplorer(f.skills)
  const result = await explorer.advance(f.job, { purpose: 'resource', targets: [new Vec3(32, 64, 0)] })
  assert.equal(result.moved, true, JSON.stringify(result))
  assert.ok(f.bot.entity.position.x > 3)
  assert.ok(f.bot.entity.position.x <= 9.6)
  assert.ok(f.moves.every(p => p.x <= 9 && p.x >= -2 && p.z >= -6 && p.z <= 6))
})

test('bounded direction memory prevents repeatedly moving toward one already visited point', async () => {
  const f = terrain(), explorer = new TerrainExplorer(f.skills)
  const positions = []
  for (let i = 0; i < 4; i++) {
    const result = await explorer.advance(f.job, { purpose: 'resource' })
    assert.equal(result.moved, true, JSON.stringify(result))
    positions.push(`${result.segment.x},${result.segment.y},${result.segment.z}`)
  }
  assert.equal(new Set(positions).size, positions.length)
  assert.ok(f.job.progress.terrain.visitedAreas >= 4)
})

test('an exposed isolated ledge cannot produce a fabricated arrival or a blind drop onto distant ground', async () => {
  const f = terrain({ height: p => p.x === 0 && p.z === 0 ? 90 : 42, start: new Vec3(0.5, 90, 0.5) })
  const explorer = new TerrainExplorer(f.skills)
  const result = await explorer.advance(f.job, { purpose: 'cave', preferLower: true })
  assert.equal(result.outcome, 'blocked')
  assert.equal(result.moved, false)
  assert.equal(f.moves.length, 0)
  assert.ok(f.bot.entity.position.y === 90)
  assert.ok(result.attempts <= explorer.limits.maxPathChecks)
})

test('lava and an unloaded sky do not become candidate floors', async () => {
  for (const name of ['lava', 'air', 'powder_snow', 'magma_block']) {
    const f = terrain({ modify: p => p.x === 0 && p.z === 0 && p.y <= 63 ? 'stone' : p.y <= 63 ? name : 'air' })
    const result = await new TerrainExplorer(f.skills).advance(f.job, { purpose: 'resource' })
    assert.equal(result.moved, false, name)
    assert.equal(f.moves.length, 0, name)
  }
})

test('user cancellation prevents both the next scan and every movement', async () => {
  const f = terrain(), explorer = new TerrainExplorer(f.skills)
  f.controller.abort(new Error('玩家停止探索'))
  await assert.rejects(explorer.advance(f.job, { purpose: 'wood' }), /玩家停止探索/)
  assert.equal(f.queries(), 0)
  assert.equal(f.moves.length, 0)
})

test('cancellation during planning is observed before acquiring another body action', async () => {
  const f = terrain(), explorer = new TerrainExplorer(f.skills)
  const original = f.bot.blockAt
  f.bot.blockAt = p => {
    const block = original(p)
    if (f.queries() > 40) f.controller.abort(new Error('取消正在进行的扫描'))
    return block
  }
  await assert.rejects(explorer.advance(f.job, { purpose: 'wood' }), /取消正在进行的扫描/)
  assert.equal(f.moves.length, 0)
})

test('expired task deadline cannot start a movement', async () => {
  const f = terrain()
  f.job.deadline = Date.now() - 1
  await assert.rejects(new TerrainExplorer(f.skills).advance(f.job), /预算耗尽/)
  assert.equal(f.moves.length, 0)
})

test('host CPU, candidate, and path-search budgets are explicit and respected', async () => {
  const f = terrain({ modify: p => p.y === 65 ? 'stone' : undefined })
  const explorer = new TerrainExplorer(f.skills, { maxQueries: 256, maxCandidates: 8, maxPathChecks: 2, planningBudgetMs: 30 })
  const result = await explorer.advance(f.job, { purpose: 'resource' })
  assert.ok(result.metrics.queries <= 256, JSON.stringify(result.metrics))
  assert.ok(result.metrics.candidates <= 8, JSON.stringify(result.metrics))
  assert.ok(result.metrics.pathChecks <= 2, JSON.stringify(result.metrics))
  assert.ok(result.metrics.planningMs < 150, JSON.stringify(result.metrics))
})

test('walking search rejects an accidentally destructive movement policy without changing it', async () => {
  const f = terrain()
  f.movement.canDig = true
  const result = await new TerrainExplorer(f.skills).advance(f.job)
  assert.equal(result.moved, false)
  assert.equal(f.moves.length, 0)
  assert.equal(f.movement.canDig, true)
})

test('an optimistic navigation reply without position changes is blocked and cooled down', async () => {
  const f = terrain(), explorer = new TerrainExplorer(f.skills, { maxPathChecks: 2 })
  f.skills.navigate = async args => { f.moves.push(args); return { ok: true } }
  const result = await explorer.advance(f.job)
  assert.equal(result.moved, false)
  assert.equal(result.outcome, 'blocked')
  assert.equal(f.bot.entity.position.x, 0.5)
  assert.ok(explorer.failures.size > 0)
})

test('embedders with body wrappers but no native preview API retain their supplied navigation compatibility', async () => {
  const f = terrain()
  f.bot.pathfinder.getPathFromTo = undefined
  f.bot.pathfinder.getPathTo = undefined
  f.skills.run = async () => { throw new Error('Must use the supplied compatibility navigator') }
  f.skills.guarded = promise => promise
  f.skills.navigate = async args => {
    f.moves.push(args)
    f.bot.entity.position = new Vec3(args.x + 0.5, args.y, args.z + 0.5)
    return { ok: true }
  }
  const result = await new TerrainExplorer(f.skills).advance(f.job)
  assert.equal(result.moved, true)
  assert.equal(f.moves.length, 1)
})

test('temporary failed endpoints are not retried unchanged during their cooldown', async () => {
  const f = terrain(), explorer = new TerrainExplorer(f.skills, { maxPathChecks: 2 })
  f.skills.navigate = async args => { f.moves.push(args); return { ok: false, reason: '受保护墙体阻挡' } }
  await explorer.advance(f.job)
  const first = new Set(f.moves.map(p => `${p.x},${p.y},${p.z}`))
  f.moves.length = 0
  await explorer.advance(f.job)
  assert.ok(f.moves.every(p => !first.has(`${p.x},${p.y},${p.z}`)))
})

test('explicit continuation retries removed server obstacles while preserving successful route history', async () => {
  let center = new Vec3(0, 64, 0), closed = false
  const f = terrain({ nativeBody: true,
    bounds: p => Math.abs(p.x - center.x) <= 5 && Math.abs(p.z - center.z) <= 5,
    modify: p => closed && p.y >= 64 && p.y <= 66 && Math.max(Math.abs(p.x - center.x), Math.abs(p.z - center.z)) === 1 ? 'stone' : undefined })
  const explorer = new TerrainExplorer(f.skills, { maxCandidates: 16, maxPathChecks: 16 })
  const completedLeg = await explorer.advance(f.job)
  assert.equal(completedLeg.moved, true)
  center = f.bot.entity.position.floored()
  closed = true
  const blocked = await explorer.advance(f.job)
  assert.equal(blocked.moved, false)
  assert.ok(explorer.failures.size > 0)
  const failedPoints = new Set(explorer.failures.keys())
  closed = false // Authoritative world has changed, but automatic cooldown remains.
  const waiting = await explorer.advance(f.job)
  assert.equal(waiting.moved, false)
  const state = explorer.state(f.job, {}), legs = state.legs
  const visits = [...state.visited], coverage = [...explorer.coverage]
  const otherJob = { controller: new AbortController() }
  explorer.failures.set('999,64,999', { job: otherJob, until: Date.now() + 30000, reason: '其他任务的障碍' })
  const reset = explorer.resetFailures(f.job)
  assert.ok(reset.cleared >= failedPoints.size)
  assert.equal(explorer.failures.has('999,64,999'), true)
  assert.equal(state.legs, legs)
  assert.deepEqual([...state.visited], visits)
  assert.deepEqual([...explorer.coverage], coverage)
  const continued = await explorer.advance(f.job)
  assert.equal(continued.moved, true, JSON.stringify(continued))
  assert.ok(failedPoints.has(`${continued.segment.x},${continued.segment.y},${continued.segment.z}`), 'the old failed landing must be reconsidered')
  assert.equal(state.legs, legs + 1)
})

test('a new dimension clears obsolete terrain coverage and failed coordinates', async () => {
  const f = terrain(), explorer = new TerrainExplorer(f.skills)
  await explorer.advance(f.job)
  explorer.failures.set('1,64,0', { until: Date.now() + 10000 })
  f.bot.game.dimension = 'the_nether'
  explorer.state(f.job, { purpose: 'resource' })
  assert.equal(explorer.failures.size, 0)
  assert.equal(explorer.coverage.size, 0)
})
