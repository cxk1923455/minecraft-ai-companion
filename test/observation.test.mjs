import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import vec3pkg from 'vec3'
import { WorldObserver } from '../src/observation.mjs'

const Vec3 = vec3pkg.Vec3 ?? vec3pkg
function fixture(options = {}) {
  let now = 1000, clock = 0, reads = 0
  const bot = new EventEmitter(), inventory = new EventEmitter(), changes = new Map()
  let items = []
  Object.assign(inventory, { items: () => items })
  Object.assign(bot, { username: 'Companion', entity: { id: 1, position: new Vec3(0, 64, 0), velocity: new Vec3(0, 0, 0), onGround: true },
    entities: {}, inventory, health: 20, food: 20, oxygenLevel: 20, quickBarSlot: 0, game: { dimension: 'overworld', gameMode: 'survival' }, _client: { ended: false },
    auth: { accessToken: 'SECRET_ACCOUNT_TOKEN' }, chatHistory: ['PRIVATE_CHAT'],
    blockAt: p => {
      reads++
      if (options.onRead) options.onRead(p)
      const key = `${p.x},${p.y},${p.z}`
      if (changes.has(key)) return changes.get(key)
      if (options.unknown || Math.abs(p.x) > (options.loadedRadius ?? 50) || Math.abs(p.z) > (options.loadedRadius ?? 50)) return null
      const floor = options.ground?.(p.x, p.z) ?? 63
      return p.y <= floor ? block('stone', p) : block('air', p)
    } })
  const host = { bot, online: true, skills: { active: null, paused: false, follow: null, goals: { view: () => null } }, config: { password: 'SECRET_PASSWORD' } }
  const observer = new WorldObserver(host, { now: () => now, clock: () => clock, ...options.observer })
  return { bot, host, observer, changes, setItems: values => { items = values }, setNow: value => { now = value }, setClock: value => { clock = value }, reads: () => reads }
}
function block(name, p) {
  return { name, position: p, boundingBox: name === 'air' || /water|lava/.test(name) ? 'empty' : 'block',
    shapes: name === 'air' || /water|lava/.test(name) ? [] : [[0, 0, 0, 1, 1, 1]], harvestTools: name.includes('ore') ? { 257: true } : null }
}

test('observations contain actual loaded facts and omit credentials, NBT and chat', () => {
  const f = fixture()
  f.setItems([{ name: 'diamond', count: 2, slot: 9, nbt: { SECRET_NBT: 'private' } }])
  f.bot.entities[2] = { id: 2, type: 'player', username: 'Capoo', position: new Vec3(2, 64, 0), metadata: { secret: 'PRIVATE_PLAYER_DATA' } }
  f.bot.entities[3] = { id: 3, name: 'creeper', type: 'mob', position: new Vec3(4, 64, 0) }
  f.changes.set('3,64,0', block('oak_log', new Vec3(3, 64, 0)))
  f.changes.set('0,64,3', block('chest', new Vec3(0, 64, 3)))
  const seen = f.observer.observe()
  assert.equal(seen.schemaVersion, 1)
  assert.equal(seen.inventory.counts.diamond, 2)
  assert.equal(seen.players[0].name, 'Capoo')
  assert.equal(seen.threats[0].name, 'creeper')
  assert.equal(seen.landmarks.trees[0].name, 'oak_log')
  assert.equal(seen.landmarks.containers[0].name, 'chest')
  assert.equal(seen.scope.globalMap, false)
  assert.equal(seen.scope.unknownIsAir, false)
  assert.equal(seen.scope.missingLandmarkIsAbsent, false)
  assert.doesNotMatch(JSON.stringify(seen), /SECRET|PRIVATE/)
  assert.ok(seen.scope.blockReads <= 320)
  f.observer.dispose()
})

