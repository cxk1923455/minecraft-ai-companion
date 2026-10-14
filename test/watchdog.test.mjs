import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Watchdog } from '../src/watchdog.mjs'
import { mentionRegex } from '../src/chat-intents.mjs'

const settle = () => new Promise(resolve => setImmediate(resolve))
function fixture(t, options = {}) {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 1700000000000 })
  const host = new EventEmitter(), messages = [], actions = []
  const raw = { username: 'Bot', entity: { position: { x: 0, y: 64, z: 0 } },
    players: { Owner: { entity: { position: { x: 1, y: 64, z: 0 } } }, Other: { entity: { position: { x: 1, y: 64, z: 1 } } } } }
  const skills = { raw, goals: { running: false, job: null }, busy: false, quarantine: false, follow: null, settings: { followDistance: 2 },
    halt: () => { actions.push('halt'); skills.follow = null; skills.goals.running = false },
    setFollow: who => { actions.push(`follow:${who}`); skills.follow = who; return { outcome: 'started' } },
    agent: { act: args => { actions.push(args); return { outcome: 'started' } } } }
  Object.assign(host, { bot: raw, online: true, skills })
  const agent = { id: 'watch-test', status: 'idle', steer: message => { messages.push(message) } }
  const wd = new Watchdog({ ctx: { get: () => null }, sess: { bot: host, agentId: 'watch-test', interruptWait() {} }, agent })
  wd.updateConfig({ observeWindowMs: 0, followUpAfterSec: 0, ...options }); wd.gate = () => true; wd.arm()
  t.after(() => { wd.disarm('test'); t.mock.timers.reset() })
  return { host, skills, raw, agent, wd, messages, actions, advance: async ms => { t.mock.timers.tick(ms); await settle() } }
}

test('routine task progress is merged into observable snapshots and never creates idle model turns', async t => {
  const f = fixture(t, { wakeOn: { heartbeat: true }, heartbeatSec: 10, followUpAfterSec: 1 })
  f.skills.goals.running = true; f.skills.goals.job = { id: 'job', state: 'running' }
  f.wd.lastWakeAt = Date.now() - 60000
  for (let i = 0; i < 100; i++) f.host.emit('goalProgress', { id: 'job', kind: 'collect', phase: '探索', state: 'running', progress: { explored: i } })
  await f.advance(120000)
  assert.equal(f.messages.length, 0); assert.equal(f.wd.pending.length, 0)
  assert.equal(f.wd.status().taskProgress.length, 1)
  assert.equal(f.wd.status().taskProgress[0].progress.explored, 99)
  f.host.emit('chat', { who: 'Owner', text: 'Bot，现在进展如何' })
  await f.advance(1000)
  assert.equal(f.messages.length, 1)
  assert.match(f.messages[0].content[0].text, /最新后台进展/)
  assert.match(f.messages[0].content[0].text, /"explored":99/)
})

test('death and final results bypass ordinary rate pressure and precede lower-value events', async t => {
  const f = fixture(t, { maxWakePerMinute: 1, localChatControl: false })
  f.wd.wakeTimes = [Date.now()]
  for (let i = 0; i < 100; i++) f.host.emit('teleport', { distance: i, from: {}, to: { x: i } })
  f.host.emit('chat', { who: 'Owner', text: 'Bot，我在这里等你' })
  f.host.emit('goalResult', { id: 'job', state: 'blocked', error: '需要探索更远的森林' })
  f.host.emit('death')
  assert.ok(f.wd.pending.length <= 64)
  assert.ok(f.wd.pending.some(event => event.kind === 'chat'))
  await f.advance(1000)
  assert.equal(f.messages.length, 1)
  const text = f.messages[0].content[0].text
  assert.match(text, /我死了/); assert.match(text, /需要探索更远的森林/)
  assert.ok(text.indexOf('我死了') < text.indexOf('持续目标结算'))
})

test('a failed async delivery remains pending and succeeds after backoff without an optimistic count', async t => {
  const f = fixture(t, { localChatControl: false })
  let attempts = 0
  f.agent.steer = message => { attempts++; if (attempts === 1) return Promise.reject(new Error('temporary driver error')); f.messages.push(message); return Promise.resolve({ accepted: true }) }
  f.host.emit('chat', { who: 'Owner', text: 'Bot，别丢掉这条任务' })
  await f.advance(1000)
  assert.equal(f.wd.stats.injected, 0); assert.equal(f.wd.pending.length, 1)
  assert.equal(f.wd.stats.failed, 1)
  await f.advance(1000)
  assert.equal(attempts, 2); assert.equal(f.wd.stats.injected, 1); assert.equal(f.wd.pending.length, 0)
  assert.match(f.messages[0].content[0].text, /别丢掉这条任务/)
})

