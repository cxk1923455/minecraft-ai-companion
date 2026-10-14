import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import pathfinderPkg from 'mineflayer-pathfinder'
import collectPkg from 'mineflayer-collectblock'
import vec3pkg from 'vec3'
import { collectTarget, targetCollectionMovements } from '../src/target-collection.mjs'

const require = createRequire(import.meta.url)
const registry = require('prismarine-registry')('1.20.4')
const Block = require('prismarine-block')(registry)
const Vec3 = vec3pkg.Vec3 ?? vec3pkg
const id = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
function fixture() {
  const bot = new EventEmitter(), blocks = new Map(), calls = [], timers = []
  bot.registry = registry; bot.version = '1.20.4'; bot.entities = {}; bot.world = {}
  bot.entity = { position: new Vec3(0.5, 64, 0.5), effects: {} }; bot.food = 20
  bot.heldItem = { name: 'iron_pickaxe', type: registry.itemsByName.iron_pickaxe.id }
  bot.inventory = { emptySlotCount: () => 1, items: () => [bot.heldItem] }
  bot.blockAt = p => {
    const name = blocks.has(id(p)) ? blocks.get(id(p)) : p.y < 64 ? 'stone' : 'air'
    if (name === null) return null
    const block = Block.fromStateId(registry.blocksByName[name].minStateId, 0)
    block.position = p.floored()
    return block
  }
  const walking = new pathfinderPkg.Movements(bot); walking.canDig = false
  bot.pathfinder = { movements: walking, setMovements(m) { this.movements = m; calls.push(['policy', m]) }, goto: async () => { calls.push(['goto']) }, stop() {} }
  bot.tool = { equipForBlock: async () => { calls.push(['equip']) } }
  bot.dig = async block => {
    calls.push(['dig', block]); blocks.set(id(block.position), 'air')
    let ticks = 0
    const timer = setInterval(() => { bot.emit('physicsTick'); if (++ticks >= 14) clearInterval(timer) }, 1)
    timers.push(timer)
  }
  bot.collectBlock = new collectPkg.CollectBlock(bot)
  bot.collectBlock.movements = walking
  const skills = { movements: () => walking, guarded: async (promise, signal) => { signal.throwIfAborted(); const result = await promise; signal.throwIfAborted(); return result } }
  const signal = new AbortController().signal, p = new Vec3(2, 64, 0)
  blocks.set(id(p), 'diamond_ore')
  return { bot, blocks, walking, calls, skills, signal, target: bot.blockAt(p), close: () => timers.forEach(clearInterval) }
}

test('the real CollectBlock code skips canDig=false, but restricted collection actually digs its real Block', async t => {
  const f = fixture(); t.after(f.close)
  assert.equal(f.target.constructor.name, 'Block')
  await f.bot.collectBlock.collect(f.target, { ignoreNoPath: false })
  assert.equal(f.calls.filter(([type]) => type === 'dig').length, 0)
  f.walking.dontCreateFlow = true; f.walking.dontMineUnderFallingBlock = true
  await collectTarget(f.skills, f.bot, f.target, f.signal)
  assert.equal(f.calls.filter(([type]) => type === 'dig').length, 1)
  assert.equal(f.bot.blockAt(f.target.position).name, 'air')
  assert.equal(f.bot.pathfinder.movements, f.walking)
  assert.equal(f.bot.collectBlock.movements, f.walking)
  assert.equal(f.walking.canDig, false)
  assert.equal(f.walking.dontCreateFlow, true)
})

test('CollectBlock disabling its flow guard cannot cause harvesting next to lava or falling gravel', async t => {
  for (const [hazard, offset] of [['lava', [1, 0, 0]], ['water', [0, 1, 0]], ['gravel', [0, 1, 0]]]) {
    const f = fixture(); t.after(f.close)
    f.blocks.set(id(f.target.position.offset(...offset)), hazard)
    await collectTarget(f.skills, f.bot, f.target, f.signal)
    const harvesting = f.calls.find(([type, policy]) => type === 'policy' && policy !== f.walking)[1]
    assert.equal(harvesting.dontCreateFlow, true)
    assert.equal(harvesting.dontMineUnderFallingBlock, true)
    assert.equal(f.calls.filter(([type]) => type === 'dig').length, 0, `cannot dig adjacent to ${hazard}`)
  }
})

test('unknown neighboring terrain and a target directly underneath the bot are not harvested', async t => {
  for (const hazard of ['unknown', 'underfoot']) {
    const f = fixture(); t.after(f.close)
    if (hazard === 'unknown') f.blocks.set(id(f.target.position.offset(1, 0, 0)), null)
    else f.bot.entity.position = f.target.position.offset(0.5, 1, 0.5)
    await collectTarget(f.skills, f.bot, f.target, f.signal)
    assert.equal(f.calls.filter(([type]) => type === 'dig').length, 0)
  }
})

test('target policy is kept until an uncooperative timed-out collector actually settles', async t => {
  const f = fixture(); t.after(f.close)
  let resolve
  f.bot.collectBlock.collect = async () => new Promise(done => { resolve = done })
  f.skills.guarded = async promise => { void promise.catch(() => {}); await new Promise(done => setImmediate(done)); throw new Error('simulated timeout') }
  await assert.rejects(collectTarget(f.skills, f.bot, f.target, f.signal), /timeout/)
  assert.notEqual(f.bot.collectBlock.movements, f.walking)
  resolve()
  await new Promise(done => setImmediate(done))
  assert.equal(f.bot.collectBlock.movements, f.walking)
})

test('only the chosen position and block type can be mined by the temporary policy', t => {
  const f = fixture(); t.after(f.close)
  const policy = targetCollectionMovements(f.walking, f.bot, f.target)
  assert.equal(policy.safeToBreak(f.target), true)
  const unrelated = f.bot.blockAt(new Vec3(3, 63, 0))
  assert.equal(policy.safeToBreak(unrelated), false)
  f.blocks.set(id(f.target.position), 'stone')
  assert.equal(policy.safeToBreak(f.bot.blockAt(f.target.position)), false)
})
