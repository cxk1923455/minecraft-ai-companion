import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McBot } from '../src/core.mjs'
import { ChatBridge, speechChunks } from '../src/chat-bridge.mjs'
import { PlayerMovements, PlayerFollowGoal, setDoorState, blockIsOpen } from '../src/player-navigation.mjs'
import { sameItem, openBlockWindow } from '../src/gameplay-utils.mjs'
import { equipmentPlan } from '../src/player-actions.mjs'
import { isMatureCrop } from '../src/farming.mjs'

const require = createRequire(import.meta.url), mfRequire = createRequire(require.resolve('mineflayer'))
const registry = mfRequire('prismarine-registry')('1.21.11')
const Block = mfRequire('prismarine-block')(registry), { Vec3 } = mfRequire('vec3')
const scratch = mkdtempSync(join(tmpdir(), 'whale-player-tests-'))
after(() => rmSync(scratch, { recursive: true, force: true }))
const tick = () => new Promise(r => setImmediate(r)), wait = ms => new Promise(r => setTimeout(r, ms))
const cloneItem = item => item ? { ...item } : null
function block(name, position, properties) {
  const type = registry.blocksByName[name]
  let result = properties ? Block.fromProperties(type.id, properties, 0) : Block.fromStateId(type.minStateId, 0)
  result.position = position
  return result
}
function item(name, count, slot, extra = {}) { return { name, count, slot, type: registry.itemsByName[name].id, metadata: 0, stackSize: registry.itemsByName[name].stackSize, ...extra } }
function fixture() {
  const raw = new EventEmitter(), world = new Map()
  Object.assign(raw, { username: 'PlayerAI', version: '1.21.11', registry, world: null,
    entity: { id: 1, position: new Vec3(0.5, 64, 0.5), height: 1.8, width: 0.6 }, game: { dimension: 'overworld', gameMode: 'survival' },
    health: 20, food: 20, players: {}, entities: {}, controlState: {}, calls: [],
    _client: new EventEmitter(), stock: Array(46).fill(null), box: Array(27).fill(null),
    inventory: { slots: null, inventoryStart: 9, inventoryEnd: 45, items: () => raw.stock.slice(9, 45).filter(Boolean), emptySlotCount: () => raw.stock.slice(9, 45).filter(i => !i).length },
    pathfinder: { goal: null, movements: {}, tickTimeout: 5, setGoal(goal) { this.goal = goal; raw.emit('goal_updated', goal) }, setMovements(m) { this.movements = m }, isMining: () => false, isBuilding: () => false },
    tool: {}, collectBlock: { movements: {}, targets: { clear() {} } }, loadPlugin: fn => fn(raw),
    blockAt: p => world.get(p.floored().toString()) ?? block(p.y < 64 ? 'stone' : 'air', p.floored()),
    findBlocks: () => [], clearControlStates() { this.controlState = {} }, stopDigging() {}, deactivateItem() {},
    chat(text) { this.calls.push(['chat', text]) }, lookAt: async () => {},
    equip: async (chosen, destination) => { const slot = { head: 5, torso: 6, legs: 7, feet: 8, 'off-hand': 45, hand: 36 }[destination]; raw.stock[chosen.slot] = raw.stock[slot]; raw.stock[slot] = chosen; chosen.slot = slot; if (slot === 36) raw.heldItem = chosen },
    activateBlock: async chosen => {
      raw.calls.push(['activate', chosen.position.toString()])
      if (/door|gate/.test(chosen.name)) {
        const properties = chosen.getProperties()
        const updated = block(chosen.name, chosen.position, { ...properties, open: !properties.open })
        world.set(chosen.position.toString(), updated); raw.emit('blockUpdate', chosen, updated); return
      }
      const slots = [...raw.box.map(cloneItem), ...raw.stock.slice(9, 45).map(cloneItem)].map((it, slot) => it ? { ...it, slot } : null)
      const window = new EventEmitter()
      Object.assign(window, { id: 1, type: 'minecraft:generic_9x3', inventoryStart: 27, inventoryEnd: 63, slots })
      raw.currentWindow = window
      queueMicrotask(() => raw.emit('windowOpen', window))
    },
    closeWindow: async window => { if (raw.currentWindow === window) { raw.stock.splice(9, 36, ...window.slots.slice(window.inventoryStart, window.inventoryEnd).map((it, i) => it ? { ...it, slot: i + 9 } : null)); raw.currentWindow = null } },
    transfer: async opts => {
      const w = opts.window, source = w.slots[opts.sourceStart], target = w.slots[opts.destStart]
      assert.ok(source && source.count >= opts.count)
      assert.ok(!target || sameItem(source, target))
      w.slots[opts.destStart] = { ...source, count: opts.count + (target?.count ?? 0), slot: opts.destStart }
      source.count -= opts.count; if (!source.count) w.slots[opts.sourceStart] = null
      if (!raw.rejectTransfer) {
        raw.box = w.slots.slice(0, 27).map(cloneItem)
        raw.stock.splice(9, 36, ...w.slots.slice(27, 63).map(cloneItem))
      }
    },
  })
  raw.inventory.slots = raw.stock
  raw._client.write = name => { if (name === 'client_command') queueMicrotask(() => raw._client.emit('statistics', {})) }
  const host = new McBot({ logFile: join(scratch, `${Math.random()}.log`) })
  host.bot = raw; host.skills.attach()
  return { raw, world, host, skills: host.skills }
}
function placeChest(f) { const p = new Vec3(1, 64, 0); f.world.set(p.toString(), block('chest', p)); return { x: 1, y: 64, z: 0 } }

