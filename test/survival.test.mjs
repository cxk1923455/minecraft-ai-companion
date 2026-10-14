import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McBot } from '../src/core.mjs'
import { planCraft, assessExcavationFluidRisk } from '../src/hiyori-skills.mjs'
import { apply as applyExtension } from '../extensions/hiyori-survival.mjs'
import { defineTool } from '../src/tool-def.mjs'

const require = createRequire(import.meta.url)
const mfRequire = createRequire(require.resolve('mineflayer'))
const registry = mfRequire('prismarine-registry')('1.20.4')
const { Vec3 } = mfRequire('vec3')
const logs = mkdtempSync(join(tmpdir(), 'whale-hiyori-tests-'))

function fixture(stock = {}) {
  const raw = new EventEmitter()
  raw.username = 'MinecraftAI'
  raw.version = '1.20.4'
  raw.registry = registry
  raw.entity = { position: new Vec3(0, 64, 0), isInWater: false }
  raw.game = { gameMode: 'survival' }
  raw.health = 20; raw.food = 20; raw.oxygenLevel = 20
  raw.players = {}; raw.calls = []; raw.stock = { ...stock }
  raw.inventory = { items: () => Object.entries(raw.stock).filter(([, count]) => count > 0).map(([name, count]) => ({ name, count, type: registry.itemsByName[name]?.id, metadata: 0 })), emptySlotCount: () => 10 }
  raw.pathfinder = { goal: null, tickTimeout: 40, thinkTimeout: 5000, movements: {},
    setMovements(movements) { this.movements = movements },
    setGoal(goal) { this.goal = goal; raw.emit('goal_updated', goal) },
    isMining: () => false, isBuilding: () => false,
  }
  raw.tool = { equipForBlock: async () => {} }
  raw.collectBlock = { movements: {}, targets: { clear() {} }, collect: async () => {} }
  raw.loadPlugin = fn => fn(raw)
  raw.blockAt = p => ({ name: 'air', type: 0, position: p, boundingBox: 'empty' })
  raw.findBlocks = () => []; raw.findBlock = () => null
  raw.setControlState = (key, value) => raw.calls.push([key, value])
  raw.clearControlStates = () => raw.calls.push(['clear'])
  raw.stopDigging = () => {}; raw.deactivateItem = () => {}
  raw.equip = async item => { raw.heldItem = item }
  raw.consume = async () => { raw.food = 20 }
  raw._client = new EventEmitter(); raw._client.ended = false
  raw._client.write = name => { if (name === 'client_command') queueMicrotask(() => raw._client.emit('statistics', {})) }
  const host = new McBot({ logFile: join(logs, `${Math.random()}.log`) })
  host.bot = raw
  host.skills.attach()
  return { host, raw, skills: host.skills }
}
const tick = () => new Promise(resolve => setImmediate(resolve))

test('each session keeps an independent body and survival settings', () => {
  const a = fixture(), b = fixture()
  a.skills.configure({ autoEat: false })
  assert.equal(a.skills.settings.autoEat, false)
  assert.equal(b.skills.settings.autoEat, true)
  assert.notEqual(a.skills, b.skills)
  assert.equal(a.host.bot, a.raw)
  assert.equal(a.raw.pathfinder.tickTimeout, 5)
})

test('all player and survival extension tools register synchronously with the host schema', () => {
  const registered = new Map(), { host } = fixture()
  applyExtension({ ctx: { tools: { register: tool => registered.set(tool.name, tool) } }, asTool: defineTool, getSession: () => ({ bot: host }) })
  assert.equal(registered.size, 21)
  assert.ok(registered.has('mc_collect'))
  assert.ok(registered.has('mc_halt'))
})

test('follow suspends during a body action and resumes without digging through terrain', async () => {
  const { raw, skills } = fixture()
  raw.players.Player = { entity: { position: new Vec3(3, 64, 0) } }
  skills.setFollow('Player')
  assert.ok(raw.pathfinder.goal)
  await skills.run('test action', null, async () => {
    assert.equal(raw.pathfinder.goal, null)
    raw.pathfinder.movements.canDig = true
    return { outcome: 'succeeded' }
  })
  assert.ok(raw.pathfinder.goal)
  assert.equal(raw.pathfinder.movements.canDig, false)
})

test('concurrent body actions reject; cancellation actually releases the controls', async () => {
  const { raw, skills } = fixture()
  const controller = new AbortController()
  const pending = skills.run('long action', controller.signal, signal => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })))
  await tick()
  await assert.rejects(skills.run('overlap', null, async () => {}), /正在执行/)
  controller.abort()
  await assert.rejects(pending, /abort|中断|cancel/i)
  assert.equal(skills.busy, false)
  assert.ok(raw.calls.some(([key]) => key === 'clear'))
})

