import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pathfinderPkg from 'mineflayer-pathfinder'
import collectPkg from 'mineflayer-collectblock'
import { collectTarget } from '../src/target-collection.mjs'
import { attachPathfinderBudget } from '../src/pathfinder-budget.mjs'
import { patchedGoto, runAbortableOperation } from '../src/hiyori-skills.mjs'
import { PlayerMovements } from '../src/player-navigation.mjs'
import { McBot } from '../src/core.mjs'
import { AgentController, gatheredResource } from '../src/agent-controller.mjs'
import { runtimeState } from '../src/runtime-state.mjs'

const require = createRequire(import.meta.url), mfRequire = createRequire(require.resolve('mineflayer'))
const registry = mfRequire('prismarine-registry')('1.21.11')
const Block = mfRequire('prismarine-block')(registry), { Vec3 } = mfRequire('vec3')
const Entity = mfRequire('prismarine-entity')('1.21.11')
const { Physics } = mfRequire('prismarine-physics')
const { pathfinder, goals } = pathfinderPkg
const tick = () => new Promise(resolve => setImmediate(resolve))
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const logs = mkdtempSync(join(tmpdir(), 'whale-recovery-'))

function body({ nativePath = false, pickup = false, physicsTicks = false } = {}) {
  const bot = new EventEmitter(), blocks = new Map(), events = [], timers = []
  const p = new Vec3(2, 64, 0)
  const drop = Object.assign(new Entity(12), { isValid: true, position: p.offset(0.5, 0, 0.5) })
  blocks.set(p.toString(), 'coal_ore')
  bot.registry = registry; bot.version = '1.21.11'; bot.username = 'RecoveryAI'
  bot.game = { dimension: 'overworld', gameMode: 'survival' }
  bot.entity = { position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0), effects: {}, onGround: true,
    attributes: {}, height: 1.8, width: 0.6, yaw: 0, pitch: 0 }
  bot.health = 20; bot.food = 20; bot.players = {}; bot.entities = { [drop.id]: drop }
  bot.controlState = {}
  bot.heldItem = { name: 'iron_pickaxe', type: registry.itemsByName.iron_pickaxe.id, count: 1 }
  bot.stock = []
  bot.inventory = { items: () => [bot.heldItem, ...bot.stock], emptySlotCount: () => 10, slots: Array(46).fill(null) }
  bot.blockAt = position => {
    const at = position.floored()
    if (Math.abs(at.x) > 128 || Math.abs(at.z) > 128 || at.y < 63 || at.y > 70) return null
    const name = blocks.get(at.toString()) ?? (at.y === 63 ? 'stone' : 'air')
    const b = Block.fromStateId(registry.blocksByName[name].minStateId, 0); b.position = at
    return b
  }
  bot.world = { raycast: () => ({ position: p }) }
  bot.findBlocks = () => []; bot.findBlock = () => null
  bot.clearControlStates = () => { bot.controlState = {} }
  bot.setControlState = (key, value) => { bot.controlState[key] = value }
  bot.look = () => {}; bot.lookAt = async () => {}
  bot.equip = async () => {}; bot.stopDigging = () => {}; bot.deactivateItem = () => {}
  bot.tool = { equipForBlock: async () => { events.push('equip') } }
  bot.physics = Physics(registry, { getBlock: position => bot.blockAt(position) })
  if (nativePath) pathfinder(bot)
  else bot.pathfinder = {
    goal: null, setMovements(m) { this.movements = m },
    setGoal(goal) {
      this.goal = goal; bot.emit('goal_updated', goal)
      if (goal) queueMicrotask(() => {
        if (this.goal !== goal) return
        if (goal instanceof goals.GoalNear) bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5)
        bot.emit('goal_reached', goal)
      })
    },
    goto: async goal => { events.push(goal instanceof goals.GoalFollow ? 'legacy-pickup' : 'legacy-approach') },
    stop() { bot.emit('path_stop') }, isMining: () => false, isBuilding: () => false,
  }
  bot.dig = async block => {
    events.push('dig'); blocks.set(block.position.toString(), 'air'); bot.emit('itemDrop', drop)
    if (pickup) bot.stock.push({ name: 'coal', type: registry.itemsByName.coal.id, count: 1 })
    if (physicsTicks) {
      let count = 0
      const timer = setInterval(() => { bot.emit('physicsTick'); if (++count >= 14) clearInterval(timer) }, 1)
      timers.push(timer)
    }
  }
  const walking = new PlayerMovements(bot)
  bot.pathfinder.setMovements(walking)
  bot.collectBlock = new collectPkg.CollectBlock(bot); bot.collectBlock.movements = walking
  const skills = { movements: () => walking, inventoryBarrier: async () => {},
    guarded: (promise, signal) => runAbortableOperation(promise, signal, () => bot.pathfinder.setGoal(null)) }
  return { bot, p, drop, target: bot.blockAt(p), events, skills, walking,
    close() { timers.forEach(clearInterval); bot.emit('entityGone', drop); bot.pathfinder.setGoal(null) } }
}

