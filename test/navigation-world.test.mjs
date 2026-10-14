import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { PlayerMovements, PlayerFollowGoal, PlayerNearGoal, playerInReach, setDoorState, blockIsOpen } from '../src/player-navigation.mjs'
import { attachDoorwayNavigation, correctDoorwayPath, doorwayRevision, enterRoom, shouldResumeBlockedFollow } from '../src/doorway-navigation.mjs'

const require = createRequire(import.meta.url), mfRequire = createRequire(require.resolve('mineflayer'))
const registry = mfRequire('prismarine-registry')('1.21.11')
const Block = mfRequire('prismarine-block')(registry), { Vec3 } = mfRequire('vec3')
const { Physics, PlayerState } = mfRequire('prismarine-physics')
const { pathfinder } = require('mineflayer-pathfinder')
const flush = () => new Promise(resolve => setImmediate(resolve))
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const controls = () => ({ forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false })

function worldFixture({ open = false, facing = 'east', hinge = 'left', iron = false, rejected = false, assist = true } = {}) {
  const rotate = p => facing === 'north' || facing === 'south' ? new Vec3(p.z, p.y, p.x) : p
  const bot = new EventEmitter(), states = new Map(), door = rotate(new Vec3(2, 64, 0))
  const put = (name, p, properties) => {
    const spec = registry.blocksByName[name]
    const b = properties ? Block.fromProperties(spec.id, properties, 0) : Block.fromStateId(spec.minStateId, 0)
    states.set(p.toString(), b.stateId)
  }
  for (let x = -4; x <= 9; x++) for (let z = -5; z <= 5; z++) put('stone', rotate(new Vec3(x, 63, z)))
  // A room with just one one-block-wide entrance. No route may walk around it.
  for (let x = 2; x <= 7; x++) for (let z = -2; z <= 2; z++) {
    put('stone', rotate(new Vec3(x, 66, z)))
    if (x === 2 || x === 7 || z === -2 || z === 2) {
      put('stone', rotate(new Vec3(x, 64, z))); put('stone', rotate(new Vec3(x, 65, z)))
    }
  }
  const name = iron ? 'iron_door' : 'oak_door'
  for (const [dy, half] of [[0, 'lower'], [1, 'upper']]) put(name, door.offset(0, dy, 0), { facing, hinge, half, open, powered: iron && open })
  Object.assign(bot, {
    username: 'NavigatorAI', registry, version: '1.21.11', inventory: { slots: Array(46).fill(null), items: () => [] },
    game: { minY: -64, dimension: 'overworld' }, controlState: controls(), entities: {}, players: {}, calls: [],
    entity: { position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0), height: 1.8, width: 0.6,
      yaw: -Math.PI / 2, pitch: 0, onGround: true, effects: {}, attributes: {}, isInWater: false, isInLava: false },
    blockAt(p) {
      const position = p.floored(), state = states.get(position.toString())
      const bounds = rotate(position)
      if (bounds.x < -4 || bounds.x > 9 || bounds.z < -5 || bounds.z > 5 || bounds.y < 63 || bounds.y > 68) return null
      const b = Block.fromStateId(state ?? registry.blocksByName.air.minStateId, 0)
      b.position = position
      return b
    },
    setControlState(key, value) { this.controlState[key] = value }, clearControlStates() { this.controlState = controls() },
    look(yaw, pitch) { this.entity.yaw = yaw; this.entity.pitch = pitch }, lookAt: async () => {},
    stopDigging() {}, equip: async () => {},
    activateBlock: async b => {
      bot.calls.push(b.position.toString())
      if (rejected) return
      // Emulate authoritative server updates for both halves, not a local boolean.
      for (const [dy, half] of [[0, 'lower'], [1, 'upper']]) {
        const p = door.offset(0, dy, 0), old = bot.blockAt(p)
        put(name, p, { facing, hinge, half, open: true, powered: iron })
        bot.emit('blockUpdate', old, bot.blockAt(p))
      }
    },
  })
  bot.physics = Physics(registry, { getBlock: p => bot.blockAt(p) })
  pathfinder(bot)
  bot.pathfinder.searchRadius = 24
  bot.pathfinder.thinkTimeout = 500
  bot.pathfinder.tickTimeout = 20
  bot.pathfinder.setMovements(new PlayerMovements(bot))
  bot.on('path_update', result => { bot.lastPath = result })
  const originalActivate = bot.activateBlock
  bot.activateBlock = b => setDoorState(bot, b, true, { activate: originalActivate, timeoutMs: 25 })
  const detach = assist ? attachDoorwayNavigation(bot) : () => {}
  const target = { position: rotate(new Vec3(4.5, 64, 0.5)), height: 1.8 }
  bot.players.Tester = { entity: target }
  async function tick() {
    bot.emit('physicsTick')
    const state = new PlayerState(bot, bot.controlState)
    bot.physics.simulatePlayer(state, { getBlock: p => bot.blockAt(p) }).apply(bot)
    await flush()
  }
  async function drive(until, ticks = 160) {
    for (let i = 0; i < ticks && !until(); i++) { await tick(); if (i % 10 === 0) await wait(1) }
    return until()
  }
  return { bot, door, target, put, tick, drive, detach }
}