test('container withdrawal confirms both server-reopened storage and player slots', async () => {
  const f = fixture(), coords = placeChest(f)
  f.raw.box[0] = item('diamond', 6, 0)
  const result = await f.skills.container({ ...coords, action: 'withdraw', item: 'diamond', count: 4 })
  assert.equal(result.outcome, 'succeeded'); assert.equal(result.transferred, 4)
  assert.equal(f.raw.box[0].count, 2); assert.equal(f.raw.inventory.items()[0].count, 4)
  assert.equal(f.raw.calls.filter(c => c[0] === 'activate').length, 2)
  assert.equal(f.raw.currentWindow, null)
})
test('container deposit preserves matching partial stacks without requiring an empty slot', async () => {
  const f = fixture(), coords = placeChest(f)
  f.raw.box = f.raw.box.map((_, i) => item(i === 0 ? 'diamond' : 'dirt', i === 0 ? 60 : 64, i))
  f.raw.stock[9] = item('diamond', 4, 9)
  const result = await f.skills.container({ ...coords, action: 'deposit', item: 'diamond', count: 4 })
  assert.equal(result.outcome, 'succeeded'); assert.equal(f.raw.box[0].count, 64)
  assert.equal(f.raw.inventory.items().length, 0)
})
test('full player inventory can still receive a compatible partial stack', async () => {
  const f = fixture(), coords = placeChest(f)
  for (let i = 9; i < 45; i++) f.raw.stock[i] = item(i === 9 ? 'diamond' : 'dirt', i === 9 ? 60 : 64, i)
  f.raw.box[0] = item('diamond', 4, 0)
  const result = await f.skills.container({ ...coords, action: 'withdraw', item: 'diamond', count: 4 })
  assert.equal(result.transferred, 4); assert.equal(result.outcome, 'succeeded')
})
test('take_all uses the initial quantity rather than mutated optimistic item counts', async () => {
  const f = fixture(), coords = placeChest(f)
  f.raw.box[0] = item('diamond', 6, 0); f.raw.box[1] = item('emerald', 8, 1)
  const result = await f.skills.container({ ...coords, action: 'take_all' })
  assert.equal(result.outcome, 'succeeded'); assert.equal(result.transferred, 14)
  assert.deepEqual(result.moved, { diamond: 6, emerald: 8 })
})
test('rejected optimistic transfers are not reported as successful loot', async () => {
  const f = fixture(), coords = placeChest(f)
  f.raw.box[0] = item('diamond', 6, 0); f.raw.rejectTransfer = true
  // A real server's authoritative second window also restores its player inventory.
  const activate = f.raw.activateBlock
  let opens = 0
  f.raw.activateBlock = async (...args) => { if (++opens === 2) f.raw.stock.fill(null); return activate(...args) }
  const result = await f.skills.container({ ...coords, action: 'withdraw', item: 'diamond', count: 4 })
  assert.equal(result.outcome, 'partial'); assert.equal(result.confirmed, false); assert.equal(result.transferred, 0)
})
test('different custom data is never merged and the exact inspected source slot is used', async () => {
  const f = fixture(), coords = placeChest(f)
  const nbt = { value: { bytes: Buffer.from([1, 2, 3]) } }
  f.raw.box[0] = item('diamond', 3, 0, { nbt }); f.raw.box[1] = item('diamond', 3, 1, { nbt: { value: { bytes: Buffer.from([4]) } } })
  f.raw.stock[9] = item('diamond', 60, 9)
  const result = await f.skills.container({ ...coords, action: 'withdraw', slot: 0, count: 3 })
  assert.equal(result.outcome, 'succeeded'); assert.equal(f.raw.stock[9].count, 60)
  assert.deepEqual(f.raw.stock[10].nbt, nbt); assert.equal(f.raw.box[1].count, 3)
})
test('empty take_all is complete; full inventory gives an explicit partial result', async () => {
  const f = fixture(), coords = placeChest(f)
  assert.equal((await f.skills.container({ ...coords, action: 'take_all' })).outcome, 'succeeded')
  for (let i = 9; i < 45; i++) f.raw.stock[i] = item('dirt', 64, i)
  f.raw.box[0] = item('diamond', 1, 0)
  const result = await f.skills.container({ ...coords, action: 'take_all' })
  assert.equal(result.outcome, 'partial'); assert.match(result.reason, /背包已满/)
})
test('opening a protected container can be aborted without an abandoned window listener', async () => {
  const f = fixture(), p = new Vec3(1, 64, 0)
  f.raw.activateBlock = async () => {}
  const control = new AbortController()
  const opening = openBlockWindow(f.raw, block('chest', p), control.signal)
  control.abort()
  await assert.rejects(opening, /中断|aborted/)
  assert.equal(f.raw.listenerCount('windowOpen'), 0)
})
test('a malformed container layout is refused and its window is closed', async () => {
  const f = fixture(), coords = placeChest(f), activate = f.raw.activateBlock
  f.raw.activateBlock = async (...args) => { const p = activate(...args); f.raw.currentWindow.inventoryEnd = 62; await p }
  await assert.rejects(f.skills.container({ ...coords, action: 'withdraw', item: 'diamond' }), /布局/)
  assert.equal(f.raw.currentWindow, null)
})

