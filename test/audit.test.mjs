import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McBot } from '../src/core.mjs'
import { PluginConfig } from '../src/config.mjs'
import { Watchdog } from '../src/watchdog.mjs'
import { localChatIntent } from '../src/chat-intents.mjs'
import { planInWorker } from '../src/craft-planner.mjs'
import { runtimeState } from '../src/runtime-state.mjs'

const require = createRequire(import.meta.url)
const mfRequire = createRequire(require.resolve('mineflayer'))
const registry = mfRequire('prismarine-registry')('1.20.4')
const { Vec3 } = mfRequire('vec3')
const scratch = mkdtempSync(join(tmpdir(), 'whale-audit-'))
after(() => rmSync(scratch, { recursive: true, force: true }))
const tick = () => new Promise(resolve => setImmediate(resolve))
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

function fixture(policy) {
  const host = new McBot({ logFile: join(scratch, `${Math.random()}.log`), ...(policy ? { commandPolicy: policy } : {}) })
  const raw = new EventEmitter()
  Object.assign(raw, { username: 'TestBot', version: '1.20.4', registry,
    entity: { position: new Vec3(0,64,0) }, game: { gameMode: 'survival' },
    _client: new EventEmitter(), inventory: { items: () => [], slots: [] },
    players: { Tester: { entity: { position: new Vec3(5,64,0) } } },
    calls: [], chat: text => raw.calls.push(text), clearControlStates() {},
    stopDigging() {}, deactivateItem() {},
    pathfinder: { goal: null, movements: {}, isMining:()=>false, isBuilding:()=>false, setGoal(goal) { this.goal = goal }, setMovements(movements) { this.movements = movements } },
  })
  host.bot = raw
  host.skills.raw = raw
  return { host, raw, skills: host.skills }
}
function watcher(host, options = {}, steer = () => {}) {
  const wd = new Watchdog({ ctx: { get: () => null }, sess: { bot: host, agentId: 'audit', interruptWait() {} }, agent: { id:'audit', status:'idle', steer } })
  wd.updateConfig({ observeWindowMs: 0, followUpAfterSec: 0, ...options })
  wd.gate = () => true
  wd.arm()
  return wd
}

test('command master switch denies every command even with allow-all or wildcard whitelist', () => {
  const config = new PluginConfig(join(scratch, 'permissions'))
  config.set('allowAllCommands', true)
  config.set('commandWhitelist', ['*'])
  const {host,raw} = fixture(name => config.commandAllowed(name))
  assert.throws(() => host.command('/tp TestBot Tester', {allow: () => true}), /关闭|未放行/)
  assert.equal(raw.calls.length, 0)
  config.set('commandsEnabled', true)
  assert.equal(host.command('/tp TestBot Tester'), '/tp TestBot Tester')
  assert.equal(raw.calls.length, 1)
  config.set('commandsEnabled', false)
  assert.throws(() => host.command('/kill TestBot'), /关闭|未放行/)
  assert.equal(raw.calls.length, 1)
})

test('ordinary chat cannot bypass command permissions or hide a command behind whitespace', () => {
  const {host,raw} = fixture(() => true)
  for (const text of ['/tp TestBot Tester','  /kill TestBot','\n /give @s diamond']) assert.throws(() => host.chatSay(text), /普通聊天/)
  assert.equal(raw.calls.length, 0)
  assert.equal(host.chatSay('你好'), '你好')
  assert.throws(() => host.command('/say hi\n/kill @e'), /单行/)
  assert.deepEqual(raw.calls, ['你好'])
})

test('ordinary chat sanitizes illegal characters without hiding slash commands or splitting emoji', () => {
  const { host, raw } = fixture()
  assert.throws(() => host.chatSay('\u0000/tp TestBot Tester'), /普通聊天/)
  assert.equal(host.chatSay('§a你好\u0000世界'), '你好 世界')
  const sent = host.chatSay('a' + '😀'.repeat(110))
  assert.equal(sent.length, 219)
  assert.ok(!/[\uD800-\uDBFF]$/.test(sent))
  assert.equal(raw.calls.length, 2)
})