test('an uncooperative cancelled operation quarantines the body until it settles', async () => {
  const { skills } = fixture()
  let release
  const pending = skills.run('uncooperative', null, () => new Promise(resolve => { release = resolve }))
  await tick()
  skills.halt()
  await assert.rejects(pending)
  assert.equal(skills.status().waitingForCancelledAction, true)
  await assert.rejects(skills.run('unsafe overlap', null, async () => {}), /尚未结算/)
  release({ outcome: 'cancelled' })
  await tick()
  assert.equal(skills.status().waitingForCancelledAction, false)
})

test('halt keeps the same connection and stops persistent follow', () => {
  const { raw, skills, host } = fixture()
  raw.players.Player = { entity: { position: new Vec3(3, 64, 0) } }
  skills.setFollow('Player')
  const status = skills.halt()
  assert.equal(status.follow, null)
  assert.equal(raw.pathfinder.goal, null)
  assert.equal(host.online, true)
})

test('collection checks inventory gains instead of claiming that a completed call collected items', async () => {
  const { raw, skills } = fixture()
  const pos = new Vec3(2, 64, 0)
  const block = { name: 'oak_log', type: registry.blocksByName.oak_log.id, position: pos }
  raw.findBlocks = () => [pos]
  raw.blockAt = p => p.equals(pos) ? block : { name: 'air', type: 0, position: p, boundingBox: 'empty' }
  const result = await skills.collect({ item: 'oak_log', count: 1 })
  assert.equal(result.outcome, 'partial')
  assert.equal(result.collected, 0)
})

test('collection uses the existing bot and counts confirmed inventory additions', async () => {
  const { raw, skills } = fixture()
  const pos = new Vec3(2, 64, 0)
  let block = { name: 'oak_log', type: registry.blocksByName.oak_log.id, position: pos }
  raw.findBlocks = () => block ? [pos] : []
  raw.blockAt = p => p.equals(pos) && block ? block : { name: 'air', type: 0, position: p, boundingBox: 'empty' }
  raw.collectBlock.collect = async () => { raw.stock.oak_log = 1; block = null }
  const result = await skills.collect({ item: 'oak_log', count: 1 })
  assert.equal(result.outcome, 'succeeded')
  assert.equal(result.collected, 1)
})

test('fluid break guard rejects removing a block underneath water', () => {
  const risk = assessExcavationFluidRisk({ blockAt: p => ({ name: p.y === 65 ? 'water' : 'stone', boundingBox: p.y === 65 ? 'empty' : 'block' }) }, { x: 0, y: 64, z: 0 })
  assert.equal(risk.unsafe, true)
})

test('craft planner uses the negotiated version and reports missing resources', async () => {
  const { raw, skills } = fixture()
  const plan = planCraft(raw, 'wooden_pickaxe', 1)
  assert.equal(plan.recipeAvailable, true)
  assert.equal(plan.canCraftNow, false)
  assert.ok(Object.keys(plan.missing).length)
  const result = await skills.craft({ item: 'wooden_pickaxe' })
  assert.equal(result.outcome, 'blocked')
  assert.equal(raw.pathfinder.goal, null)
})

test('crafting rejects optimistic inventory that the server rolls back', async () => {
  const { raw, skills } = fixture({ oak_planks: 2 })
  const stickId = registry.itemsByName.stick.id, plankId = registry.itemsByName.oak_planks.id
  raw.recipesFor = () => [{ delta: [{ id: plankId, count: -2 }], result: { id: stickId, count: 4 } }]
  raw.craft = async () => { raw.stock.stick = 4 }
  raw._client.write = () => queueMicrotask(() => { raw.stock.stick = 0; raw._client.emit('statistics', {}) })
  await assert.rejects(skills.craft({ item: 'stick', count: 4 }), /背包确认/)
})

test('crafting confirms output and respects the output count per recipe', async () => {
  const { raw, skills } = fixture({ oak_planks: 2 })
  const stickId = registry.itemsByName.stick.id, plankId = registry.itemsByName.oak_planks.id
  raw.recipesFor = () => [{ delta: [{ id: plankId, count: -2 }], result: { id: stickId, count: 4 } }]
  raw.craft = async () => { raw.stock.oak_planks -= 2; raw.stock.stick = 4 }
  const result = await skills.craft({ item: 'stick', count: 4 })
  assert.equal(result.crafted, 4)
  assert.equal(result.outcome, 'succeeded')
})

test('smelting resolves the real recipe input and verifies received output', async () => {
  const { raw, skills } = fixture({ raw_iron: 1, coal: 1 })
  raw.findBlock = () => ({ name: 'furnace', position: new Vec3(1, 64, 0) })
  let ready = false
  const furnace = { inputItem: () => null, fuelItem: () => null,
    outputItem: () => ready ? { name: 'iron_ingot' } : null,
    putFuel: async () => {}, putInput: async () => { ready = true },
    takeOutput: async () => { raw.stock.iron_ingot = 1 }, close() {},
  }
  raw.openFurnace = async () => furnace
  const result = await skills.smelt({ item: 'iron_ingot', count: 1 })
  assert.equal(result.smelted, 1)
})