test('wooden door upper half has clearance and one lower-half interaction, without scaffolding consumption', () => {
  const f = fixture(), p = new Vec3(1, 64, 0)
  f.world.set(p.toString(), block('oak_door', p, { facing: 'east', half: 'lower', hinge: 'left', open: false, powered: false }))
  f.world.set(p.offset(0, 1, 0).toString(), block('oak_door', p.offset(0, 1, 0), { facing: 'east', half: 'upper', hinge: 'left', open: false, powered: false }))
  const moves = new PlayerMovements(f.raw), neighbors = []
  moves.getMoveForward({ x: 0, y: 64, z: 0, remainingBlocks: 0 }, { x: 1, z: 0 }, neighbors)
  assert.equal(neighbors.length, 1); assert.equal(neighbors[0].remainingBlocks, 0)
  assert.equal(neighbors[0].toPlace.filter(p => p.useOne).length, 1)
  assert.equal(moves.getBlock(new Vec3(0, 64, 0), 1, 1, 0).safe, true)
})
test('already open doors are not toggled shut by navigation; iron doors remain blocked', async () => {
  const f = fixture(), p = new Vec3(1, 64, 0)
  const open = block('oak_door', p, { facing: 'east', half: 'lower', hinge: 'left', open: true, powered: false })
  f.world.set(p.toString(), open)
  await f.raw.activateBlock(open)
  assert.equal(f.raw.calls.length, 0)
  const iron = block('iron_door', p, { facing: 'east', half: 'lower', hinge: 'left', open: false, powered: false })
  f.world.set(p.toString(), iron)
  const result = await setDoorState(f.raw, iron, true)
  assert.equal(result.outcome, 'blocked'); assert.equal(f.raw.calls.length, 0)
})
test('manual close and open are idempotent and use observed server block updates', async () => {
  const f = fixture(), p = new Vec3(1, 64, 0)
  f.world.set(p.toString(), block('oak_door', p, { facing: 'east', half: 'lower', hinge: 'left', open: true, powered: false }))
  const result = await f.skills.interact({ action: 'close', x: 1, y: 64, z: 0 })
  assert.equal(result.confirmed, true); assert.equal(blockIsOpen(f.raw.blockAt(p)), false)
  await f.skills.interact({ action: 'close', x: 1, y: 64, z: 0 })
  assert.equal(f.raw.calls.filter(c => c[0] === 'activate').length, 1)
})
test('a server-rejected door fails with a reason and removes its block-update listener', async () => {
  const f = fixture(), p = new Vec3(1, 64, 0), closed = block('oak_door', p, { facing: 'east', half: 'lower', hinge: 'left', open: false, powered: false })
  f.world.set(p.toString(), closed)
  await assert.rejects(setDoorState(f.raw, closed, true, { activate: async () => {}, timeoutMs: 20 }), /服务器确认/)
  assert.equal(f.raw.listenerCount('blockUpdate'), 0)
})
test('a nearby player behind a wall is not verifiedNearby or an acceptable follow endpoint', () => {
  const f = fixture(), target = { position: new Vec3(2.5, 64, 0.5) }
  f.raw.players.Tester = { entity: target }
  f.world.set(new Vec3(1, 65, 0).toString(), block('stone', new Vec3(1, 65, 0)))
  f.skills.setFollow('Tester')
  assert.equal(f.skills.status().follow.verifiedNearby, false)
  assert.equal(new PlayerFollowGoal(f.raw, target, 2).isEnd({ x: 0, y: 64, z: 0 }), false)
  f.skills.updateFollow(Date.now() + 1000)
  assert.notEqual(f.skills.followState.phase, 'nearby')
})
test('navigation assists preserve houses: no digging, bridges, or parkour by default', () => {
  const f = fixture(), m = f.raw.pathfinder.movements
  assert.equal(m.canDig, false); assert.equal(m.allowParkour, false)
  assert.equal(m.exclusionPlace(block('stone', new Vec3(0, 64, 0))), Infinity)
  assert.equal(m.maxDropDown, 3)
})