test('reproduce real CollectBlock waiting forever after a drop remains loaded; the native replacement returns without entityGone', async t => {
  const legacy = body({ physicsTicks: true }); t.after(legacy.close)
  legacy.walking.canDig = true
  let settled = false
  const old = legacy.bot.collectBlock.collect(legacy.target).finally(() => { settled = true })
  void old.catch(() => {})
  for (let i = 0; i < 80 && !legacy.events.includes('legacy-pickup'); i++) await wait(2)
  assert.ok(legacy.events.includes('legacy-pickup'), 'reach the actual dependency pickup wait')
  assert.equal(settled, false)
  legacy.bot.collectBlock.targets.clear(); legacy.bot.pathfinder.setGoal(null)
  await wait(15)
  assert.equal(settled, false, 'the old cancellation cannot settle entityGone')
  legacy.bot.emit('entityGone', legacy.drop); await old

  const f = body(); t.after(f.close)
  const result = await collectTarget(f.skills, f.bot, f.target, new AbortController().signal, 2000)
  assert.equal(result.outcome, 'partial'); assert.equal(result.mined, true)
  assert.equal(f.events.includes('legacy-pickup'), false)
  assert.equal(f.bot.listenerCount('entityGone'), 0)
  assert.equal(f.bot.listenerCount('itemDrop'), 0)
  assert.equal(f.bot.pathfinder.movements, f.walking)
})

test('confirmed native harvest works even when physicsTick is suspended', async t => {
  const f = body({ pickup: true }); t.after(f.close)
  const result = await collectTarget(f.skills, f.bot, f.target, new AbortController().signal, 1500)
  assert.equal(result.outcome, 'succeeded')
  assert.equal(f.bot.stock[0].name, 'coal')
  assert.equal(f.bot.listenerCount('physicsTick'), 0)
})

test('authoritative inventory updates end the pickup grace immediately and remove its subscription', async t => {
  const f = body(); t.after(f.close)
  Object.setPrototypeOf(f.bot.inventory, EventEmitter.prototype); EventEmitter.call(f.bot.inventory)
  const dig = f.bot.dig
  f.bot.dig = async block => {
    await dig(block)
    setTimeout(() => { f.bot.stock.push({ name: 'coal', count: 1 }); f.bot.inventory.emit('updateSlot', 10, null, f.bot.stock[0]) }, 5)
  }
  const result = await collectTarget(f.skills, f.bot, f.target, new AbortController().signal, 250)
  assert.equal(result.outcome, 'succeeded')
  assert.equal(f.bot.inventory.listenerCount('updateSlot'), 0)
})

test('picking up an unrelated item cannot be evidence of collecting the ore drop', async t => {
  const f = body(); t.after(f.close)
  const dig = f.bot.dig
  f.bot.dig = async block => { await dig(block); f.bot.stock.push({ name: 'dirt', count: 2 }) }
  const result = await collectTarget(f.skills, f.bot, f.target, new AbortController().signal, 2000)
  assert.equal(result.outcome, 'partial'); assert.equal(result.collected, false)
})

test('ordinary ore goals count negotiated-version drops while preserving legacy ore items', () => {
  const modern = { registry }, legacy = { registry: { itemsByName: { iron_ore: {}, gold_ore: {}, coal: {}, diamond: {} } } }
  assert.equal(gatheredResource(modern, 'iron_ore'), 'raw_iron')
  assert.equal(gatheredResource(modern, 'deepslate_diamond_ore'), 'diamond')
  assert.equal(gatheredResource(modern, 'deepslate'), 'cobbled_deepslate')
  assert.equal(gatheredResource(legacy, 'iron_ore'), 'iron_ore')
  assert.equal(gatheredResource(legacy, 'gold_ore'), 'gold_ore')
  assert.equal(gatheredResource(legacy, 'coal_ore'), 'coal')
})

