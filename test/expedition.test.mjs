import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import vec3pkg from 'vec3'
import { ResourceExpedition, resourceStrategy } from '../src/resource-expedition.mjs'
import { targetCollectionMovements } from '../src/target-collection.mjs'

const Vec3 = vec3pkg.Vec3 ?? vec3pkg
const id = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
function fixture({ y = -52, stock = { iron_pickaxe: 1, bread: 8 }, reveal = () => false, mutate } = {}) {
  const bot = new EventEmitter(), blocks = new Map(), calls = [], prepared = [], phases = []
  bot.version = '1.21.11'; bot.game = { dimension: 'overworld', minY: -64 }; bot.stock = { ...stock }
  bot.entity = { position: new Vec3(0.5, y, 0.5) }; bot.health = 20; bot.food = 20
  bot.inventory = { items: () => Object.entries(bot.stock).filter(([, n]) => n > 0).map(([name, count]) => ({ name, count, type: bot.registry.itemsByName[name]?.id, metadata: 0 })), emptySlotCount: () => 10 }
  const names = ['diamond_ore', 'deepslate_diamond_ore', 'stone', 'deepslate', 'coal_ore', 'deepslate_coal_ore', 'iron_ore', 'deepslate_iron_ore', 'oak_log', 'iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe', 'bread']
  bot.registry = { blocksByName: Object.fromEntries(names.map((name, index) => [name, { id: index + 1 }])), itemsByName: Object.fromEntries(names.map((name, index) => [name, { id: index + 1, maxDurability: 250 }])), blocksArray: names.map((name, index) => ({ name, id: index + 1 })) }
  bot.blockAt = p => {
    const cell = p.floored(), name = blocks.get(id(cell)) ?? (cell.y <= y - 1 ? 'stone' : 'air')
    return mutate?.(cell, name, bot) ?? { name, type: bot.registry.blocksByName[name]?.id ?? (name === 'air' ? 0 : 200), position: cell, boundingBox: ['air', 'cave_air', 'water', 'lava'].includes(name) ? 'empty' : 'block', canHarvest: () => true }
  }
  bot.findBlocks = ({ matching }) => {
    if (!reveal(bot, calls)) return []
    const p = bot.entity.position.floored().offset(1, 0, 0)
    blocks.set(id(p), 'diamond_ore')
    return matching.includes(bot.registry.blocksByName.diamond_ore.id) ? [p] : []
  }
  bot.pathfinder = { setMovements() {}, isMining: () => false, isBuilding: () => false, setGoal(goal) {
    if (!goal) return
    queueMicrotask(() => { bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5); calls.push(['walk-cell', goal.x, goal.y, goal.z]); bot.emit('goal_reached') })
  } }
  bot.equip = async item => { bot.heldItem = item; calls.push(['equip', item.name]) }
  bot.dig = async block => { calls.push(['dig', block.name, { ...block.position }, { ...bot.entity.position }]); blocks.set(id(block.position), 'air') }
  bot.collectBlock = { collect: async block => { calls.push(['collect', block.name]); bot.stock.diamond = (bot.stock.diamond ?? 0) + 1; blocks.set(id(block.position), 'air') } }
  const controller = new AbortController(), job = { controller, item: 'diamond', radius: 16, progress: {}, phase: 'planning', deadline: Date.now() + 100000 }
  const skills = { bot, host: { online: true }, settings: { healthThreshold: 6 }, movements: () => ({}), guarded: async (promise, signal) => { signal.throwIfAborted(); const value = await promise; signal.throwIfAborted(); return value }, run: async (label, signal, fn) => { signal.throwIfAborted(); return fn(signal, bot) },
    navigate: async args => { calls.push(['explore', args.x, args.y, args.z]); bot.entity.position = new Vec3(args.x + 0.5, args.y, args.z + 0.5); return { ok: true } },
    collect: async args => { calls.push(['near-scan', args.item]); return { collected: 0, outcome: 'partial', reason: '附近没有资源' } },
    inventoryBarrier: async (_bot, signal) => { signal.throwIfAborted(); calls.push(['inventory-proof']) }, eat: async () => { bot.food = 20; return { outcome: 'succeeded' } } }
  const taskGoals = { ready: async current => current.controller.signal.throwIfAborted(), step: async (current, phase, fn) => { current.phase = phase; phases.push(phase); return fn(current.controller.signal) }, ensure: async (current, name, total) => { current.controller.signal.throwIfAborted(); prepared.push(name); bot.stock[name] = total } }
  const expedition = new ResourceExpedition(skills, taskGoals, { maxSteps: 12, maxMined: 40, maxFailures: 8 })
  return { bot, skills, job, controller, blocks, calls, prepared, phases, expedition }
}