test('smelting refuses occupied furnaces before transferring any inventory', async () => {
  const { raw, skills } = fixture({ raw_iron: 1, coal: 1 })
  raw.findBlock = () => ({ name: 'furnace', position: new Vec3(1, 64, 0) })
  let transferred = false
  raw.openFurnace = async () => ({ inputItem: () => ({ name: 'sand' }), outputItem: () => null, fuelItem: () => null, putFuel: async () => { transferred = true }, close() {} })
  await assert.rejects(skills.smelt({ item: 'iron_ingot' }), /已有物品/)
  assert.equal(transferred, false)
})

test('automatic eating runs locally from a physics event without LLM calls', async () => {
  const { raw, skills } = fixture({ bread: 1 })
  raw.food = 5
  raw.emit('physicsTick')
  await tick(); await tick()
  assert.equal(raw.food, 20)
  assert.equal(skills.lastResult?.label, '进食')
})

test('low oxygen cancels the old action before surfacing and releases jump afterward', async () => {
  const { raw, skills } = fixture()
  raw.entity.isInWater = true; raw.oxygenLevel = 5
  const pending = skills.run('mining', null, signal => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('interrupted')), { once: true })))
  await tick()
  raw.emit('physicsTick')
  await assert.rejects(pending)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.ok(raw.calls.some(([key, value]) => key === 'jump' && value === true))
  raw.oxygenLevel = 20
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(skills.busy, false)
})

test('disconnect removes physics listeners and stops future automatic actions', () => {
  const { raw, skills } = fixture({ bread: 1 })
  skills.detach('test disconnect')
  raw.food = 5; raw.emit('physicsTick')
  assert.equal(raw.listenerCount('physicsTick'), 0)
  assert.equal(raw.food, 5)
})

test('follow uses distance hysteresis rather than repeatedly restarting near the player', () => {
  const { raw, skills } = fixture()
  const player = { position: new Vec3(1.9, 64, 0) }
  raw.players.Player = { entity: player }
  skills.setFollow('Player')
  skills.updateFollow(Date.now() + 1000)
  assert.equal(raw.pathfinder.goal, null)
  player.position.x = 2.8
  skills.updateFollow(Date.now() + 2000)
  assert.equal(raw.pathfinder.goal, null)
  player.position.x = 4
  skills.updateFollow(Date.now() + 3000)
  assert.ok(raw.pathfinder.goal)
  const goal = raw.pathfinder.goal
  skills.updateFollow(Date.now() + 3200)
  assert.equal(raw.pathfinder.goal, goal)
})

test('follow stops repeated collisions after bounded recovery attempts', () => {
  const { raw, skills } = fixture()
  raw.players.Player = { entity: { position: new Vec3(10, 64, 0) } }
  skills.setFollow('Player')
  for (let attempt = 0; attempt < 3; attempt++) { skills.followState.lastProgressAt = Date.now() - 4000; skills.lastFollowCheck = 0; skills.updateFollow(Date.now()) }
  assert.equal(skills.followState.phase, 'blocked')
  assert.equal(raw.pathfinder.goal, null)
})

test('background crafting returns immediately and completes through local skills', async () => {
  const { raw, skills } = fixture({ oak_planks: 2 })
  raw.recipesFor = () => [{ delta: [{ id: registry.itemsByName.oak_planks.id, count: -2 }], result: { id: registry.itemsByName.stick.id, count: 4 } }]
  raw.craft = async () => { raw.stock.oak_planks -= 2; raw.stock.stick = 4 }
  const state = skills.goals.start({ kind: 'craft', item: 'stick', count: 4 })
  assert.equal(state.state, 'running')
  await skills.goals.job.done
  assert.equal(skills.goals.view().state, 'succeeded')
  assert.equal(skills.goals.view().result.produced, 4)
})

test('background crafting gathers missing materials before executing its recipe', async () => {
  const { raw, skills } = fixture()
  const logId = registry.itemsByName.oak_log.id, plankId = registry.itemsByName.oak_planks.id
  raw.recipesFor = () => [{ delta: [{ id: logId, count: -1 }], result: { id: plankId, count: 4 } }]
  raw.craft = async () => { raw.stock.oak_log -= 1; raw.stock.oak_planks = 4 }
  const collect = skills.collect.bind(skills)
  let gathered = false
  skills.collect = async (args, signal) => { signal.throwIfAborted(); gathered = true; raw.stock[args.item] = (raw.stock[args.item] ?? 0) + args.count; return { outcome: 'succeeded', collected: args.count } }
  skills.goals.start({ kind: 'craft', item: 'oak_planks', count: 4 })
  await skills.goals.job.done
  assert.equal(gathered, true)
  assert.equal(skills.goals.view().state, 'succeeded', JSON.stringify(skills.goals.view()))
  skills.collect = collect
})