test('real upstream path elevates an open door onto its collision panel; correction retains foot-floor level', () => {
  const f = worldFixture({ open: true, assist: false })
  const goal = new PlayerNearGoal(f.bot, f.target.position, 1)
  const result = f.bot.pathfinder.getPathTo(f.bot.pathfinder.movements, goal)
  assert.equal(result.status, 'success')
  const bad = result.path.find(p => Math.floor(p.x) === 2 && Math.floor(p.z) === 0)
  assert.ok(bad); assert.equal(bad.y, 65)
  correctDoorwayPath(f.bot, result)
  const doorNode = result.path.find(p => Math.floor(p.x) === 2 && Math.floor(p.z) === 0)
  assert.deepEqual([doorNode.x, doorNode.y, doorNode.z], [2.5, 64, 0.5])
  assert.ok(f.bot.blockAt(f.door).shapes.length, 'path correction must not erase actual physics collision')
})

for (const [open, hinge, facing] of [[true, 'left', 'east'], [false, 'left', 'east'], [false, 'right', 'east'], [false, 'left', 'west'], [false, 'left', 'north'], [false, 'right', 'south']]) {
  test(`native pathfinder plus prismarine physics enters the room through ${open ? 'open' : 'closed'} ${facing}-facing ${hinge}-hinged door`, async () => {
    const f = worldFixture({ open, hinge, facing }), axis = facing === 'north' || facing === 'south' ? 'z' : 'x'
    try {
      f.bot.pathfinder.setGoal(new PlayerNearGoal(f.bot, f.target.position, 1))
      assert.equal(await f.drive(() => !f.bot.pathfinder.goal), true, JSON.stringify({ position: f.bot.entity.position, control: f.bot.controlState, path: f.bot.lastPath?.path }))
      assert.ok(f.bot.entity.position[axis] >= 3.2, `must be physically inside, actual ${axis}=${f.bot.entity.position[axis]}`)
      assert.ok(Math.abs(f.bot.entity.position.y - 64) < 0.01)
      assert.equal(playerInReach(f.bot, f.target, 1.75), true)
      assert.equal(f.bot.calls.length, open ? 0 : 1)
      assert.equal(blockIsOpen(f.bot.blockAt(f.door)), true)
    } finally { f.detach() }
  })
}

test('dynamic follow enters through an already open door rather than stopping in sight outside', async () => {
  const f = worldFixture({ open: true })
  f.target.position = new Vec3(3.5, 64, 0.5)
  try {
    const goal = new PlayerFollowGoal(f.bot, f.target, 2)
    assert.equal(goal.isEnd(new Vec3(1, 64, 0)), false)
    assert.equal(goal.isEnd(new Vec3(2, 64, 0)), false)
    f.bot.pathfinder.setGoal(goal, true)
    assert.equal(await f.drive(() => playerInReach(f.bot, f.target, 2)), true, JSON.stringify({ position: f.bot.entity.position, control: f.bot.controlState, path: f.bot.lastPath?.path }))
    assert.ok(f.bot.entity.position.x >= 3, `outside door is not nearby: ${f.bot.entity.position}`)
    assert.equal(f.bot.calls.length, 0)
  } finally { f.detach() }
})

test('a wall and a closed iron door cannot be accepted as a nearby endpoint', async () => {
  const f = worldFixture({ iron: true })
  f.target.position = new Vec3(3.5, 64, 0.5)
  try {
    assert.equal(new PlayerNearGoal(f.bot, f.target.position, 2).isEnd(new Vec3(1, 64, 0)), false)
    assert.equal(playerInReach(f.bot, f.target, 4), false)
    const result = f.bot.pathfinder.getPathTo(f.bot.pathfinder.movements, new PlayerNearGoal(f.bot, f.target.position, 1))
    assert.equal(result.status, 'noPath')
    assert.equal(f.bot.calls.length, 0)
  } finally { f.detach() }
})

test('explicit entry reports actual same-side interior coordinates after native movement', async () => {
  const f = worldFixture({ open: true })
  const controller = new AbortController(), signal = controller.signal
  const skills = { host: {}, follow: null, findPlayer: who => f.bot.players[who]?.entity,
    movements: () => f.bot.pathfinder.movements, guarded: promise => promise,
    run: (_, external, operation) => operation(external, f.bot) }
  try {
    let result
    const operation = enterRoom(skills, { who: 'Tester', budgetMs: 5000 }, signal).then(value => { result = value })
    assert.equal(await f.drive(() => Boolean(result)), true, JSON.stringify({ position: f.bot.entity.position, control: f.bot.controlState, path: f.bot.lastPath?.path }))
    await operation
    assert.equal(result.entered, true); assert.equal(result.confirmed, true)
    assert.equal(result.outcome, 'succeeded'); assert.ok(result.position.x >= 3.2)
  } finally { controller.abort(); f.detach() }
})