test('diagonal navigation cannot skip activating a closed door', () => {
  const f = fixture(), p = new Vec3(1, 64, 1)
  f.world.set(p.toString(), block('oak_door', p, { facing: 'east', half: 'lower', hinge: 'left', open: false, powered: false }))
  const neighbors = []
  new PlayerMovements(f.raw).getMoveDiagonal({ x: 0, y: 64, z: 0, remainingBlocks: 0 }, { x: 1, z: 1 }, neighbors)
  assert.equal(neighbors.length, 0)
})
test('doors on a one-block step receive an activation step in the real movement graph', () => {
  const f = fixture(), p = new Vec3(1, 65, 0)
  f.world.set(p.offset(0, -1, 0).toString(), block('stone', p.offset(0, -1, 0)))
  for (const [y, half] of [[0, 'lower'], [1, 'upper']]) f.world.set(p.offset(0, y, 0).toString(), block('oak_door', p.offset(0, y, 0), { facing: 'east', half, hinge: 'left', open: false, powered: false }))
  const next = new PlayerMovements(f.raw).getNeighbors({ x: 0, y: 64, z: 0, remainingBlocks: 0 }).find(n => n.x === 1 && n.y === 65 && n.z === 0)
  assert.ok(next); assert.equal(next.toPlace.filter(p => p.useOne).length, 1)
})
test('a redstone-opened iron door is traversable without a hand interaction', () => {
  const f = fixture(), p = new Vec3(1, 64, 0)
  for (const [y, half] of [[0, 'lower'], [1, 'upper']]) f.world.set(p.offset(0, y, 0).toString(), block('iron_door', p.offset(0, y, 0), { facing: 'east', half, hinge: 'left', open: true, powered: true }))
  const neighbors = []
  new PlayerMovements(f.raw).getMoveForward({ x: 0, y: 64, z: 0, remainingBlocks: 0 }, { x: 1, z: 0 }, neighbors)
  assert.equal(neighbors.length, 1); assert.equal(neighbors[0].toPlace.length, 0)
})