test('native harvesting cancellation settles during pickup grace and releases listeners', async t => {
  const f = body(); t.after(f.close)
  const controller = new AbortController()
  const pending = collectTarget(f.skills, f.bot, f.target, controller.signal, 1500)
  for (let i = 0; i < 20 && !f.events.includes('dig'); i++) await wait(1)
  controller.abort()
  await assert.rejects(pending, /abort|中断/i)
  assert.equal(f.bot.listenerCount('itemDrop'), 0)
  assert.equal(f.bot.listenerCount('goal_reached'), 0)
  assert.equal(f.bot.pathfinder.movements, f.walking)
})

test('unreachable native harvest ends immediately and never digs or reports success', async t => {
  const f = body(); t.after(f.close)
  f.bot.pathfinder.setGoal = goal => {
    f.bot.pathfinder.goal = goal; f.bot.emit('goal_updated', goal)
    if (goal) queueMicrotask(() => f.bot.emit('path_update', { status: 'timeout', path: [{ toBreak: [], toPlace: [], cost: 1 }], reason: 'search exhausted' }))
  }
  await assert.rejects(collectTarget(f.skills, f.bot, f.target, new AbortController().signal, 500), /search exhausted/)
  assert.equal(f.events.includes('dig'), false)
  assert.equal(f.bot.pathfinder.goal, null)
})

test('goal_reached for a different operation or an unreal arrival cannot be a successful move', async t => {
  const f = body(); t.after(f.close)
  f.bot.pathfinder.setGoal = goal => { f.bot.pathfinder.goal = goal; f.bot.emit('goal_updated', goal) }
  const goal = new goals.GoalBlock(20, 64, 0), pending = patchedGoto(f.bot, goal)
  f.bot.emit('goal_reached', new goals.GoalBlock(1, 64, 0))
  await tick(); assert.equal(f.bot.listenerCount('goal_reached'), 1)
  f.bot.emit('goal_reached', goal)
  const result = await pending
  assert.equal(result.ok, false); assert.match(result.message, /actual position/)
})

test('native search node budget includes direct AStar continuations and frees retained frontier nodes', () => {
  const f = body({ nativePath: true }), budget = attachPathfinderBudget(f.bot, { generatedNodes: 128, tickMs: 1 })
  try {
    const generator = f.bot.pathfinder.getPathFromTo(f.walking, f.bot.entity.position, new goals.GoalBlock(1000, 64, 0), { optimizePath: false, searchRadius: 100000 })
    let { result, astarContext: context } = generator.next().value
    for (let i = 0; result.status === 'partial' && i < 200; i++) result = context.compute()
    assert.equal(result.budgetExceeded, true)
    assert.equal(result.path.length, 0)
    assert.equal(context.openDataMap.size, 0); assert.equal(context.closedDataSet.size, 0)
    assert.equal(context.openHeap.size(), 0); assert.equal(context.bestNode, null)
    assert.equal(budget.snapshot().limited, 1)
    generator.return()
  } finally { budget.detach(); f.close() }
})

test('abandoned previews and goal changes promptly release real native partial contexts', () => {
  const f = body({ nativePath: true }), budget = attachPathfinderBudget(f.bot, { generatedNodes: 32768, tickMs: 1 })
  try {
    for (const cancel of ['return', 'goal']) {
      const generator = f.bot.pathfinder.getPathFromTo(f.walking, f.bot.entity.position, new goals.GoalBlock(1000, 64, 0), { optimizePath: false })
      const { result, astarContext: context } = generator.next().value
      assert.equal(result.status, 'partial')
      if (cancel === 'return') generator.return()
      else f.bot.pathfinder.setGoal(null)
      assert.equal(context.openDataMap.size, 0); assert.equal(context.closedDataSet.size, 0)
      assert.equal(budget.snapshot().activeSearches, 0)
      generator.return()
    }
  } finally { budget.detach(); f.close() }
})