test('goal cancellation prevents future queued stages and manual body overlap', async () => {
  const { raw, skills } = fixture()
  const pos = new Vec3(2, 64, 0)
  raw.findBlocks = () => [pos]
  raw.blockAt = p => p.equals(pos) ? { name: 'oak_log', type: registry.blocksByName.oak_log.id, position: pos } : { name: 'air', type: 0, position: p, boundingBox: 'empty' }
  raw.collectBlock.collect = () => new Promise(() => {})
  skills.goals.start({ kind: 'collect', item: 'oak_log', count: 8 })
  await tick()
  await assert.rejects(skills.run('manual overlap', null, async () => {}), /后台目标|正在执行/)
  skills.halt()
  await skills.goals.job.done
  assert.equal(skills.goals.view().state, 'cancelled')
})

test('goal rejects duplicate blueprint positions before any world action', () => {
  const { skills } = fixture({ oak_planks: 2 })
  assert.throws(() => skills.goals.start({ kind: 'build', blocks: [{ x: 1, y: 64, z: 0, name: 'oak_planks' }, { x: 1, y: 64, z: 0, name: 'oak_planks' }] }), /重复/)
})

test('blueprint skips completed cells and verifies the remaining world changes', async () => {
  const { raw, skills, host } = fixture({ oak_planks: 1 })
  raw.entity.position = new Vec3(2, 64, 2) // Both unfinished cells are visible from this building position.
  const world = new Map([['1,64,0', 'oak_planks']])
  raw.blockAt = p => ({ name: world.get(`${p.x},${p.y},${p.z}`) ?? 'air', boundingBox: world.has(`${p.x},${p.y},${p.z}`) ? 'block' : 'empty', position: p })
  let placements = 0
  host.placeBlock = async block => { placements++; world.set(`${block.x},${block.y},${block.z}`, block.name) }
  skills.goals.start({ kind: 'build', blocks: [{ x: 1, y: 64, z: 0, name: 'oak_planks' }, { x: 2, y: 64, z: 0, name: 'oak_planks' }] })
  await skills.goals.job.done
  assert.equal(skills.goals.view().state, 'succeeded')
  assert.equal(placements, 1)
})

test('combat avoids players and stops chasing when health is low', async () => {
  const { raw, skills } = fixture()
  await assert.rejects(skills.combat({ entity: 'player' }), /不攻击玩家/)
  raw.health = 4
  const result = await skills.combat({ budgetMs: 1000 })
  assert.equal(result.outcome, 'partial')
  assert.equal(result.hits, 0)
})

test('combat checks line of sight before attacking', async () => {
  const { raw, skills } = fixture()
  raw.entities = { 2: { id: 2, name: 'zombie', type: 'mob', position: new Vec3(2, 64, 0) } }
  raw.attack = () => assert.fail('must not attack through a wall')
  skills.visible = () => false
  const result = await skills.combat({ budgetMs: 1000 })
  assert.equal(result.hits, 0)
})

test('retreat refuses unknown or unsafe landing terrain', async () => {
  const { raw, skills } = fixture()
  raw.entities = { 2: { id: 2, name: 'zombie', type: 'mob', position: new Vec3(1, 64, 0) } }
  const result = await skills.retreat()
  assert.equal(result.outcome, 'partial')
  assert.match(result.reason, /安全/)
})

test('goal pauses, resumes and completes without duplicating the requested collection', async () => {
  const { raw, skills } = fixture()
  let attempt = 0
  skills.collect = async (args, signal) => skills.run('goal collection', signal, s => {
    attempt++
    if (attempt === 1) {
      raw.stock.oak_log = 3
      return new Promise((_, reject) => s.addEventListener('abort', () => reject(new Error('paused')), { once: true }))
    }
    raw.stock.oak_log += args.count
    return { outcome: 'succeeded', collected: args.count }
  })
  skills.goals.start({ kind: 'collect', item: 'oak_log', count: 8 })
  await tick()
  skills.goals.suspend()
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(skills.goals.view().state, 'paused')
  assert.equal(raw.stock.oak_log, 3)
  skills.goals.resume()
  await skills.goals.job.done
  assert.equal(skills.goals.view().state, 'succeeded')
  assert.equal(raw.stock.oak_log, 8)
})

test('PvE attacks respect weapon cooldown and stop when the target disappears', async () => {
  const { raw, skills } = fixture({ iron_sword: 1 })
  raw.entities = { 2: { id: 2, name: 'zombie', type: 'mob', position: new Vec3(2, 64, 0) } }
  raw.lookAt = async () => {}
  const attacks = []
  raw.attack = () => { attacks.push(Date.now()); if (attacks.length === 2) delete raw.entities[2] }
  const result = await skills.combat({ budgetMs: 2000 })
  assert.equal(result.outcome, 'succeeded')
  assert.equal(attacks.length, 2)
  assert.ok(attacks[1] - attacks[0] >= 650)
})