test('host rejection receipts remain pending even when a transport promise resolves', async t => {
  const f = fixture(t)
  f.agent.steer = () => Promise.resolve({ accepted: false })
  f.host.emit('chat', { who: 'Owner', text: 'Bot，执行任务' })
  await f.advance(1000)
  assert.equal(f.wd.stats.injected, 0); assert.equal(f.wd.pending.length, 1)
})

test('topic continuation belongs to the same speaker and unrelated public chat cannot borrow it', async t => {
  const f = fixture(t, { localChatControl: false, wakeOn: { nearbySpeech: false } })
  f.host.emit('chat', { who: 'Owner', text: 'Bot，开始准备' })
  await f.advance(1000)
  f.host.emit('chat', { who: 'Other', text: '今天的天气不错' })
  assert.equal(f.wd.pending.length, 0)
  f.host.emit('chat', { who: 'Owner', text: '先别去地下，准备好补给' })
  assert.equal(f.wd.pending.length, 1)
  assert.equal(f.wd.pending[0].topical, true)
})

test('bystander requests cannot steal a locally admitted task; its owner can explicitly continue or halt', async t => {
  const f = fixture(t)
  f.wd.localOwner = 'Owner'
  f.skills.goals.running = true; f.skills.goals.job = { id: 'job', state: 'running', requestedBy: 'Owner' }
  f.host.emit('chat', { who: 'Other', text: 'Bot，跟着我' })
  await settle()
  assert.deepEqual(f.actions, [])
  f.host.emit('chat', { who: 'Owner', text: '你自己去找' })
  assert.equal(f.actions[0].action, 'continue')
  assert.equal(f.actions.includes('halt'), false)
  f.host.emit('chat', { who: 'Owner', text: '停止任务' })
  assert.equal(f.actions.at(-1), 'halt')
})

test('speaker attribution from ongoing task metadata protects tool-started goals', async t => {
  const f = fixture(t)
  f.skills.goals.job = { state: 'blocked', requestedBy: 'Owner' }
  f.host.emit('chat', { who: 'Other', text: '跟着我' })
  await settle(); assert.deepEqual(f.actions, [])
  f.host.emit('chat', { who: 'Owner', text: '快点继续' })
  assert.equal(f.actions[0].action, 'continue')
})

test('offline shutdown still delivers its truthful lifecycle notification and ends listeners', async t => {
  const f = fixture(t)
  f.host.online = false
  f.host.emit('offline', { reason: '服务器关闭', willReconnect: false })
  await settle()
  assert.equal(f.wd.armed, false); assert.equal(f.host.listenerCount('chat'), 0)
  assert.equal(f.messages.length, 1)
  assert.match(f.messages[0].content[0].text, /已经不在 Minecraft/)
  assert.equal(f.messages[0].source.kind, 'plugin:whale_craft')
})

test('closing only the watcher does not falsely report that its connected Minecraft body left the game', async t => {
  const f = fixture(t)
  f.wd.disarm('手动关闭监听', { notify: true })
  await settle()
  assert.equal(f.host.online, true); assert.equal(f.wd.armed, false)
  assert.match(f.messages[0].content[0].text, /角色仍在游戏里/)
  assert.doesNotMatch(f.messages[0].content[0].text, /已经不在 Minecraft/)
})

test('invalid configs fail atomically and complex regular expressions cannot run in chat callbacks', t => {
  const f = fixture(t)
  const original = structuredClone(f.wd.config)
  for (const patch of [{ heartbeatSec: -1 }, { maxWakePerMinute: Infinity }, { observeWindowMs: '0' }, { wakeOn: { death: 'false' } },
    { localChatControl: 1 }, { mentionPatterns: ['(a+)+$'] }, { mentionPatterns: ['a+a+'] }, { mentionPatterns: Array(65).fill('Bot') },
    { nearRadius: 24, wakeOn: { madeUp: true } }]) assert.throws(() => f.wd.updateConfig(patch))
  assert.deepEqual(f.wd.config, original)
  assert.equal(mentionRegex('(a+)+$'), null)
  assert.ok(mentionRegex('deep\\s*seek')); assert.ok(mentionRegex('\\bai\\b'))
})