function answer(text, turn = 1, id = `answer-${turn}`, extra = {}) { return { type: 'assistant/message', data: { turn, message: { role: 'assistant', id, content: [{ type: 'text', text }] }, ...extra } } }
const end = (turn = 1, kind = 'completed') => ({ type: 'turn/end', data: { turn, reason: { kind } } })
test('completed final replies reach game chat without an mc_say tool call', () => {
  const f = fixture(), bridge = new ChatBridge(f.host)
  try { bridge.observe(answer('**我来了。**')); assert.equal(f.raw.calls.length, 0); bridge.observe(end()); assert.deepEqual(f.raw.calls, [['chat', '我来了。']]) }
  finally { bridge.destroy() }
})
test('reasoning, tool calls, interrupted messages and failed turns are never broadcast', () => {
  const f = fixture(), bridge = new ChatBridge(f.host)
  try {
    bridge.observe({ type: 'assistant/message', data: { turn: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: 'private' }, { type: 'tool-call', name: 'mc_follow' }, { type: 'text', text: 'not final' }] } } }); bridge.observe(end())
    bridge.observe(answer('unfinished', 2, 'interrupted', { interrupted: true })); bridge.observe(end(2))
    bridge.observe(answer('failed', 3)); bridge.observe(end(3, 'error'))
    assert.equal(f.raw.calls.length, 0)
  } finally { bridge.destroy() }
})
test('explicit mc_say and duplicate final events do not produce duplicate chat', () => {
  const f = fixture(), bridge = new ChatBridge(f.host)
  try { f.host.chatSay('收到！'); bridge.observe(answer('收到！')); bridge.observe(end()); bridge.observe(answer('收到！')); bridge.observe(end()); assert.equal(f.raw.calls.length, 1) }
  finally { bridge.destroy() }
})
test('chat is scoped to the active connection and queued messages are dropped on mode exit', async () => {
  const f = fixture(); let allowed = true
  const bridge = new ChatBridge(f.host, { allowed: () => allowed, intervalMs: 10 })
  try {
    bridge.observe(answer('你好。'.repeat(150))); bridge.observe(end()); assert.ok(bridge.queue.length)
    allowed = false; await wait(30); assert.equal(f.raw.calls.length, 1)
    allowed = true; bridge.observe(answer('别发到重连后的角色', 2)); f.host.emit('offline'); bridge.observe(end(2)); assert.equal(f.raw.calls.length, 1)
  } finally { bridge.destroy() }
})
test('chat chunking preserves emoji and treats slash text as ordinary speech', () => {
  const chunks = speechChunks('😀'.repeat(140))
  assert.equal(chunks.join(''), '😀'.repeat(140))
  for (const c of chunks) assert.ok(c.length <= 210 && !/[\uD800-\uDBFF]$/.test(c))
  assert.match(speechChunks('/tp 玩家 已被禁止')[0], /^说明：/)
})
test('per-session chat bridges never broadcast another body’s final answer', () => {
  const a = fixture(), b = fixture(), ba = new ChatBridge(a.host), bb = new ChatBridge(b.host)
  try { ba.observe(answer('仅 A')); ba.observe(end()); assert.equal(a.raw.calls.length, 1); assert.equal(b.raw.calls.length, 0) }
  finally { ba.destroy(); bb.destroy() }
})