test('a stone pickaxe goal from an empty inventory prepares its tools and workbench', async () => {
  const { raw, skills, host } = fixture()
  const Recipe = mfRequire('prismarine-recipe')(registry).Recipe
  const workstations = new Map()
  raw.recipesFor = (id, _metadata, _count, table) => Recipe.find(id, null).filter(recipe => (!recipe.requiresTable || table)
    && recipe.delta.every(delta => delta.count >= 0 || (raw.stock[registry.items[delta.id].name] ?? 0) >= -delta.count))
  raw.craft = async recipe => { for (const delta of recipe.delta) { const name = registry.items[delta.id].name; raw.stock[name] = (raw.stock[name] ?? 0) + delta.count } }
  raw.blockAt = p => ({ name: workstations.get(`${p.x},${p.y},${p.z}`) ?? (p.y === 63 ? 'stone' : 'air'), boundingBox: workstations.has(`${p.x},${p.y},${p.z}`) || p.y === 63 ? 'block' : 'empty', position: p })
  raw.findBlock = ({ matching }) => {
    const found = [...workstations].find(([, name]) => registry.blocksByName[name].id === matching)
    return found ? { name: found[1], position: new Vec3(...found[0].split(',').map(Number)) } : null
  }
  host.placeBlock = async block => { workstations.set(`${block.x},${block.y},${block.z}`, block.name); raw.stock[block.name]-- }
  const gathered = []
  skills.collect = async (args, signal) => { signal.throwIfAborted(); const item = args.item === 'log' ? 'oak_log' : args.item; assert.ok(!/^stripped_|_wood$|_hyphae$|bamboo_block/.test(item), `processed wood is not a naturally gatherable tree: ${item}`); gathered.push(item); raw.stock[item] = (raw.stock[item] ?? 0) + args.count; return { outcome: 'succeeded', collected: args.count } }
  skills.goals.start({ kind: 'craft', item: 'stone_pickaxe', count: 1 })
  await skills.goals.job.done
  assert.equal(skills.goals.view().state, 'succeeded', JSON.stringify(skills.goals.view()))
  assert.equal(raw.stock.stone_pickaxe, 1)
  assert.ok(raw.stock.wooden_pickaxe >= 1, JSON.stringify({ stock: raw.stock, gathered }))
  assert.ok([...workstations.values()].includes('crafting_table'))
  assert.ok(gathered.includes('cobblestone'))
})

test('exploration selects safe loaded destinations and returns actual reached positions', async () => {
  const { raw, skills } = fixture()
  raw.blockAt = p => ({ name: p.y === 63 ? 'stone' : 'air', boundingBox: p.y === 63 ? 'block' : 'empty', position: p })
  skills.navigate = async args => { raw.entity.position = new Vec3(args.x, args.y, args.z); return { ok: true, outcome: 'succeeded' } }
  skills.goals.start({ kind: 'explore', count: 2, radius: 12 })
  await skills.goals.job.done
  assert.equal(skills.goals.view().state, 'succeeded')
  assert.equal(skills.goals.view().result.visited.length, 2)
})
test('empty-inventory iron-pickaxe preparation uses real recipes and raw-iron smelting', async () => {
  const { raw, skills, host } = fixture()
  const Recipe = mfRequire('prismarine-recipe')(registry).Recipe, stations = new Map(), gathered = []
  raw.recipesFor = (id, _metadata, _count, table) => Recipe.find(id, null).filter(recipe => (!recipe.requiresTable || table)
    && recipe.delta.every(delta => delta.count >= 0 || (raw.stock[registry.items[delta.id].name] ?? 0) >= -delta.count))
  raw.craft = async recipe => { for (const delta of recipe.delta) { const name = registry.items[delta.id].name; raw.stock[name] = (raw.stock[name] ?? 0) + delta.count } }
  raw.blockAt = p => ({ name: stations.get(p.toString()) ?? (p.y === 63 ? 'stone' : 'air'), position: p, boundingBox: stations.has(p.toString()) || p.y === 63 ? 'block' : 'empty' })
  raw.findBlock = ({ matching }) => {
    const found = [...stations].find(([, name]) => registry.blocksByName[name].id === matching)
    return found ? { name: found[1], position: new Vec3(...found[0].slice(1, -1).split(',').map(Number)) } : null
  }
  host.placeBlock = async block => { stations.set(new Vec3(block.x, block.y, block.z).toString(), block.name); raw.stock[block.name]-- }
  skills.collect = async ({ item, count }) => {
    item = item === 'log' ? 'oak_log' : item
    assert.ok(/_log$/.test(item) && !item.startsWith('stripped_') || ['cobblestone', 'raw_iron', 'coal'].includes(item), `unexpected natural resource: ${item}`)
    gathered.push(item); raw.stock[item] = (raw.stock[item] ?? 0) + count
    return { outcome: 'succeeded', collected: count }
  }
  let output = 0
  raw.openFurnace = async () => ({ inputItem: () => null, fuelItem: () => null, outputItem: () => output ? { name: 'iron_ingot', count: output } : null,
    putFuel: async (_type, _meta, count) => { raw.stock.coal -= count },
    putInput: async (_type, _meta, count) => { raw.stock.raw_iron -= count; output = count },
    takeOutput: async () => { raw.stock.iron_ingot = (raw.stock.iron_ingot ?? 0) + output; output = 0 }, close() {} })
  skills.goals.start({ kind: 'craft', item: 'iron_pickaxe', count: 1, budgetMs: 15000 })
  await skills.goals.job.done
  assert.equal(skills.goals.view().state, 'succeeded', JSON.stringify(skills.goals.view()))
  assert.equal(raw.stock.iron_pickaxe, 1)
  assert.ok(gathered.includes('raw_iron') && gathered.includes('coal'))
  assert.ok([...stations.values()].includes('furnace'))
})