test('cache copies are immutable to callers and self/inventory changes invalidate without events', () => {
  const f = fixture()
  const first = f.observer.observe(), reads = f.reads()
  first.self.health = 1
  first.inventory.counts.diamond = 99
  const cached = f.observer.observe()
  assert.equal(f.reads(), reads)
  assert.equal(cached.self.health, 20)
  assert.equal(cached.inventory.counts.diamond, undefined)
  assert.equal(first.revision, cached.revision)
  f.bot.entity.position.x = 1
  f.setItems([{ name: 'oak_log', count: 3, slot: 9 }])
  const updated = f.observer.observe({ delta: true, sinceRevision: cached.revision })
  assert.ok(f.reads() > reads)
  assert.ok(updated.revision > cached.revision)
  assert.equal(updated.self.position.x, 1)
  assert.deepEqual(updated.changes.inventory.gained, { oak_log: 3 })
  assert.equal(updated.changes.selfChanged, true)
  f.observer.dispose()
})

test('unchanged expired readings keep revision and a zero delta', () => {
  const f = fixture()
  const first = f.observer.observe()
  f.setNow(2000)
  const second = f.observer.observe({ sinceRevision: first.revision })
  assert.equal(second.revision, first.revision)
  assert.equal(second.observedAt, 2000)
  assert.equal(second.changes.selfChanged, false)
  assert.deepEqual(second.changes.inventory.gained, {})
  assert.equal(second.changes.baselineAvailable, true)
  f.observer.dispose()
})

test('unknown chunks produce no traversable air and no false inventory loss', () => {
  const f = fixture({ unknown: true })
  f.setItems([{ name: 'diamond', count: 1 }])
  const first = f.observer.observe()
  assert.ok(first.terrain.unknownSamples > 0)
  assert.equal(first.terrain.frontiers.length, 0)
  assert.deepEqual(first.terrain.selfSupport, { known: false })
  assert.ok(first.terrain.columns.every(column => column.loaded === false || column.loaded === null))
  f.setItems(Array.from({ length: 129 }, (_, index) => ({ name: `custom_${index}`, count: 1 })))
  const partial = f.observer.observe({ delta: true, sinceRevision: first.revision })
  assert.equal(partial.inventory.complete, false)
  assert.equal(partial.changes.inventory.complete, false)
  assert.deepEqual(partial.changes.inventory.lost, {})
  f.observer.dispose()
})

test('delta confirms changed sampled blocks but forgets unsampled blocks and unloaded players', () => {
  const f = fixture()
  f.changes.set('3,64,0', block('oak_log', new Vec3(3, 64, 0)))
  f.changes.set('0,64,3', block('chest', new Vec3(0, 64, 3)))
  f.bot.entities[2] = { id: 2, type: 'player', username: 'Capoo', position: new Vec3(2, 64, 0) }
  const first = f.observer.observe()
  f.changes.set('3,64,0', block('air', new Vec3(3, 64, 0)))
  f.changes.set('0,64,3', null)
  delete f.bot.entities[2]
  f.bot.emit('blockUpdate')
  const after = f.observer.observe({ sinceRevision: first.revision })
  assert.equal(after.changes.landmarks.trees.removed[0].name, 'oak_log')
  assert.equal(after.changes.landmarks.containers.removed.length, 0)
  assert.equal(after.changes.landmarks.containers.forgotten[0].name, 'chest')
  assert.equal(after.changes.players.removed.length, 0)
  assert.equal(after.changes.players.forgotten[0].name, 'Capoo')
  f.observer.dispose()
})

test('terrain observes slopes at another height and exposes unverified path candidates', () => {
  const f = fixture({ ground: (x, z) => x >= 2 && z === 0 ? 65 : 63 })
  const seen = f.observer.observe({ detail: 'full' })
  const slope = seen.terrain.columns.find(column => column.position.x === 2 && column.position.z === 0)
  assert.equal(slope.position.y, 66)
  assert.equal(slope.heightDelta, 2)
  assert.equal(slope.pathChecked, false)
  assert.equal(slope.reachable, null)
  assert.ok(seen.terrain.frontiers.every(frontier => frontier.pathChecked === false && frontier.loaded === true))
  f.observer.dispose()
})