test('sequence treats an unfinished movement as failure and does not run subsequent steps', async () => {
  const {host,raw} = fixture()
  host.walkTo = async () => ({arrived:false,remaining:8})
  const result = await host.runSequence([{op:'move',x:8,y:64,z:0},{op:'say',text:'done'}])
  assert.equal(result.succeeded, 0)
  assert.equal(result.failed, 1)
  assert.equal(result.completed, false)
  assert.equal(result.outcome, 'partial')
  assert.equal(raw.calls.length, 0)
})

test('body result does not turn arrived false into succeeded', async () => {
  const {skills} = fixture()
  const result = await skills.run('movement', null, async () => ({arrived:false,remaining:12}))
  assert.equal(result.outcome, 'partial')
  assert.equal(skills.lastResult.outcome, 'partial')
})

test('starting follow reports measured distance rather than claiming arrival', () => {
  const {skills,raw} = fixture()
  const result = skills.setFollow('tester')
  assert.equal(result.outcome, 'started')
  assert.equal(result.follow.distance, 5)
  assert.equal(result.follow.verifiedNearby, false)
  raw.players.Tester.entity.position = new Vec3(1,64,0)
  assert.equal(skills.status().follow.verifiedNearby, true)
})

test('navigation verifies current player position even if the player moved during goto', async () => {
  const {skills,raw} = fixture()
  raw.pathfinder.setGoal = function(goal) {
    this.goal = goal
    if (goal) queueMicrotask(() => {
      raw.entity.position = new Vec3(5,64,0)
      raw.players.Tester.entity.position = new Vec3(25,64,0)
      raw.emit('goal_reached', goal)
    })
  }
  const result = await skills.navigate({who:'Tester'})
  assert.equal(result.arrived, false)
  assert.equal(result.confirmed, false)
  assert.equal(result.outcome, 'partial')
  assert.equal(result.remaining, 20)
})

test('signed and normalized chat share one event with the correct speaker', () => {
  const {host,raw} = fixture()
  host.wireChatEvents(raw)
  const chats = []
  host.on('chat', event => chats.push(event))
  const msg = {translate:'chat.type.text',with:[{text:'Tester'},{text:'过来',extra:[{text:'！'}]}],toString:()=>'<Tester> 过来！'}
  raw.emit('message',msg,'chat')
  raw._client.emit('player_chat',{senderName:'{"text":"Tester"}',plainMessage:'过来！'})
  raw.emit('chat','Tester','过来！')
  assert.deepEqual(chats, [{who:'Tester',text:'过来！'}])
})

test('interleaved chat duplicates and self messages do not cause extra wakes', () => {
  const {host,raw} = fixture()
  host.wireChatEvents(raw)
  const chats = []
  host.on('chat', event => chats.push(event))
  raw.emit('chat','Tester','hello')
  raw.emit('chat','Other','hi')
  raw.emit('chat','Tester','hello')
  raw.emit('whisper','Tester','private')
  raw.emit('chat','TestBot','self')
  assert.deepEqual(chats.map(x=>x.text), ['hello','hi','private'])
})

test('raw modern chat without a name uses UUID and cannot generate unknown self-chat wakes', () => {
  const { host, raw } = fixture()
  raw.players.Tester.username = 'Tester'; raw.players.Tester.uuid = '11111111-1111-1111-1111-111111111111'
  raw._client.uuid = '22222222-2222-2222-2222-222222222222'
  host.wireChatEvents(raw)
  const chats = []; host.on('chat', e => chats.push(e))
  raw._client.emit('player_chat', { sender: raw.players.Tester.uuid, plainMessage: '进来' })
  raw.emit('chat', 'Tester', '进来')
  raw._client.emit('player_chat', { sender: raw._client.uuid, plainMessage: '我来了' })
  raw._client.emit('player_chat', { plainMessage: '我来了' })
  assert.deepEqual(chats, [{ who: 'Tester', text: '进来' }])
})