test('delivery preserves resources when the named player is not visible', async () => {
  const { raw, skills } = fixture()
  skills.collect = async args => { raw.stock.oak_log = args.count; return { outcome: 'succeeded', collected: args.count } }
  skills.goals.start({ kind: 'collect', item: 'oak_log', count: 8, deliverTo: 'Absent' })
  await skills.goals.job.done
  assert.equal(skills.goals.view().state, 'blocked')
  assert.equal(raw.stock.oak_log, 8)
})
test('an inventory-first resource delivery skips mining tools even outside the overworld', async () => {
  const { raw, skills } = fixture({ diamond: 1 })
  raw.game.dimension = 'the_nether'
  raw.players.Player = { entity: { position: new Vec3(1, 64, 0) } }
  skills.collect = async () => { throw new Error('must not collect an already held resource') }
  skills.craftPlan = async () => { throw new Error('must not prepare an unnecessary pickaxe') }
  skills.host.tossItem = async ({ name, count }) => { raw.stock[name] -= count }
  skills.agent.act({ action: 'start', kind: 'gather', item: 'diamond', count: 1, deliverTo: 'Player' })
  await skills.goals.job.done
  assert.equal(skills.goals.view().state, 'succeeded', JSON.stringify(skills.goals.view()))
  assert.equal(raw.stock.diamond, 0)
  assert.equal(skills.goals.view().result.delivery.dropped, 1)
})
test('resuming a goal waits for a cancelled native action to settle', async () => {
  const { skills } = fixture()
  const job = { state: 'running', controller: new AbortController() }
  skills.quarantine = { label: 'cancelled mining operation' }
  let settled = false
  const waiting = skills.goals.ready(job).then(() => { settled = true })
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(settled, false)
  skills.quarantine = null
  await waiting
  assert.equal(settled, true)
})
test('returning from a distant resource expedition finds the delivery player at the start', async () => {
  const { raw, skills } = fixture({ diamond: 1 })
  const origin = raw.entity.position.clone()
  raw.entity.position = origin.offset(25, -10, 0)
  let returned = false
  skills.navigate = async args => {
    assert.equal(args.budgetMs, 120000)
    raw.entity.position = new Vec3(args.x, args.y, args.z)
    raw.players.Player = { entity: { position: origin.offset(1, 0, 0) } }
    returned = true
    return { ok: true, confirmed: true }
  }
  skills.host.tossItem = async ({ name, count }) => { raw.stock[name] -= count }
  const job = { kind: 'collect', item: 'diamond', deliverTo: 'Player', origin, controller: new AbortController(), state: 'running', progress: {} }
  const result = await skills.goals.deliver(job, 1)
  assert.equal(returned, true); assert.equal(result.dropped, 1)
})
test('resource delivery spans stacks and verifies the requested total', async () => {
  const { raw, skills } = fixture({ diamond: 10 })
  raw.players.Player = { entity: { position: new Vec3(1, 64, 0) } }
  const requests = []
  skills.host.tossItem = async ({ name, count }) => {
    requests.push(count)
    raw.stock[name] -= Math.min(count, 5)
  }
  skills.agent.act({ action: 'start', kind: 'gather', item: 'diamond', count: 8, deliverTo: 'Player' })
  await skills.goals.job.done
  assert.equal(skills.goals.view().state, 'succeeded')
  assert.deepEqual(requests, [8, 3])
  assert.equal(raw.stock.diamond, 2)
  assert.equal(skills.goals.view().result.delivery.dropped, 8)
})
test('pausing after a toss side effect does not send the delivered quantity twice', async () => {
  const { raw, skills } = fixture({ diamond: 2 })
  raw.players.Player = { entity: { position: new Vec3(1, 64, 0) } }
  let settle, calls = 0
  skills.host.tossItem = () => {
    calls++; raw.stock.diamond--
    return new Promise(resolve => { settle = resolve })
  }
  skills.agent.act({ action: 'start', kind: 'gather', item: 'diamond', count: 1, deliverTo: 'Player' })
  while (!settle) await tick()
  skills.goals.suspend()
  await new Promise(resolve => setTimeout(resolve, 280))
  assert.equal(skills.goals.view().state, 'paused')
  assert.ok(skills.quarantine)
  settle()
  await tick()
  skills.goals.resume()
  await skills.goals.job.done
  assert.equal(skills.goals.view().state, 'succeeded', JSON.stringify(skills.goals.view()))
  assert.equal(calls, 1); assert.equal(raw.stock.diamond, 1)
  assert.equal(skills.goals.view().result.delivery.dropped, 1)
})

