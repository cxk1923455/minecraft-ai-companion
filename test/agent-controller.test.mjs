import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { AgentController, resourceRequest } from '../src/agent-controller.mjs'
import { localChatIntent } from '../src/chat-intents.mjs'
import { Watchdog } from '../src/watchdog.mjs'

test('direct resource requests preserve quantities, real materials and delivery intent', () => {
  assert.deepEqual(resourceRequest('去挖1颗钻石给我'), { kind: 'gather', item: 'diamond', count: 1, deliver: true })
  assert.deepEqual(resourceRequest('你去找 直到给我一颗钻石'), { kind: 'gather', item: 'diamond', count: 1, deliver: true })
  assert.deepEqual(resourceRequest('Bot，帮我采集十二块圆石', ['Bot']), { kind: 'gather', item: 'cobblestone', count: 12, deliver: false })
  assert.equal(resourceRequest('找煤炭给我').item, 'coal')
})
test('negations, quotations, speculative statements and excessive quantities do not start mining', () => {
  for (const text of ['不要挖钻石', '他说“去挖钻石”', '如果找到钻石给我', '你是不是在挖钻石', '收集100颗钻石', '不能挖铁矿', '我去挖一颗钻石给你']) assert.equal(resourceRequest(text), null, text)
})
test('room entry and task pause/resume are distinct from ordinary nearby movement', () => {
  assert.equal(localChatIntent('你进房间里来'), 'enter')
  assert.equal(localChatIntent('进来'), 'enter')
  assert.equal(localChatIntent('过来'), 'come')
  assert.equal(localChatIntent('暂停挖矿'), 'pause')
  assert.equal(localChatIntent('继续任务'), 'resume')
  assert.equal(localChatIntent('取消任务'), 'halt')
  assert.equal(localChatIntent('别进来'), null)
})
test('independent-search and continuation requests keep an existing objective distinct from stop', () => {
  for (const text of ['你自己去找', '自己找', '你去自己找', '别跟着我去完成任务', '别跟着我，去完成原来的任务']) assert.equal(localChatIntent(text), 'continue', text)
  for (const text of ['继续挖', '快点继续', '继续去找']) assert.equal(localChatIntent(text), 'resume', text)
  for (const text of ['不要继续', '如果让你自己去找', '他说“你自己去找”']) assert.equal(localChatIntent(text), null, text)
})
function controllerFixture() {
  const raw = { health: 20, food: 20, registry: { blocksArray: [], itemsByName: { diamond: {} } }, entity: { position: { x: 0, y: 64, z: 0 } } }
  let startCount = 0
  const goals = { running: false, job: null, view: () => goals.job,
    start: spec => { if (goals.running) throw new Error('当前目标尚未结束'); startCount++; goals.running = true; goals.job = { ...spec, who: spec.who ?? null, deliverTo: spec.deliverTo ?? null, count: spec.count ?? 1, state: 'running', target: { x: spec.x, y: spec.y, z: spec.z } }; return goals.job },
    suspend: () => { goals.job.state = 'paused'; return goals.job }, resume: () => { goals.job.state = 'running'; return goals.job } }
  const skills = { bot: raw, raw, goals, host: { online: true }, active: null, halt: () => { goals.running = false; return { stopped: true } } }
  return { skills, goals, director: new AgentController(skills), startCount: () => startCount }
}
test('a diamond objective starts a long-lived inventory-first expedition and status does not restart it', () => {
  const f = controllerFixture()
  const result = f.director.act({ action: 'start', kind: 'gather', item: 'diamond', count: 1, deliverTo: 'Player' })
  assert.equal(result.outcome, 'started'); assert.equal(result.task.kind, 'collect')
  assert.equal(result.task.budgetMs, 1800000); assert.equal(result.task.useExisting, true)
  assert.equal(result.task.deliverTo, 'Player')
  for (let i = 0; i < 10; i++) f.director.act({ action: 'status' })
  const reused = f.director.act({ action: 'start', kind: 'gather', item: 'diamond', count: 1, deliverTo: 'Player' })
  assert.equal(reused.reused, true); assert.equal(f.startCount(), 1)
})
test('pause/resume keep the admitted objective and cancelling stops its body', () => {
  const f = controllerFixture()
  f.director.act({ action: 'start', kind: 'gather', item: 'diamond', count: 1 })
  const original = f.goals.job
  f.director.act({ action: 'pause' }); assert.equal(original.state, 'paused')
  f.director.act({ action: 'resume' }); assert.equal(original.state, 'running')
  assert.equal(f.goals.job, original)
  assert.equal(f.director.act({ action: 'cancel' }).stopped, true)
})
test('continue recovers a blocked task with the same objective and never halts its body', () => {
  const f = controllerFixture()
  f.director.act({ action: 'start', kind: 'gather', item: 'diamond', count: 1 })
  const original = f.goals.job
  Object.assign(original, { id: 'same-job', state: 'blocked', progress: { mined: 17, visited: 4 } })
  f.goals.running = false
  let retries = 0
  f.goals.retry = args => { retries++; assert.equal(args.budgetMs, 300000); original.state = 'running'; f.goals.running = true; return original }
  f.skills.follow = 'Player'; f.skills.followState = { phase: 'following' }
  f.skills.halt = () => { throw new Error('continuation must not cancel the admitted task') }
  const resumed = f.director.act({ action: 'continue', budgetMs: 300000 })
  assert.equal(resumed.task, original); assert.equal(resumed.task.id, 'same-job')
  assert.equal(resumed.task.progress.mined, 17); assert.equal(retries, 1)
  assert.equal(f.skills.follow, null); assert.equal(f.skills.followState.phase, 'inactive')
  assert.equal(f.startCount(), 1)
})
test('continue while a task runs observes the same body without cancelling or resetting it', () => {
  const f = controllerFixture()
  f.director.act({ action: 'start', kind: 'gather', item: 'diamond' })
  f.skills.busy = true; f.skills.follow = 'Player'
  f.skills.release = () => { throw new Error('cannot release a running body') }
  const result = f.director.act({ action: 'continue' })
  assert.equal(result.reused, true); assert.equal(result.task, f.goals.job)
  assert.equal(f.startCount(), 1); assert.equal(f.skills.follow, null)
})
test('repeating a paused objective resumes it rather than reporting a still-paused task as active', () => {
  const f = controllerFixture()
  f.director.act({ action: 'start', kind: 'gather', item: 'diamond' })
  f.director.act({ action: 'pause' })
  const resumed = f.director.act({ action: 'start', kind: 'gather', item: 'diamond' })
  assert.equal(resumed.task.state, 'running'); assert.equal(resumed.reused, true)
  assert.equal(f.startCount(), 1)
})
test('cancelled or completed objectives are not silently restarted by an ambiguous continuation', () => {
  const f = controllerFixture()
  f.director.act({ action: 'start', kind: 'gather', item: 'diamond' })
  f.goals.running = false; f.goals.job.state = 'cancelled'; f.skills.follow = 'Player'
  assert.throws(() => f.director.act({ action: 'continue' }), /不能擅自重启/)
  assert.equal(f.startCount(), 1); assert.equal(f.skills.follow, 'Player')
})
test('changing fresh-mining policy or search radius is not mistaken for the current objective', () => {
  const f = controllerFixture()
  f.director.act({ action: 'start', kind: 'gather', item: 'diamond' })
  assert.throws(() => f.director.act({ action: 'start', kind: 'gather', item: 'diamond', useExisting: false }), /当前目标尚未结束/)
  assert.throws(() => f.director.act({ action: 'start', kind: 'gather', item: 'diamond', radius: 64 }), /当前目标尚未结束/)
  assert.equal(f.startCount(), 1)
  assert.equal(f.director.history.length, 1, 'failed admission does not record an executed decision')
})
test('a namespaced diamond identifier receives the same deep-mining budget', () => {
  const f = controllerFixture()
  const result = f.director.act({ action: 'start', kind: 'gather', item: 'minecraft:diamond' })
  assert.equal(result.task.item, 'diamond')
  assert.equal(result.task.budgetMs, 1800000)
})
test('generic gathering wood remains a material family instead of locking exploration to oak', () => {
  const f = controllerFixture()
  const result = f.director.act({ action: 'start', kind: 'gather', item: 'minecraft:log', count: 4 })
  assert.equal(result.task.item, 'log')
  assert.equal(result.task.count, 4)
})
function localFixture() {
  const raw = { username: 'Bot', players: { Player: { entity: { position: { x: 1, y: 64, z: 0 } } } }, entity: { position: { x: 0, y: 64, z: 0 } } }
  const actions = [], wakes = [], host = new EventEmitter()
  const skills = { raw, busy: false, quarantine: false, goals: { running: false }, halt: () => {}, settings: { followDistance: 2 },
    agent: { act: spec => { actions.push(spec); return { outcome: 'started', task: { state: 'running' } } } } }
  Object.assign(host, { bot: raw, skills, online: true })
  const wd = new Watchdog({ ctx: { get: () => null }, sess: { bot: host, agentId: 'test', interruptWait() {} }, agent: { id: 'test', status: 'idle', steer: message => wakes.push(message) } })
  wd.updateConfig({ observeWindowMs: 0, followUpAfterSec: 0 }); wd.gate = () => true; wd.arm()
  return { raw, host, skills, wd, actions, wakes }
}
test('a nearby mining request starts actual task admission before the language model is invoked', async () => {
  const f = localFixture()
  try {
    f.host.emit('chat', { who: 'Player', text: '去挖1颗钻石给我' })
    await new Promise(r => setImmediate(r))
    assert.equal(f.actions.length, 1)
    assert.equal(f.actions[0].kind, 'gather'); assert.equal(f.actions[0].item, 'diamond'); assert.equal(f.actions[0].deliverTo, 'Player')
    assert.equal(f.wakes.length, 0)
  } finally { f.wd.disarm('test') }
})
test('the local task gateway respects mode gating and does not act on negated requests', async () => {
  const f = localFixture()
  try {
    f.host.emit('chat', { who: 'Player', text: '不要挖钻石' })
    f.wd.gate = () => false
    f.host.emit('chat', { who: 'Player', text: '去挖1颗钻石给我' })
    await new Promise(r => setImmediate(r)); assert.equal(f.actions.length, 0)
  } finally { f.wd.disarm('test') }
})
test('a later request to deliver resources changes a nondelivery or crafting objective', async () => {
  for (const kind of ['collect', 'craft']) {
    const f = localFixture()
    f.skills.goals.running = true
    f.skills.goals.job = { kind, item: 'diamond', count: 1, deliverTo: null, useExisting: true }
    f.skills.halt = () => { f.skills.goals.running = false }
    try {
      f.host.emit('chat', { who: 'Player', text: '去挖1颗钻石给我' })
      await new Promise(r => setImmediate(r))
      assert.equal(f.actions.length, 1, kind)
      assert.equal(f.actions[0].deliverTo, 'Player')
    } finally { f.wd.disarm('test') }
  }
})
