// Run in an isolated Node process: node --max-old-space-size=128 --expose-gc tools/stress-pathfinder.mjs
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import pathfinderPkg from 'mineflayer-pathfinder'
import { attachPathfinderBudget } from '../src/pathfinder-budget.mjs'
import { PlayerMovements } from '../src/player-navigation.mjs'

const require = createRequire(import.meta.url), mfRequire = createRequire(require.resolve('mineflayer'))
const registry = mfRequire('prismarine-registry')('1.21.11')
const Block = mfRequire('prismarine-block')(registry), { Vec3 } = mfRequire('vec3')
const { Physics } = mfRequire('prismarine-physics'), { pathfinder, goals } = pathfinderPkg
const bot = new EventEmitter()
Object.assign(bot, { registry, version: '1.21.11', entities: {}, inventory: { items: () => [], slots: Array(46).fill(null) },
  entity: { position: new Vec3(0.5, 64, 0.5), onGround: true, velocity: new Vec3(0, 0, 0), effects: {}, attributes: {} },
  clearControlStates() {}, stopDigging() {},
  blockAt(p) {
    const at = p.floored()
    if (Math.abs(at.x) > 96 || Math.abs(at.z) > 96 || at.y < 63 || at.y > 70) return null
    const name = at.y === 63 ? 'stone' : 'air', block = Block.fromStateId(registry.blocksByName[name].minStateId, 0)
    block.position = at; return block
  },
})
bot.physics = Physics(registry, { getBlock: p => bot.blockAt(p) })
pathfinder(bot)
const movements = new PlayerMovements(bot)
bot.pathfinder.setMovements(movements)
const budget = attachPathfinderBudget(bot, { generatedNodes: 8192, tickMs: 1 })
const attempts = Number(process.argv[2] ?? 1000)
assert.ok(Number.isInteger(attempts) && attempts >= 10 && attempts <= 10000)

function search(i) {
  const generator = bot.pathfinder.getPathFromTo(movements, bot.entity.position, new goals.GoalBlock(1000, 64, i % 8), { optimizePath: false })
  let { result, astarContext: context } = generator.next().value
  // Includes the exact continuation used by upstream's live physics handler.
  for (let slice = 0; result.status === 'partial' && slice < 500; slice++) result = context.compute()
  assert.equal(result.budgetExceeded, true)
  if (context) {
    assert.equal(context.openDataMap.size, 0); assert.equal(context.closedDataSet.size, 0)
    assert.equal(context.openHeap.size(), 0)
  }
  generator.return()
  assert.equal(budget.snapshot().activeSearches, 0)
}
for (let i = 0; i < 20; i++) search(i)
global.gc?.()
const start = process.memoryUsage().heapUsed, startedAt = performance.now()
let peak = start
for (let i = 0; i < attempts; i++) {
  search(i)
  peak = Math.max(peak, process.memoryUsage().heapUsed)
  if (i % 50 === 0) await new Promise(resolve => setImmediate(resolve))
}
global.gc?.()
const end = process.memoryUsage().heapUsed
assert.ok(end - start < 16 * 1048576, `retained heap grew ${(end - start) / 1048576} MiB`)
const snapshot = budget.snapshot()
budget.detach()
console.log(JSON.stringify({ attempts, generatedNodeBudget: 8192, maxOldSpaceMB: Number(process.execArgv.find(a => a.startsWith('--max-old-space-size='))?.split('=')[1]) || null, elapsedMs: Math.round(performance.now() - startedAt),
  baselineHeapMB: +(start / 1048576).toFixed(2), peakHeapMB: +(peak / 1048576).toFixed(2), finalHeapMB: +(end / 1048576).toFixed(2),
  retainedGrowthMB: +((end - start) / 1048576).toFixed(2), limitedSearches: snapshot.limited, activeSearches: snapshot.activeSearches }))