test('delivery reports dropped inventory without falsely claiming player pickup', async () => {
  const { raw, skills, host } = fixture()
  raw.players.Player = { entity: { position: new Vec3(2, 64, 0) } }
  skills.collect = async args => { raw.stock.oak_log = args.count; return { outcome: 'succeeded', collected: args.count } }
  host.tossItem = async args => { raw.stock[args.name] -= args.count }
  skills.goals.start({ kind: 'collect', item: 'oak_log', count: 8, deliverTo: 'Player' })
  await skills.goals.job.done
  assert.equal(skills.goals.view().state, 'succeeded')
  assert.equal(skills.goals.view().result.delivery.dropped, 8)
  assert.match(skills.goals.view().result.delivery.note, /不等同/)
})

test('a dimension change clears old navigation and cancels the current goal', async () => {
  const { raw, skills } = fixture()
  skills.collect = (args, signal) => skills.run('test collection', signal, s => new Promise((_, reject) => s.addEventListener('abort', () => reject(new Error('dimension changed')), { once: true })))
  skills.goals.start({ kind: 'collect', item: 'oak_log', count: 8 })
  await tick()
  raw.emit('respawn')
  await skills.goals.job.done
  assert.equal(skills.goals.view().state, 'cancelled')
  assert.equal(raw.pathfinder.goal, null)
})

test('smelting uses matching materials across multiple inventory stacks', async () => {
  const {raw,skills} = fixture()
  let received = 0, ready = false
  raw.inventory.items = () => [
    {name:'raw_iron',type:registry.itemsByName.raw_iron.id,metadata:0,count:2},
    {name:'raw_iron',type:registry.itemsByName.raw_iron.id,metadata:0,count:2},
    {name:'coal',type:registry.itemsByName.coal.id,metadata:0,count:1},
    ...(received ? [{name:'iron_ingot',type:registry.itemsByName.iron_ingot.id,count:received}] : []),
  ]
  raw.findBlock = () => ({name:'furnace',position:new Vec3(1,64,0)})
  raw.openFurnace = async () => ({inputItem:()=>null,fuelItem:()=>null,outputItem:()=>ready?{name:'iron_ingot',count:4}:null,
    putFuel:async()=>{},putInput:async(_type,_meta,count)=>{assert.equal(count,4);ready=true},
    takeOutput:async()=>{received=4},close(){}})
  const result = await skills.smelt({item:'iron_ingot',count:4})
  assert.equal(result.smelted,4)
})

test('blueprint materials exceeding one tool batch are prepared through real recipe plans', async () => {
  const {raw,skills} = fixture({oak_log:64})
  raw.recipesFor = (id,_meta,count,table) => require('prismarine-recipe')(registry).Recipe.find(id,null).filter(recipe=>Object.keys(recipe).length && (!recipe.requiresTable||table))
  raw.craft = async recipe => {
    for (const delta of recipe.delta) {
      const name=registry.items[delta.id]?.name
      if (name) raw.stock[name]=(raw.stock[name]??0)+delta.count
    }
  }
  const job={controller:new AbortController(),state:'running',progress:{steps:0},phase:'materials'}
  await skills.goals.ensure(job,'oak_planks',256)
  assert.equal(raw.stock.oak_planks,256)
  assert.equal(raw.stock.oak_log,0)
})