test('expert equipment upgrades armor while preserving elytra, totem and binding curses', async () => {
  const f = fixture()
  f.raw.stock[5] = item('leather_helmet', 1, 5); f.raw.stock[6] = item('elytra', 1, 6); f.raw.stock[45] = item('totem_of_undying', 1, 45)
  f.raw.stock[9] = item('diamond_helmet', 1, 9); f.raw.stock[10] = item('diamond_chestplate', 1, 10); f.raw.stock[11] = item('shield', 1, 11)
  const plan = equipmentPlan(f.raw)
  assert.deepEqual(plan.map(p => p.destination), ['head'])
  const result = await f.skills.equipment({ action: 'best' })
  assert.equal(result.outcome, 'succeeded'); assert.equal(f.raw.stock[5].name, 'diamond_helmet'); assert.equal(f.raw.stock[6].name, 'elytra'); assert.equal(f.raw.stock[45].name, 'totem_of_undying')
})
test('equipment inspection leaves an ongoing follow path in place', async () => {
  const f = fixture(); f.raw.players.Tester = { entity: { position: new Vec3(4, 64, 0) } }
  f.skills.setFollow('Tester'); const goal = f.raw.pathfinder.goal
  await f.skills.equipment({ action: 'inspect' }); assert.equal(f.raw.pathfinder.goal, goal)
})
test('beds outside the overworld are refused before any interaction', async () => {
  const f = fixture(); f.raw.game.dimension = 'minecraft:the_nether'
  const result = await f.skills.player({ action: 'sleep' })
  assert.equal(result.outcome, 'blocked'); assert.equal(f.raw.calls.length, 0)
})