test('a successful real path survives frontier cleanup and scoped wrappers detach exactly', () => {
  const f = body({ nativePath: true }), original = f.bot.pathfinder.getPathFromTo
  const budget = attachPathfinderBudget(f.bot)
  const generator = f.bot.pathfinder.getPathFromTo(f.walking, f.bot.entity.position, new goals.GoalBlock(3, 64, 0), { optimizePath: false })
  let value = generator.next().value
  for (let i = 0; value.result.status === 'partial' && i < 50; i++) value = generator.next().value
  assert.equal(value.result.status, 'success'); assert.ok(value.result.path.length)
  assert.equal(value.astarContext.openDataMap.size, 0)
  generator.return(); budget.detach()
  assert.equal(f.bot.pathfinder.getPathFromTo, original)
  f.close()
})

test('host heap pressure prevents a new native search without fabricating a completed path', () => {
  const f = body({ nativePath: true }), budget = attachPathfinderBudget(f.bot, { readHeap: () => ({ used: 80, limit: 100 }) })
  const generator = f.bot.pathfinder.getPathFromTo(f.walking, f.bot.entity.position, new goals.GoalBlock(5, 64, 0))
  const value = generator.next().value
  assert.equal(value.result.budgetExceeded, true); assert.equal(value.result.path.length, 0)
  assert.equal(value.astarContext, null)
  assert.equal(budget.snapshot().memoryPressure, true)
  generator.return(); budget.detach(); f.close()
})

test('continue reports recovering while a cancelled native action is still outstanding', () => {
  const job = { state: 'running', kind: 'collect', item: 'coal', id: 'original' }
  const skills = { quarantine: {}, status: () => ({ recovery: { state: 'settling' } }), goals: { job, running: true, view: () => job } }
  const result = new AgentController(skills).act({ action: 'continue' })
  assert.equal(result.outcome, 'recovering'); assert.equal(result.task.id, 'original')
  assert.match(result.note, /没有恢复执行/)
})

test('step state exposes quarantine evidence to the AI instead of only the old goal phase', () => {
  const f = body(), recovery = { state: 'settling', waitingMs: 1200 }
  const host = { bot: f.bot, online: true, skills: { status: () => ({ position: { x: 0, y: 64, z: 0 }, waitingForCancelledAction: true, recovery }) } }
  const state = runtimeState(host)
  assert.equal(state.waitingForCancelledAction, true); assert.deepEqual(state.recovery, recovery)
  f.close()
})

test('a truly uncooperative action triggers bounded body recovery without allowing unsafe overlapping actions', async t => {
  const f = body(), host = new McBot({ logFile: join(logs, 'recovery.log') })
  host.bot = f.bot; host.skills.attach(); t.after(() => { host.skills.detach('test finished'); f.close() })
  let retired = 0, resolve
  host.recoverBody = async (reason, b) => { assert.equal(b, f.bot); assert.match(reason, /5 秒/); retired++ }
  f.bot._client = { ended: false, end() {} }; f.bot.quit = () => {}
  const pending = host.skills.run('stalled native test', null, () => new Promise(done => { resolve = done }))
  await tick(); host.skills.halt(); await assert.rejects(pending)
  await wait(5100)
  assert.equal(retired, 1); assert.equal(host.skills.status().recovery.state, 'reconnecting')
  await assert.rejects(host.skills.run('unsafe overlap', null, async () => {}), /尚未结算/)
  resolve({ outcome: 'cancelled' }); await tick()
  assert.equal(host.skills.status().waitingForCancelledAction, false)
})

test('connection retirement uses graceful quit and respects user shutdown and rate limits', async t => {
  const f = body(), host = new McBot({ logFile: join(logs, 'retire.log') })
  host.bot = f.bot; host.autoReconnect = true
  let quits = 0
  f.bot.quit = () => { quits++; queueMicrotask(() => f.bot.emit('end')) }
  f.bot._client = { ended: false, end() { throw new Error('graceful quit should win') } }
  t.after(f.close)
  assert.equal((await host.recoverBody('test recovery', f.bot)).retired, true)
  assert.equal((await host.recoverBody('test recovery', f.bot)).retired, true)
  await assert.rejects(host.recoverBody('test recovery', f.bot), /两次/)
  host.stopped = true
  await assert.rejects(host.recoverBody('test recovery', f.bot), /自动重连已关闭/)
  assert.equal(quits, 2)
})