test('absent diamonds cause real exploration and safe descent before inventory-confirmed success', async () => {
  const f = fixture({ reveal: bot => bot.entity.position.y <= -54 })
  const result = await f.expedition.obtain(f.job, 'diamond', 1)
  assert.equal(result.outcome, 'succeeded'); assert.equal(result.collected, 1)
  assert.ok(f.calls.some(([type]) => type === 'explore'))
  assert.ok(f.calls.some(([type, , y]) => type === 'walk-cell' && y <= -54))
  assert.ok(f.calls.some(([type]) => type === 'dig'))
  assert.ok(f.calls.some(([type]) => type === 'inventory-proof'))
  assert.equal(f.calls.filter(([type]) => type === 'near-scan').length, 1)
  for (const [type, , p, origin] of f.calls) if (type === 'dig') assert.ok(p.x !== Math.floor(origin.x) || p.z !== Math.floor(origin.z) || p.y >= origin.y, 'never dig directly underneath the player')
  assert.equal(f.job.progress.expedition.targetY, -54)
})

test('missing harvest tier is prepared before searching for diamonds', async () => {
  const f = fixture({ stock: { stone_pickaxe: 1 }, reveal: () => true })
  const result = await f.expedition.obtain(f.job, 'diamond', 1)
  assert.deepEqual(f.prepared, ['iron_pickaxe'])
  assert.equal(result.outcome, 'succeeded')
  assert.ok(f.phases.some(phase => phase.includes('采集')))
})

test('loaded diamond coordinates without server inventory changes cannot count as success', async () => {
  const f = fixture({ y: -54, reveal: () => true })
  f.bot.collectBlock.collect = async block => { f.calls.push(['unconfirmed-collect', block.name]) }
  const result = await f.expedition.obtain(f.job, 'diamond', 1)
  assert.notEqual(result.outcome, 'succeeded'); assert.equal(result.collected, 0)
  assert.ok(result.explored > 0 || result.mined > 0)
})

test('lava obstructing a staircase changes direction rather than entering the hazardous route', async () => {
  const f = fixture()
  f.blocks.set('1,-53,1', 'lava')
  f.expedition.limits.maxSteps = 3
  const result = await f.expedition.obtain(f.job, 'diamond', 1)
  assert.notEqual(result.outcome, 'succeeded')
  assert.ok(f.calls.some(([type]) => type === 'walk-cell'))
  assert.ok(!f.calls.some(([type, , p]) => type === 'dig' && p.x === 1 && p.z === 0 && p.y <= -52))
})

test('no supporting floor in an empty sky world prevents excavation and reports fall protection', async () => {
  const f = fixture({ mutate: p => ({ name: 'air', type: 0, position: p, boundingBox: 'empty' }) })
  const result = await f.expedition.obtain(f.job, 'diamond', 1)
  assert.equal(result.outcome, 'blocked'); assert.equal(result.mined, 0)
  assert.match(result.reason, /落脚|跌落|稳固/)
})

test('crafted building materials protect neighboring natural-looking walls from staircase mining', async () => {
  const f = fixture({ y: -54 })
  f.blocks.set('1,-55,0', 'oak_planks')
  f.expedition.limits.maxSteps = 1
  const result = await f.expedition.obtain(f.job, 'diamond', 1)
  assert.equal(result.mined, 0)
  assert.ok(!f.calls.some(([type]) => type === 'dig'))
})

test('user cancellation after one dig prevents every subsequent dig and movement', async () => {
  const f = fixture()
  f.bot.dig = async block => { f.calls.push(['dig', block.name]); f.blocks.set(id(block.position), 'air'); f.controller.abort('停止采矿') }
  await assert.rejects(f.expedition.obtain(f.job, 'diamond', 1), /停止采矿|abort/i)
  assert.equal(f.calls.filter(([type]) => type === 'dig').length, 1)
  assert.equal(f.calls.filter(([type]) => type === 'walk-cell').length, 0)
})

test('expired global budget stops before scanning or excavating', async () => {
  const f = fixture(); f.job.deadline = Date.now() - 1
  await assert.rejects(f.expedition.obtain(f.job, 'diamond', 1), /预算耗尽/)
  assert.equal(f.calls.length, 0)
})