test('local fast path only recognizes complete movement requests, not negations or conversation', () => {
  assert.equal(localChatIntent('TestBot，快点过来！',['TestBot']), 'come')
  assert.equal(localChatIntent('跟着我'), 'follow')
  assert.equal(localChatIntent('停止跟随'), 'halt')
  for (const text of ['不要过来','他说“跟着我”','停止使用指令','你能不能跟着我去找矿石','我跟着你']) assert.equal(localChatIntent(text), null)
})

test('nearby follow and halt requests execute before any model steer call', async () => {
  const {host,skills} = fixture()
  const deliveries = []
  const wd = watcher(host, {}, message => deliveries.push(message))
  try {
    host.emit('chat',{who:'Tester',text:'跟着我'})
    await tick()
    assert.equal(skills.follow, 'Tester')
    assert.equal(deliveries.length, 0)
    host.emit('chat',{who:'Tester',text:'停止跟随'})
    assert.equal(skills.follow, null)
    assert.equal(host.online, true)
  } finally { wd.disarm('test') }
})

test('local control respects its setting and MC mode gate', async () => {
  const {host,skills} = fixture()
  const wd = watcher(host, {localChatControl:false})
  try {
    host.emit('chat',{who:'Tester',text:'跟着我'})
    await tick()
    assert.equal(skills.follow, null)
    wd.updateConfig({localChatControl:true})
    wd.gate = () => false
    host.emit('chat',{who:'Tester',text:'跟着我'})
    await tick()
    assert.equal(skills.follow, null)
  } finally { wd.disarm('test') }
})

test('rate limit retains chat and delivers it when capacity returns', async () => {
  const {host} = fixture()
  const messages = []
  const wd = watcher(host,{maxWakePerMinute:1,localChatControl:false},message=>messages.push(message))
  try {
    wd.wakeTimes = [Date.now()]
    host.emit('chat',{who:'Tester',text:'TestBot 新任务'})
    await wait(1100)
    assert.equal(messages.length, 0)
    assert.equal(wd.pending.length, 1)
    wd.wakeTimes = [Date.now()-61000]
    await wait(1100)
    assert.equal(messages.length, 1)
    assert.match(messages[0].content[0].text, /新任务/)
  } finally { wd.disarm('test') }
})

test('async steer rejection is recorded without an unhandled rejection', async () => {
  const {host} = fixture()
  const wd = watcher(host,{localChatControl:false},()=>Promise.reject(new Error('driver closed')))
  try {
    host.emit('chat',{who:'Tester',text:'TestBot hello'})
    await wait(1100)
    assert.equal(wd.stats.injected, 0)
    assert.ok(wd.log.some(entry=>entry.text.includes('steer 异步投递失败')))
  } finally { wd.disarm('test') }
})

test('planning cancellation and nonserializable requests release the worker for future requests', async () => {
  const payload = {version:'1.20.4',item:'oak_planks',count:1,inventory:[]}
  await assert.rejects(planInWorker({...payload,invalid:()=>{}}), /clone/i)
  const controller = new AbortController()
  const pending = planInWorker(payload,{signal:controller.signal})
  controller.abort(new Error('stop planning'))
  await assert.rejects(pending, /stop planning/)
  const result = await planInWorker(payload)
  assert.equal(result.targetItem, 'oak_planks')
})

test('runtime facts report observed distance, pending follow, and command prohibition', () => {
  const {host,skills,raw} = fixture()
  skills.setFollow('Tester')
  const state = runtimeState(host)
  assert.equal(state.commandsEnabled,false)
  assert.equal(state.follow.verifiedNearby,false)
  assert.equal(state.players[0].distance,5)
  raw._client.ended = true
  assert.equal(runtimeState(host),null)
})

test('legacy walk uses the attached safe pathfinder and confirms arrival', async () => {
  const {host,raw} = fixture()
  raw.pathfinder.setGoal = function(goal) {
    this.goal = goal
    if (goal) queueMicrotask(() => { raw.entity.position = new Vec3(6,64,0); raw.emit('goal_reached',goal) })
  }
  const result = await host.walkTo({x:6,y:64,z:0})
  assert.equal(result.arrived,true)
  assert.equal(result.confirmed,true)
  assert.equal(raw.pathfinder.movements.canDig,false)
})