test('timed-out nested operations quarantine the body until their real promise settles', async () => {
  const f = fixture(); let settle
  await assert.rejects(f.skills.run('slow nested call', null, s => f.skills.guarded(new Promise(r => { settle = r }), s, 20)), /超时/)
  assert.equal(f.skills.status().waitingForCancelledAction, true)
  await assert.rejects(f.skills.controls({ forward: true }), /尚未结算/)
  settle(); await tick()
  assert.equal(f.skills.status().waitingForCancelledAction, false)
})
test('movement keys are released on cancellation, with no later control writes', async () => {
  const f = fixture(), controller = new AbortController()
  f.raw.setControlState = (key, on) => { f.raw.controlState[key] = on }
  const action = f.skills.controls({ forward: true, sprint: true, durationMs: 5000 }, controller.signal)
  await tick(); assert.equal(f.raw.controlState.forward, true)
  controller.abort(); await assert.rejects(action, /中断|aborted/)
  assert.deepEqual(f.raw.controlState, {})
  await wait(10); assert.deepEqual(f.raw.controlState, {})
})
test('farming ignores immature crops and does not dig them', async () => {
  const f = fixture(), p = new Vec3(1, 64, 0)
  f.world.set(p.toString(), block('wheat', p, { age: 3 })); f.raw.findBlocks = () => [p]
  f.raw.collectBlock.collect = async () => assert.fail('an immature crop must not be collected')
  const result = await f.skills.farm({ action: 'harvest', crop: 'wheat', count: 1 })
  assert.equal(isMatureCrop(f.raw.blockAt(p)), false)
  assert.equal(result.harvested, 0); assert.equal(result.outcome, 'partial')
})
test('mature crop harvest replants and reports only actually received drops', async () => {
  const f = fixture(), p = new Vec3(1, 64, 0), ground = p.offset(0, -1, 0)
  f.world.set(p.toString(), block('wheat', p, { age: 7 })); f.world.set(ground.toString(), block('farmland', ground))
  f.raw.findBlocks = () => [p]; f.raw.stock[9] = item('wheat_seeds', 3, 9)
  f.raw.collectBlock.collect = async () => { f.world.delete(p.toString()); f.raw.stock[10] = item('wheat', 1, 10) }
  f.raw.placeBlock = async () => { f.world.set(p.toString(), block('wheat', p, { age: 0 })); f.raw.heldItem.count-- }
  const result = await f.skills.farm({ action: 'harvest', crop: 'wheat', count: 1 })
  assert.equal(result.outcome, 'succeeded'); assert.equal(result.replanted, 1); assert.deepEqual(result.gained, { wheat: 1 })
  assert.equal(Number(f.raw.blockAt(p).getProperties().age), 0)
})
test('planting refuses an occupied crop cell without consuming a seed', async () => {
  const f = fixture(), ground = new Vec3(1, 63, 0)
  f.world.set(ground.toString(), block('farmland', ground)); f.world.set(ground.offset(0, 1, 0).toString(), block('stone', ground.offset(0, 1, 0)))
  f.raw.stock[9] = item('wheat_seeds', 3, 9)
  await assert.rejects(f.skills.farm({ action: 'plant', x: 1, y: 63, z: 0 }), /占用/)
  assert.equal(f.raw.stock[9].count, 3)
})
function nativeWindowFixture(f, start = 3, type = 'minecraft:anvil') {
  const w = new EventEmitter()
  Object.assign(w, { id: 3, type, inventoryStart: start, inventoryEnd: start + 36,
    slots: [...Array(start).fill(null), ...f.raw.stock.slice(9, 45).map((i, n) => i ? { ...i, slot: start + n } : null)],
    close: () => f.raw.closeWindow(w) })
  f.raw.currentWindow = w
  f.raw.putAway = async slot => {
    const destination = w.slots.findIndex((it, i) => i >= start && !it)
    assert.ok(destination >= start)
    w.slots[destination] = { ...w.slots[slot], slot: destination }; w.slots[slot] = null
  }
  return w
}
function enchantingFixture() {
  const f = fixture(), p = new Vec3(1, 64, 0)
  f.world.set(p.toString(), block('enchanting_table', p))
  f.raw.stock[9] = item('diamond_sword', 1, 9); f.raw.stock[10] = item('lapis_lazuli', 8, 10); f.raw.experience = { level: 30 }
  f.raw.openEnchantmentTable = async () => {
    const w = nativeWindowFixture(f, 2, 'minecraft:enchantment')
    w.enchantments = [5, 15, 30].map(level => ({ level, expected: { enchant: 1, level: 1 } }))
    w.putTargetItem = async i => { w.slots[0] = { ...i, slot: 0 }; w.slots[i.slot] = null }
    w.putLapis = async i => { w.slots[1] = { ...i, slot: 1 }; w.slots[i.slot] = null }
    w.enchant = async choice => {
      w.slots[0] = { ...w.slots[0], nbt: { value: { enchant: 'sharpness' } }, enchants: [{ name: 'sharpness', lvl: 1 }] }
      w.slots[1].count -= choice + 1; f.raw.experience.level -= choice + 1
    }
    return w
  }
  return f
}
test('enchantment preview returns the sword and lapis without spending levels', async () => {
  const f = enchantingFixture()
  const result = await f.skills.station({ action: 'enchant_preview', item: 'diamond_sword', x: 1, y: 64, z: 0 })
  assert.equal(result.outcome, 'planned'); assert.equal(result.options.length, 3)
  assert.equal(f.raw.inventory.items().find(i => i.name === 'lapis_lazuli').count, 8)
  assert.equal(f.raw.inventory.items().find(i => i.name === 'diamond_sword').count, 1)
  assert.equal(f.raw.experience.level, 30); assert.equal(f.raw.currentWindow, null)
})
test('enchantment confirms the altered item after returning it and reopening the server window', async () => {
  const f = enchantingFixture()
  const result = await f.skills.station({ action: 'enchant', item: 'diamond_sword', choice: 2, x: 1, y: 64, z: 0 })
  assert.equal(result.outcome, 'succeeded'); assert.equal(result.confirmed, true)
  assert.equal(f.raw.experience.level, 27); assert.equal(f.raw.inventory.items().find(i => i.name === 'lapis_lazuli').count, 5)
  assert.equal(f.raw.currentWindow, null)
})
test('insufficient enchanting XP returns blocked and returns all interface items', async () => {
  const f = enchantingFixture(); f.raw.experience.level = 1
  const result = await f.skills.station({ action: 'enchant', item: 'diamond_sword', choice: 2, x: 1, y: 64, z: 0 })
  assert.equal(result.outcome, 'blocked'); assert.equal(f.raw.inventory.items().length, 2); assert.equal(f.raw.experience.level, 1)
})
test('anvil rename validates cost before spending and confirms a new item variant', async () => {
  const f = fixture(), p = new Vec3(1, 64, 0)
  f.world.set(p.toString(), block('anvil', p)); f.raw.experience = { level: 5 }
  f.raw.stock[9] = item('diamond_sword', 1, 9, { constructor: { anvil: () => ({ xpCost: 1 }) } })
  f.raw.openAnvil = async () => {
    const w = nativeWindowFixture(f)
    w.rename = async (target, name) => { w.slots[target.slot] = { ...target, customName: name, nbt: { value: { display: name } } }; f.raw.experience.level-- }
    return w
  }
  const result = await f.skills.station({ action: 'anvil_rename', item: 'diamond_sword', name: 'Companion', x: 1, y: 64, z: 0 })
  assert.equal(result.confirmed, true); assert.equal(f.raw.experience.level, 4); assert.equal(result.items[0].customName, 'Companion')
})
function tradingFixture() {
  const f = fixture(), villager = { id: 42, name: 'villager', position: new Vec3(1.5, 64, 0.5) }
  f.raw.entities[42] = villager; f.raw.stock[9] = item('emerald', 5, 9); f.raw.offerUses = 0
  f.raw.openVillager = async () => {
    const w = nativeWindowFixture(f, 3, 'minecraft:merchant')
    w.trades = [{ inputItem1: item('emerald', 1, 0), outputItem: item('bread', 3, 2), realPrice: 1, maximumNbTradeUses: 12, nbTradeUses: f.raw.offerUses, tradeDisabled: false }]
    return w
  }
  f.raw.trade = async (w, index, n) => {
    const input = w.slots.find(i => i?.name === 'emerald'); input.count -= n
    const slot = w.slots.findIndex((i, slot) => slot >= w.inventoryStart && !i)
    w.slots[slot] = item('bread', 3 * n, slot); f.raw.offerUses += n
  }
  return f
}
test('villager offers expose live prices and a paid trade confirms the reopened inventory', async () => {
  const f = tradingFixture()
  const preview = await f.skills.trade({ action: 'inspect', entityId: 42 })
  assert.equal(preview.offers[0].cost[0].count, 1)
  const result = await f.skills.trade({ action: 'buy', entityId: 42, index: 0, count: 2 })
  assert.equal(result.outcome, 'succeeded'); assert.equal(result.received, 6); assert.equal(f.raw.inventory.items().find(i => i.name === 'emerald').count, 3)
  assert.equal(f.raw.currentWindow, null)
})
test('trading refuses sold-out offers or inadequate payment without changing inventory', async () => {
  const f = tradingFixture()
  const result = await f.skills.trade({ action: 'buy', index: 0, count: 6 })
  assert.equal(result.outcome, 'blocked'); assert.equal(f.raw.stock[9].count, 5)
  f.raw.offerUses = 12
  assert.equal((await f.skills.trade({ action: 'buy', index: 0 })).outcome, 'blocked')
})