test('a server-refused wooden doorway never produces an interior success', async () => {
  const f = worldFixture({ rejected: true })
  try {
    const operation = setDoorState(f.bot, f.bot.blockAt(f.door), true, { activate: async () => {}, timeoutMs: 15 })
    await assert.rejects(operation, /服务器确认/)
    assert.equal(blockIsOpen(f.bot.blockAt(f.door)), false)
    assert.equal(playerInReach(f.bot, f.target, 8), false)
    assert.ok(f.bot.entity.position.x < 2)
  } finally { f.detach() }
})

test('a player opening a previously blocked door resumes follow once without target movement', async () => {
  const f = worldFixture()
  const blocked = new Map([[f.door.toString(), Date.now() + 10000]])
  const state = { targetPosition: f.target.position.clone(), blockedDoorwayRevision: doorwayRevision(f.bot) }
  try {
    assert.equal(shouldResumeBlockedFollow(f.bot, state, f.target, blocked), false)
    await f.bot.activateBlock(f.bot.blockAt(f.door))
    assert.equal(shouldResumeBlockedFollow(f.bot, state, f.target, blocked), true)
    assert.equal(blocked.size, 0)
    assert.equal(shouldResumeBlockedFollow(f.bot, state, f.target, blocked), false)
  } finally { f.detach() }
})

test('navigation attach and detach preserve native API and leave no orphan listeners', () => {
  const f = worldFixture({ assist: false })
  const original = f.bot.pathfinder.getPathFromTo, paths = f.bot.listenerCount('path_update'), updates = f.bot.listenerCount('blockUpdate')
  const detach = attachDoorwayNavigation(f.bot)
  assert.equal(attachDoorwayNavigation(f.bot), detach)
  assert.equal(f.bot.listenerCount('path_update'), paths + 1)
  detach(); detach()
  assert.equal(f.bot.listenerCount('path_update'), paths)
  assert.equal(f.bot.listenerCount('blockUpdate'), updates)
  assert.equal(f.bot.pathfinder.getPathFromTo, original)
})

test('manual open door remains physically traversable when automatic opening is disabled', async () => {
  const f = worldFixture({ open: true })
  try {
    f.bot.pathfinder.setMovements(new PlayerMovements(f.bot, { doors: false }))
    f.bot.pathfinder.setGoal(new PlayerNearGoal(f.bot, f.target.position, 1))
    assert.equal(await f.drive(() => !f.bot.pathfinder.goal), true)
    assert.ok(f.bot.entity.position.x >= 3.2)
    assert.equal(f.bot.calls.length, 0)
  } finally { f.detach() }
})

test('world collision shapes are not mutated by movement queries on a cached upper door block', () => {
  const f = worldFixture({ open: true }), oldBlockAt = f.bot.blockAt.bind(f.bot)
  const upper = oldBlockAt(f.door.offset(0, 1, 0)), shapes = structuredClone(upper.shapes)
  f.bot.blockAt = p => p.floored().equals(upper.position) ? upper : oldBlockAt(p)
  try {
    assert.equal(f.bot.pathfinder.movements.getBlock(f.door, 0, 1, 0).shapes.length, 0)
    assert.deepEqual(upper.shapes, shapes)
    assert.ok(shapes.length > 0)
  } finally { f.detach() }
})

test('explicit entry cannot claim success when the sole door is a closed iron door', async () => {
  const f = worldFixture({ iron: true }), controller = new AbortController()
  const skills = { host: {}, follow: null, findPlayer: who => f.bot.players[who]?.entity,
    movements: () => f.bot.pathfinder.movements, guarded: promise => promise,
    run: (_, external, operation) => operation(external, f.bot) }
  try {
    let result
    const operation = enterRoom(skills, { who: 'Tester', budgetMs: 5000 }, controller.signal).then(value => { result = value })
    assert.equal(await f.drive(() => Boolean(result)), true)
    await operation
    assert.equal(result.outcome, 'blocked'); assert.equal(result.entered, false)
    assert.equal(result.confirmed, false); assert.equal(result.attempts, 1)
    assert.ok(result.position.x < 2)
    assert.equal(f.bot.calls.length, 0)
  } finally { controller.abort(); f.detach() }
})

test('explicit room coordinates take priority over an existing follow target', async () => {
  const f = worldFixture({ open: true }), controller = new AbortController()
  const skills = { host: {}, follow: 'Outside', findPlayer: who => who === 'Outside' ? { position: new Vec3(0.5, 64, 0.5) } : null,
    movements: () => f.bot.pathfinder.movements, guarded: promise => promise,
    run: (_, external, operation) => operation(external, f.bot) }
  try {
    let result
    const operation = enterRoom(skills, { x: 4.5, y: 64, z: 0.5, budgetMs: 5000 }, controller.signal).then(value => { result = value })
    assert.equal(await f.drive(() => Boolean(result)), true)
    await operation
    assert.equal(result.outcome, 'succeeded'); assert.equal(result.player, null)
    assert.ok(result.position.x >= 3.2)
  } finally { controller.abort(); f.detach() }
})