test('sampling limits entity reads and outputs while retaining nearest examined threats', () => {
  const f = fixture({ observer: { maxBlockReads: 32, maxEntityReads: 128 } })
  for (let index = 2; index < 1002; index++) f.bot.entities[index] = { id: index, name: 'creeper', position: new Vec3(index % 25, 64, 0) }
  const seen = f.observer.observe({ detail: 'full', radius: 48 })
  assert.equal(seen.scope.entityReads, 128)
  assert.equal(seen.scope.entityScanComplete, false)
  assert.equal(seen.scope.entityResultsTruncated, true)
  assert.ok(seen.threats.length <= 16)
  assert.ok(seen.threats.at(-1).distance <= 3)
  assert.ok(f.reads() <= 32)
  assert.ok(seen.terrain.columns.length <= 24)
  f.observer.dispose()
})

test('body/dimension/respawn reset baselines and release old event listeners', () => {
  const f = fixture()
  const first = f.observer.observe(), oldBot = f.bot
  assert.equal(oldBot.listenerCount('blockUpdate'), 1)
  const replacement = fixture().bot
  replacement.username = 'NewBody'
  f.host.bot = replacement
  const second = f.observer.observe({ sinceRevision: first.revision })
  assert.equal(oldBot.listenerCount('blockUpdate'), 0)
  assert.equal(oldBot.inventory.listenerCount('updateSlot'), 0)
  assert.equal(second.self.name, 'NewBody')
  assert.ok(second.connectionEpoch > first.connectionEpoch)
  assert.equal(second.changes.reset, true)
  replacement.game.dimension = 'the_nether'
  const third = f.observer.observe({ sinceRevision: second.revision })
  assert.ok(third.connectionEpoch > second.connectionEpoch)
  assert.equal(third.changes.reset, true)
  replacement.emit('respawn')
  const fourth = f.observer.observe({ sinceRevision: third.revision })
  assert.ok(fourth.connectionEpoch > third.connectionEpoch)
  assert.equal(replacement.listenerCount('blockUpdate'), 1)
  f.observer.dispose()
  assert.equal(replacement.listenerCount('blockUpdate'), 0)
})

test('time budget, explicit cancellation and a mid-read body change stop sampling', () => {
  const f = fixture({ onRead: () => f.setClock(f.reads() * 2), observer: { budgetMs: 4 } })
  const seen = f.observer.observe()
  assert.ok(f.reads() <= 2)
  assert.equal(seen.scope.budgetExhausted, true)
  const controller = new AbortController()
  controller.abort()
  assert.throws(() => f.observer.observe({ signal: controller.signal }), error => error.mcAborted === true)
  f.observer.dispose()
  const interrupted = fixture({ onRead: () => { interrupted.host.bot = null } })
  assert.throws(() => interrupted.observer.observe(), error => error.mcAborted === true)
  interrupted.observer.dispose()
})

test('offline and missing bots return explicit empty observations without stale world data', () => {
  const f = fixture()
  const first = f.observer.observe()
  f.bot._client.ended = true
  const disconnected = f.observer.observe({ sinceRevision: first.revision })
  assert.equal(disconnected.self.online, false)
  assert.equal(disconnected.self.position, null)
  assert.equal(disconnected.self.health, null)
  assert.equal(disconnected.inventory.available, false)
  assert.deepEqual(disconnected.inventory.counts, {})
  assert.equal(disconnected.terrain.frontiers.length, 0)
  f.host.bot = null
  const absent = f.observer.observe()
  assert.equal(absent.self.online, false)
  assert.equal(absent.self.position, null)
  assert.deepEqual(absent.players, [])
  assert.equal(absent.scope.blockReads, 0)
  f.observer.dispose()
})

test('history is bounded and unavailable deltas require a new baseline', () => {
  const f = fixture()
  const first = f.observer.observe()
  for (let i = 0; i < 12; i++) { f.bot.health = 19 - i; f.observer.observe() }
  assert.ok(f.observer.history.size <= 8)
  const seen = f.observer.observe({ sinceRevision: first.revision })
  assert.equal(seen.changes.baselineAvailable, false)
  assert.equal(seen.changes.reset, true)
  f.observer.dispose()
})