test('existing inventory in the nether is accepted without crafting a pickaxe or moving', async () => {
  const f = fixture({ stock: { diamond: 1 } }); f.bot.game.dimension = 'the_nether'; f.bot.inventory.emptySlotCount = () => 0
  const result = await f.expedition.obtain(f.job, 'diamond', 1)
  assert.equal(result.outcome, 'succeeded'); assert.equal(result.collected, 0)
  assert.equal(f.prepared.length, 0); assert.deepEqual(f.calls, [['inventory-proof']])
})

test('modern and legacy target heights respect the negotiated world and dimension', () => {
  const f = fixture()
  assert.equal(resourceStrategy(f.bot, 'diamond').targetY, -54)
  f.bot.version = '1.16.5'; delete f.bot.game.minY
  assert.equal(resourceStrategy(f.bot, 'diamond').targetY, 11)
  assert.equal(resourceStrategy(f.bot, 'diamond').minY, 0)
  f.bot.version = '1.21.11'; f.bot.game.minY = -32
  assert.equal(resourceStrategy(f.bot, 'diamond').targetY, -27)
  f.bot.game.dimension = 'the_nether'
  assert.equal(resourceStrategy(f.bot, 'diamond').valid, false)
})

test('starvation and missing food return a concrete resupply reason before digging', async () => {
  const f = fixture({ stock: { iron_pickaxe: 1 } }); f.bot.food = 4
  await assert.rejects(f.expedition.obtain(f.job, 'diamond', 1), /补给.*食物/)
  assert.equal(f.calls.length, 0)
})

test('surface collection exceptions never break the log or sand immediately underneath the player', async () => {
  for (const item of ['oak_log', 'sand']) {
    const f = fixture({ y: 64 })
    const p = f.bot.entity.position.floored().offset(0, -1, 0)
    f.blocks.set(id(p), item)
    const state = f.expedition.state(f.job, item)
    const result = await f.expedition.collectSeen(f.job, state, f.bot.blockAt(p))
    assert.equal(result, false)
    assert.equal(f.calls.filter(([type]) => type === 'collect').length, 0)
    assert.match(state.reason, /脚下/)
  }
})

test('temporarily unreachable ore can be reconsidered only after actual route progress', async () => {
  const f = fixture({ y: -54, reveal: () => true })
  const state = f.expedition.state(f.job, 'diamond'), original = f.bot.entity.position.clone()
  const source = f.expedition.nearby(state, 16)[0]
  state.unreachable.set(id(source.position), { origin: original, mined: 0 })
  assert.equal(f.expedition.nearby(state, 16).length, 0)
  state.mined = 6
  assert.equal(f.expedition.nearby(state, 16).length, 1)
})

test('collection enables harvesting only its target without changing the cached walking policy', () => {
  const f = fixture({ y: -54 }), p = new Vec3(1, -54, 0)
  f.blocks.set(id(p), 'diamond_ore')
  const base = { canDig: false, maxDropDown: 4, exclusionAreasBreak: [], safeToBreak(block) { return this.canDig && this.exclusionAreasBreak.every(exclude => exclude(block) < 100) } }
  const target = f.bot.blockAt(p), movement = targetCollectionMovements(base, f.bot, target)
  assert.equal(movement.safeToBreak(target), true)
  assert.equal(movement.safeToBreak(f.bot.blockAt(p.offset(1, 0, 0))), false)
  assert.equal(base.canDig, false); assert.equal(base.exclusionAreasBreak.length, 0)
  f.bot.entity.position = p.offset(0.5, 1, 0.5)
  assert.equal(movement.safeToBreak(target), false, 'harvest guard checks the current position at the actual dig')
})

test('a resource occupying the last empty slot can still be inventory-confirmed as complete', async () => {
  const f = fixture({ reveal: () => true })
  f.bot.inventory.emptySlotCount = () => f.bot.stock.diamond ? 0 : 1
  const result = await f.expedition.obtain(f.job, 'diamond', 1)
  assert.equal(result.outcome, 'succeeded'); assert.equal(result.collected, 1)
})

test('inventory capacity accepts free space in an existing target stack', async () => {
  const f = fixture({ stock: { diamond: 1, iron_pickaxe: 1 } })
  f.bot.inventory.emptySlotCount = () => 0
  const state = f.expedition.state(f.job, 'diamond'); state.total = 2
  await f.expedition.ready(f.job, state)
})