test('recipe planning avoids consuming extra logs through an unnecessary wood conversion', async () => {
  const {skills} = fixture({oak_log:64,oak_planks:64})
  const plan = await skills.craftPlan({item:'oak_planks',count:64})
  assert.equal(plan.canCraftNow,true)
  assert.equal(plan.totalRequired.oak_log,16)
  assert.equal(plan.steps.some(step=>step.item==='oak_wood'),false)
})
test('empty-inventory preparation chooses natural nearby wood instead of stripped or nether variants', async () => {
  const { raw, skills } = fixture()
  const tree = new Vec3(8, 64, 0)
  raw.findBlocks = () => [tree]
  raw.blockAt = p => ({ name: p.equals(tree) ? 'acacia_log' : 'air', position: p, boundingBox: p.equals(tree) ? 'block' : 'empty' })
  const plan = await skills.craftPlan({ item: 'wooden_pickaxe', count: 1 })
  const resources = Object.keys(plan.totalRequired)
  assert.ok(resources.includes('acacia_log'), JSON.stringify(plan))
  assert.ok(!resources.some(name => /^stripped_|_wood$|_hyphae$|_stem$|bamboo_block/.test(name)), JSON.stringify(plan))
})
test('resource planning retains decompression recipes for storage blocks actually in inventory', () => {
  const { raw } = fixture({ coal_block: 1 })
  const plan = planCraft(raw, 'coal', 9)
  assert.equal(plan.canCraftNow, true, JSON.stringify(plan))
  assert.equal(plan.totalRequired.coal_block, 1)
  assert.equal(plan.steps.at(-1).item, 'coal')
})
test('a recoverable resource objective keeps its id and does not silently return to following', async () => {
  const { raw, skills } = fixture()
  raw.players.Player = { entity: { position: new Vec3(5, 64, 0) } }
  skills.setFollow('Player')
  let requests = 0
  skills.goals.expedition.obtain = async (_job, item, total) => {
    requests++; raw.stock[item] = (raw.stock[item] ?? 0) + Math.min(2, total - (raw.stock[item] ?? 0))
    return { outcome: raw.stock[item] >= total ? 'succeeded' : 'partial', reason: 'needs another region' }
  }
  skills.goals.start({ kind: 'collect', item: 'diamond', count: 4, useExisting: true })
  const job = skills.goals.job, id = job.id
  await job.done
  assert.equal(job.state, 'blocked'); assert.equal(raw.pathfinder.goal, null)
  skills.updateFollow(Date.now() + 1000); assert.equal(raw.pathfinder.goal, null)
  skills.agent.act({ action: 'continue' }); await job.done
  assert.equal(job.id, id); assert.equal(job.state, 'succeeded'); assert.equal(raw.stock.diamond, 4)
  assert.equal(job.retries, 1); assert.equal(requests, 2); assert.equal(skills.follow, null)
})
test('recovering partial delivery finishes only the unfulfilled quantity', async () => {
  const { raw, skills } = fixture()
  raw.players.Player = { entity: { position: new Vec3(1, 64, 0) } }
  skills.goals.expedition.obtain = async (_job, item, total) => {
    raw.stock[item] = (raw.stock[item] ?? 0) + Math.min(2, total - (raw.stock[item] ?? 0))
    return { outcome: raw.stock[item] >= total ? 'succeeded' : 'partial' }
  }
  let delivered = 0
  skills.host.tossItem = async ({ name, count }) => { raw.stock[name] -= count; delivered += count }
  skills.agent.act({ action: 'start', kind: 'gather', item: 'diamond', count: 4, deliverTo: 'Player' })
  const job = skills.goals.job
  await job.done; assert.equal(job.state, 'blocked'); assert.equal(delivered, 2)
  skills.agent.act({ action: 'continue' }); await job.done
  assert.equal(job.state, 'succeeded', JSON.stringify(skills.goals.view()))
  assert.equal(delivered, 4); assert.equal(raw.stock.diamond, 0); assert.equal(job.result.delivery.dropped, 4)
})
test('resource retry renews execution quotas while retaining cumulative progress', () => {
  const { skills } = fixture(), job = { progress: {} }, expedition = skills.goals.expedition
  const state = expedition.state(job, 'diamond')
  state.steps = 384; state.mined = 896; state.failures = 16
  expedition.resetFailures(job)
  assert.equal(state.steps, 384); assert.equal(state.mined, 896)
  assert.equal(state.stepBudgetBase, 384); assert.equal(state.minedBudgetBase, 896); assert.equal(state.failures, 0)
})
test('a generic pickaxe can prepare from a newly found birch forest without any oak', async () => {
  const { raw, skills, host } = fixture(), stations = new Map()
  const Recipe = mfRequire('prismarine-recipe')(registry).Recipe
  raw.recipesFor = (id, _metadata, _count, table) => Recipe.find(id, null).filter(recipe => (!recipe.requiresTable || table)
    && recipe.delta.every(delta => delta.count >= 0 || (raw.stock[registry.items[delta.id].name] ?? 0) >= -delta.count))
  raw.craft = async recipe => { for (const delta of recipe.delta) { const name = registry.items[delta.id].name; raw.stock[name] = (raw.stock[name] ?? 0) + delta.count } }
  raw.blockAt = p => ({ name: stations.get(p.toString()) ?? (p.y === 63 ? 'stone' : 'air'), position: p, boundingBox: stations.has(p.toString()) || p.y === 63 ? 'block' : 'empty' })
  raw.findBlock = ({ matching }) => {
    const found = [...stations].find(([, name]) => registry.blocksByName[name].id === matching)
    return found ? { name: found[1], position: new Vec3(...found[0].slice(1, -1).split(',').map(Number)) } : null
  }
  host.placeBlock = async block => { stations.set(new Vec3(block.x, block.y, block.z).toString(), block.name); raw.stock[block.name]-- }
  const gathered = []
  skills.collect = async ({ item, count }) => { assert.equal(item, 'log'); gathered.push(item); raw.stock.birch_log = (raw.stock.birch_log ?? 0) + count; return { outcome: 'succeeded' } }
  skills.goals.start({ kind: 'craft', item: 'wooden_pickaxe', count: 1, budgetMs: 15000 })
  await skills.goals.job.done
  assert.equal(skills.goals.job.state, 'succeeded', JSON.stringify(skills.goals.view()))
  assert.equal(raw.stock.wooden_pickaxe, 1); assert.ok(gathered.length); assert.equal(raw.stock.oak_log, undefined)
})
