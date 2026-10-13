// Minecraft skills adapted from Hiyori (MIT) for Whale Craft's existing bot.
import pathfinderPkg from 'mineflayer-pathfinder'
import toolPkg from 'mineflayer-tool'
import collectPkg from 'mineflayer-collectblock'
import vec3pkg from 'vec3'
import { TaskGoals } from './task-goals.mjs'
import { planInWorker } from './craft-planner.mjs'
import { recipesSourceFor, patchedGoto, protectMovementsFromFluid, assessExcavationFluidRisk, runAbortableOperation, smeltInputFor } from './hiyori-skills.mjs'

const { pathfinder, Movements, goals } = pathfinderPkg
const Vec3 = vec3pkg.Vec3 ?? vec3pkg
const BODY_TOOLS = new Set(['mc_move', 'mc_act', 'mc_give', 'mc_sequence', 'mc_build', 'mc_dig', 'mc_command'])
const FOOD = ['cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'cooked_salmon', 'cooked_cod', 'bread', 'baked_potato', 'carrot', 'apple', 'melon_slice', 'sweet_berries']
const DROP_SOURCES = { cobblestone: ['stone'], cobbled_deepslate: ['deepslate'], raw_iron: ['iron_ore', 'deepslate_iron_ore'], raw_gold: ['gold_ore', 'deepslate_gold_ore'], raw_copper: ['copper_ore', 'deepslate_copper_ore'], coal: ['coal_ore', 'deepslate_coal_ore'], diamond: ['diamond_ore', 'deepslate_diamond_ore'] }
const HOSTILES = new Set(['zombie', 'zombie_villager', 'husk', 'drowned', 'skeleton', 'stray', 'wither_skeleton', 'spider', 'cave_spider', 'creeper', 'blaze', 'pillager', 'ravager', 'vindicator', 'slime', 'magma_cube'])

export function boundedInteger(value, fallback, min, max, name) {
  const n = value === undefined ? fallback : Number(value)
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} 必须是 ${min}–${max} 之间的整数`)
  return n
}
function check(signal) { if (signal?.aborted) throw Object.assign(new Error('Minecraft 动作已中断'), { mcAborted: true }) }
function counts(bot) { const out = {}; for (const item of bot.inventory?.items?.() ?? []) { out[item.name] = (out[item.name] ?? 0) + item.count; if (/^log2?$|_log$|_stem$/.test(item.name) && item.name !== 'log') out.log = (out.log ?? 0) + item.count } return out }
function position(p) { return p ? { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } : null }
function delay(ms, signal) {
  check(signal)
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', abort)
    const timer = setTimeout(() => { cleanup(); resolve() }, ms)
    const abort = () => { clearTimeout(timer); cleanup(); reject(Object.assign(new Error('Minecraft 动作已中断'), { mcAborted: true })) }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}

/** Per McBot instance; no second connection, agent, model or credential store. */
export class SurvivalSkills {
  constructor(host) {
    this.host = host
    this.raw = null
    this.active = null
    this.quarantine = null
    this.follow = null
    this.followState = { phase: 'inactive', attempts: 0, lastProgressAt: 0, position: null }
    this.paused = false
    this.pendingReflex = false
    this.reflexUntil = 0
    this.lastFollowCheck = 0
    this.settings = { autoEat: true, autoSurface: true, autoRetreat: true, autoDefend: true, foodThreshold: 6, oxygenThreshold: 10, healthThreshold: 6, followDistance: 2 }
    this.goals = new TaskGoals(this)
    this.metrics = { followReplans: 0, interruptions: 0, localDecisions: 0, decisionMsMax: 0 }
    this.decisionSamples = []
    this.lastResult = null
    this.onRespawn = () => this.halt('重生或维度变化，旧目标与路径已取消')
    this.tick = () => {
      const started = performance.now()
      try { this.onTick() } catch (e) { this.host.log('生存控制异常：', e.message) }
      finally {
        const elapsed = performance.now() - started
        this.metrics.localDecisions++; this.metrics.decisionMsMax = Math.max(this.metrics.decisionMsMax, elapsed)
        this.decisionSamples.push(elapsed)
        if (this.decisionSamples.length > 128) this.decisionSamples.shift()
      }
    }
    host.on('spawn', () => { try { this.attach() } catch (e) { host.log('生存技能初始化失败：', e.message) } })
    host.on('offline', () => this.detach('连接结束'))
    host.on('death', () => this.halt('死亡'))
  }
  coordinates(name) { return BODY_TOOLS.has(name) }
  get busy() { return Boolean(this.active) }
  get bot() { const b = this.host.requireBot(); if (this.raw !== b) this.attach(); return b }

  attach() {
    const b = this.host.requireBot()
    if (this.raw === b) return b
    this.detach('切换游戏身体')
    this.raw = b
    this.quarantine = null
    this.paused = false
    if (!b.pathfinder) b.loadPlugin(pathfinder)
    if (!b.tool) b.loadPlugin(toolPkg.plugin)
    if (!b.collectBlock) b.loadPlugin(collectPkg.plugin)
    const movements = protectMovementsFromFluid(b, new Movements(b))
    movements.canDig = false
    movements.allow1by1towers = false
    b.pathfinder.setMovements(movements)
    b.pathfinder.tickTimeout = Math.min(b.pathfinder.tickTimeout ?? 5, 5)
    b.pathfinder.thinkTimeout = Math.min(b.pathfinder.thinkTimeout ?? 2000, 2000)
    if (b.collectBlock.movements) protectMovementsFromFluid(b, b.collectBlock.movements)
    b.on('physicsTick', this.tick)
    b.on('respawn', this.onRespawn)
    return b
  }

  release(bot = this.raw, closeWindow = false) {
    try { bot?.pathfinder?.setGoal(null) } catch {}
    try { bot?.collectBlock?.targets?.clear() } catch {}
    try { bot?.stopDigging?.() } catch {}
    try { bot?.deactivateItem?.() } catch {}
    if (closeWindow) { try { bot?.closeWindow?.(bot.currentWindow) } catch {} }
    try { bot?.clearControlStates?.() } catch {}
  }
  halt(reason = '停止当前动作') {
    this.paused = true
    this.follow = null
    this.followState.phase = 'inactive'
    this.goals.cancel(reason)
    this.active?.controller.abort(reason)
    this.release(this.raw, true)
    return this.status()
  }
  detach(reason) {
    this.halt(reason)
    this.raw?.off?.('physicsTick', this.tick)
    this.raw?.off?.('respawn', this.onRespawn)
    this.raw = null
  }
  status() {
    const samples = [...this.decisionSamples].sort((a, b) => a - b)
    return {
      online: this.host.online, active: this.active?.label ?? null,
      follow: this.follow ? { player: this.follow, suspended: this.busy || this.paused || this.goals.running, phase: this.followState.phase, recoveryAttempts: this.followState.attempts } : null,
      settings: { ...this.settings }, paused: this.paused,
      lastResult: this.lastResult, pathfinding: 'A* / 5ms search slices',
      waitingForCancelledAction: Boolean(this.quarantine),
      goal: this.goals.view(), metrics: { ...this.metrics, decisionMsP95: samples.length ? samples[Math.ceil(samples.length * 0.95) - 1] : null },
    }
  }
  configure(values = {}) {
    for (const key of ['autoEat', 'autoSurface', 'autoRetreat', 'autoDefend']) if (values[key] !== undefined) {
      if (typeof values[key] !== 'boolean') throw new Error(`${key} 必须是布尔值`)
      this.settings[key] = values[key]
    }
    if (values.foodThreshold !== undefined) this.settings.foodThreshold = boundedInteger(values.foodThreshold, 6, 1, 18, 'foodThreshold')
    if (values.oxygenThreshold !== undefined) this.settings.oxygenThreshold = boundedInteger(values.oxygenThreshold, 10, 1, 18, 'oxygenThreshold')
    if (values.healthThreshold !== undefined) this.settings.healthThreshold = boundedInteger(values.healthThreshold, 6, 1, 18, 'healthThreshold')
    if (values.followDistance !== undefined) this.settings.followDistance = boundedInteger(values.followDistance, 2, 1, 6, 'followDistance')
    this.paused = false
    return this.status()
  }
  async guarded(promise, signal, ms = 10000, cancel) {
    check(signal)
    const body = this.raw
    cancel ??= () => this.release(body, true)
    let timer
    try {
      return await Promise.race([
        runAbortableOperation(promise, signal, cancel),
        new Promise((_, reject) => { timer = setTimeout(() => { cancel(); reject(Object.assign(new Error(`游戏操作超时（${ms}ms）`), { mcTimeout: true })) }, ms) }),
      ])
    } finally { clearTimeout(timer) }
  }
  async run(label, signal, fn, budgetMs = 180000) {
    check(signal)
    if (this.goals.running && this.goals.job.state !== 'paused' && !this.goals.owns(signal) && !this.pendingReflex) throw new Error('当前后台目标正在控制身体；请先用 mc_goal 暂停或取消')
    if (this.quarantine) throw new Error('被中断的底层操作尚未结算；请等待或重新连接，避免旧动作与新动作重叠')
    if (this.active) throw new Error(`游戏身体正在执行「${this.active.label}」，请等待完成或用 mc_halt 停止`)
    const b = this.bot
    this.release(b, true)
    const controller = new AbortController()
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    const oldSignal = this.host.abortSignal
    const operation = { label, controller, startedAt: Date.now() }
    this.active = operation
    this.paused = false
    this.host.setAbortSignal(combined)
    const timer = setTimeout(() => controller.abort('动作预算耗尽'), budgetMs)
    const onAbort = () => this.release(b, true)
    combined.addEventListener('abort', onAbort, { once: true })
    let settled = false
    const task = Promise.resolve().then(() => { check(combined); return fn(combined, b) })
    void task.then(() => { settled = true }, () => { settled = true })
    try {
      const result = await runAbortableOperation(task, combined, onAbort)
      check(combined)
      this.lastResult = { label, outcome: result?.outcome ?? 'succeeded', durationMs: Date.now() - operation.startedAt }
      return result
    } catch (e) {
      this.lastResult = { label, outcome: combined.aborted ? 'cancelled' : 'failed', error: e.message, durationMs: Date.now() - operation.startedAt }
      throw e
    } finally {
      clearTimeout(timer)
      combined.removeEventListener('abort', onAbort)
      controller.abort('动作结束')
      this.release(b)
      if (!settled) {
        let cleanupTimer
        await Promise.race([task.catch(() => {}), new Promise(resolve => { cleanupTimer = setTimeout(resolve, 250) })])
        clearTimeout(cleanupTimer)
        if (!settled && this.raw === b) {
          this.quarantine = operation
          void task.finally(() => { if (this.quarantine === operation) this.quarantine = null }).catch(() => {})
        }
      }
      this.host.setAbortSignal(oldSignal)
      if (this.active === operation) this.active = null
      if (!this.pendingReflex) this.restoreFollow()
    }
  }

  findPlayer(name) {
    const entry = Object.entries(this.raw?.players ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
    return entry?.entity
  }
  restoreFollow() {
    if (!this.follow || this.busy || this.quarantine || this.paused || this.goals.running || !this.host.online || !this.raw?.pathfinder) return
    const target = this.findPlayer(this.follow)
    if (target) {
      const distance = this.raw.entity.position.distanceTo(target.position)
      if (distance <= this.settings.followDistance) { this.followState.phase = 'nearby'; return }
      const movements = protectMovementsFromFluid(this.raw, new Movements(this.raw))
      movements.canDig = false
      movements.allow1by1towers = false
      this.raw.pathfinder.setMovements(movements)
      this.host._selfMovingAt = Date.now()
      this.raw.pathfinder.setGoal(new goals.GoalFollow(target, this.settings.followDistance), true)
      this.followState.phase = 'following'
      this.followState.lastProgressAt = Date.now()
      this.followState.position = this.raw.entity.position.clone()
      this.metrics.followReplans++
    }
  }
  setFollow(player) {
    if (this.busy || this.quarantine || this.goals.running) throw new Error('当前动作或目标尚未结束，请先停止并等待结算')
    const b = this.bot
    if (typeof player !== 'string' || !player.trim()) throw new Error('需要玩家名称 who')
    if (player.toLowerCase() === b.username?.toLowerCase()) throw new Error('不能跟随自己')
    this.release(b)
    this.follow = player.trim()
    this.followState = { phase: 'waiting', attempts: 0, lastProgressAt: Date.now(), position: b.entity.position.clone() }
    this.paused = false
    this.restoreFollow()
    return { ...this.status(), visible: Boolean(this.findPlayer(this.follow)) }
  }
  async navigate(args, signal) {
    const budget = boundedInteger(args.budgetMs, 30000, 1000, 120000, 'budgetMs')
    return this.run('智能寻路', signal, async (s, b) => {
      const target = args.who ? this.findPlayer(String(args.who))?.position : args
      if (!target || !['x', 'y', 'z'].every(k => Number.isFinite(Number(target[k])))) throw new Error('需要有效坐标，或附近可见玩家 who')
      const range = boundedInteger(args.range, 2, 1, 8, 'range')
      b.pathfinder.setMovements(protectMovementsFromFluid(b, new Movements(b)))
      b.pathfinder.movements.canDig = false
      b.pathfinder.movements.allow1by1towers = false
      this.host._selfMovingAt = Date.now()
      const result = await patchedGoto(b, new goals.GoalNear(Number(target.x), Number(target.y), Number(target.z), range), { signal: s })
      return { ...result, outcome: result.ok ? 'succeeded' : 'partial' }
    }, budget + 500)
  }

  async collect(args, signal) {
    const item = String(args.item ?? '').replace(/^minecraft:/, '')
    if (!item) throw new Error('需要物品名称 item，例如 oak_log 或 cobblestone')
    const quantity = boundedInteger(args.count, 8, 1, 64, 'count')
    const radius = boundedInteger(args.radius, 32, 4, 128, 'radius')
    const budget = boundedInteger(args.budgetMs, 180000, 1000, 300000, 'budgetMs')
    return this.run(`采集 ${item}`, signal, async (s, b) => {
      const before = counts(b)[item] ?? 0
      const names = args.block ? [String(args.block).replace(/^minecraft:/, '')] : item === 'log'
        ? b.registry.blocksArray.filter(block => /^log2?$|_log$|_stem$/.test(block.name) && !block.name.startsWith('stripped_')).map(block => block.name)
        : DROP_SOURCES[item] ?? [item]
      const ids = names.map(name => b.registry.blocksByName[name]?.id).filter(id => id !== undefined)
      if (!ids.length) throw new Error(`当前版本找不到资源方块 ${names.join('/')}`)
      const excluded = new Set()
      let reason = '附近资源不足'
      let broken = 0
      for (let attempt = 0; attempt < quantity * 3 + 8; attempt++) {
        check(s)
        if ((counts(b)[item] ?? 0) - before >= quantity) break
        if ((b.inventory.emptySlotCount?.() ?? 1) === 0) { reason = '背包已满'; break }
        const candidates = b.findBlocks({ matching: ids, maxDistance: radius, count: Math.min(quantity * 3 + 8, 128) }) ?? []
        const target = candidates.map(p => b.blockAt(p)).find(block => block && !excluded.has(block.position.toString()) && !assessExcavationFluidRisk(b, block.position).unsafe)
        if (!target) break
        excluded.add(target.position.toString())
        this.host._selfMovingAt = Date.now()
        try {
          await this.guarded(b.collectBlock.collect(target, { ignoreNoPath: false }), s, 45000)
          check(s)
          const actual = b.blockAt(target.position)
          if (actual && actual.type !== target.type) broken++
          await delay(200, s)
        } catch (e) {
          check(s)
          reason = e.message
          this.host.log(`采集跳过 ${target.name}：`, e.message)
        }
      }
      const gained = Math.max(0, (counts(b)[item] ?? 0) - before)
      return { outcome: gained >= quantity ? 'succeeded' : 'partial', item, requested: quantity, collected: gained, broken, reason: gained >= quantity ? null : reason }
    }, budget)
  }

  craftPlan(args) {
    const b = this.bot
    const item = String(args.item ?? '').replace(/^minecraft:/, '')
    if (!item) throw new Error('需要物品名称 item')
    const preferences = { oak_log: 0, birch_log: 1, spruce_log: 1, acacia_log: 3, dark_oak_log: 3, jungle_log: 3, mangrove_log: 3, cherry_log: 3,
      cobblestone: b.game?.dimension?.includes('nether') ? 10 : 0, blackstone: b.game?.dimension?.includes('nether') ? 0 : 10, cobbled_deepslate: 2 }
    // Nearby known resources influence recipe choice; they are never counted as inventory.
    const woodIds = b.registry.blocksArray.filter(block => /_log$|_stem$/.test(block.name) && !block.name.startsWith('stripped_')).map(block => block.id)
    const seenWood = (b.findBlocks({ matching: woodIds, maxDistance: 24, count: 16 }) ?? []).map(p => b.blockAt(p)?.name).filter(Boolean)
    if (seenWood.length) {
      for (const name of Object.keys(preferences).filter(name => name.endsWith('_log'))) preferences[name] = seenWood.includes(name) ? 0 : 10
    }
    return planInWorker({ version: b.version, item, count: boundedInteger(args.count, 1, 1, 64, 'count'), resourcePreferences: preferences,
      inventory: b.inventory.items().map(entry => ({ name: entry.name, count: entry.count })) })
  }
  async inventoryBarrier(b, signal) {
    const client = b._client
    if (!client?.write || !client?.once) throw new Error('无法确认服务器背包状态')
    check(signal)
    await new Promise((resolve, reject) => {
      let timer
      const finish = error => { clearTimeout(timer); client.off('statistics', done); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve() }
      const done = () => finish()
      const abort = () => finish(new Error('背包确认被中断'))
      client.once('statistics', done)
      signal?.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => finish(new Error('服务器未确认背包状态')), 5000)
      try { client.write('client_command', { actionId: 1 }) } catch (e) { finish(e) }
      if (signal?.aborted) abort()
    })
  }
  async approach(b, block, signal) {
    if (b.entity.position.distanceTo(block.position) <= 3.5) return
    const result = await this.guarded(patchedGoto(b, new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2), { signal }), signal, 20000)
    if (!result.ok) throw new Error(`无法到达 ${block.name}：${result.reason}`)
  }
  async craft(args, signal) {
    const plan = await this.craftPlan(args)
    if (args.planOnly || !plan.recipeAvailable || !plan.canCraftNow) return { outcome: args.planOnly ? 'planned' : 'blocked', plan }
    const budget = boundedInteger(args.budgetMs, 180000, 1000, 300000, 'budgetMs')
    return this.run(`合成 ${plan.targetItem}`, signal, async (s, b) => {
      const beforeTarget = counts(b)[plan.targetItem] ?? 0
      for (const step of plan.steps) {
        check(s)
        const have = counts(b)[step.item] ?? 0
        const need = step.item === plan.targetItem ? step.amount : Math.max(0, step.amount - have)
        if (need <= 0) continue
        if (step.kind === 'smelt') {
          const input = Object.keys(step.ingredients).find(name => name !== 'coal')
          await this.smeltSteps(b, input, step.item, Math.ceil(need / step.outputPerCraft), s)
          continue
        }
        let table = null
        if (step.requiresCraftingTable) {
          table = b.findBlock({ matching: b.registry.blocksByName.crafting_table?.id, maxDistance: 32 })
          if (!table) throw new Error('附近没有工作台，请放置工作台后再合成')
          await this.approach(b, table, s)
        }
        const iterations = Math.ceil(need / step.outputPerCraft)
        const perCraft = Object.fromEntries(Object.entries(step.ingredients).map(([name, n]) => [name, Math.round(n / Math.max(1, step.craftCount ?? Math.ceil(step.amount / step.outputPerCraft)))]))
        for (let index = 0; index < iterations; index++) {
          check(s)
          const recipes = b.recipesFor(b.registry.itemsByName[step.item].id, null, 1, table)
          const recipe = recipes.find(recipe => {
            const used = {}
            for (const delta of recipe.delta ?? []) if (delta.count < 0) {
              const name = b.registry.items[delta.id]?.name
              if (name) used[name] = (used[name] ?? 0) - delta.count
            }
            return Object.keys(used).length === Object.keys(perCraft).length && Object.entries(perCraft).every(([name, n]) => used[name] === n)
          })
          if (!recipe) throw new Error(`找不到与材料计划匹配的 ${step.item} 配方，背包可能已变化`)
          const before = counts(b)[step.item] ?? 0
          await this.guarded(b.craft(recipe, 1, table), s, 15000)
          await this.inventoryBarrier(b, s)
          if ((counts(b)[step.item] ?? 0) - before < step.outputPerCraft) throw new Error(`${step.item} 未得到服务器背包确认`)
        }
      }
      const gained = Math.max(0, (counts(b)[plan.targetItem] ?? 0) - beforeTarget)
      return { outcome: gained >= plan.targetAmount ? 'succeeded' : 'partial', item: plan.targetItem, requested: plan.targetAmount, crafted: gained }
    }, budget)
  }

  async smeltSteps(b, inputName, outputName, quantity, signal) {
    check(signal)
    const furnaceBlock = b.findBlock({ matching: b.registry.blocksByName.furnace?.id, maxDistance: 32 })
    if (!furnaceBlock) throw new Error('附近没有熔炉，请先放置熔炉')
    await this.approach(b, furnaceBlock, signal)
    const furnace = await this.guarded(b.openFurnace(furnaceBlock), signal, 10000)
    try {
      if (furnace.inputItem() || furnace.outputItem() || furnace.fuelItem()) throw new Error('熔炉已有物品；请选用空熔炉，避免混入他人物品')
      const input = b.inventory.items().find(item => item.name === inputName && item.count >= quantity)
      const fuel = b.inventory.items().find(item => item.name === 'coal' && item.count >= Math.ceil(quantity / 8))
      if (!input || !fuel) throw new Error(`需要 ${quantity} 个 ${inputName} 和 ${Math.ceil(quantity / 8)} 个 coal`)
      const before = counts(b)[outputName] ?? 0
      await this.guarded(furnace.putFuel(fuel.type, fuel.metadata, Math.ceil(quantity / 8)), signal)
      check(signal)
      await this.guarded(furnace.putInput(input.type, input.metadata, quantity), signal)
      while ((counts(b)[outputName] ?? 0) - before < quantity) {
        check(signal)
        const output = furnace.outputItem()
        if (output && output.name !== outputName) throw new Error('熔炉输出与计划不符')
        if (output) await this.guarded(furnace.takeOutput(), signal)
        else await delay(200, signal)
      }
      return (counts(b)[outputName] ?? 0) - before
    } finally { try { furnace.close() } catch {} }
  }
  async smelt(args, signal) {
    const output = String(args.item ?? '').replace(/^minecraft:/, '')
    const quantity = boundedInteger(args.count, 1, 1, 64, 'count')
    const b = this.bot
    const id = b.registry.itemsByName[output]?.id
    const inputId = id === undefined ? undefined : smeltInputFor(b.registry, id, recipesSourceFor(b), new Map(Object.entries(counts(b))), quantity)
    const input = inputId === undefined ? undefined : b.registry.items[inputId]?.name
    if (!input) throw new Error(`没有已知熔炼配方：${output}`)
    const budget = boundedInteger(args.budgetMs, Math.min(300000, quantity * 11000 + 20000), 1000, 300000, 'budgetMs')
    return this.run(`熔炼 ${output}`, signal, async (s, b) => ({ outcome: 'succeeded', item: output, smelted: await this.smeltSteps(b, input, output, quantity, s) }), budget)
  }

  async eat(signal) {
    return this.run('进食', signal, async (s, b) => {
      const food = FOOD.map(name => b.inventory.items().find(item => item.name === name)).find(Boolean)
      if (!food) throw new Error('背包中没有支持的食物')
      await this.guarded(b.equip(food, 'hand'), s, 6000)
      check(s)
      await this.guarded(b.consume(), s, 7000)
      return { outcome: 'succeeded', item: food.name, food: b.food }
    }, 15000)
  }
  async surface(signal) {
    return this.run('缺氧上浮', signal, async (s, b) => {
      b.setControlState('jump', true)
      for (let i = 0; i < 50; i++) {
        check(s)
        if ((b.oxygenLevel ?? 0) >= 18) return { outcome: 'succeeded', oxygen: b.oxygenLevel }
        await delay(100, s)
      }
      return { outcome: 'partial', reason: '尚未恢复呼吸，需要安全路线或玩家协助', position: position(b.entity.position) }
    }, 6000)
  }
  nearbyHostiles(radius = 16, name) {
    const b = this.raw
    if (!b?.entity) return []
    return Object.values(b.entities ?? {}).filter(entity => entity && entity.id !== b.entity.id && entity.position
      && entity.type !== 'player' && HOSTILES.has(entity.name)
      && (!name || entity.name === name) && b.entity.position.distanceTo(entity.position) <= radius)
      .sort((a, c) => b.entity.position.distanceTo(a.position) - b.entity.position.distanceTo(c.position))
  }
  visible(entity) {
    const b = this.raw
    if (!b?.world?.raycast) return true
    const from = b.entity.position.offset(0, 1.5, 0), to = entity.position.offset(0, 1, 0)
    const delta = to.minus(from), length = delta.norm()
    try { const hit = b.world.raycast(from, delta.scaled(1 / Math.max(length, 0.001)), length); return !hit || hit.intersect?.distanceTo(from) >= length - 0.3 } catch { return false }
  }
  async retreat(signal) {
    return this.run('紧急撤退', signal, async (s, b) => {
      const enemy = this.nearbyHostiles(16)[0]
      if (!enemy) return { outcome: 'succeeded', reason: '附近没有敌对生物' }
      const origin = b.entity.position, angle = Math.atan2(origin.z - enemy.position.z, origin.x - enemy.position.x)
      let destination
      for (const distance of [6, 4, 8]) {
        for (const turn of [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2]) {
          const target = new Vec3(Math.floor(origin.x + Math.cos(angle + turn) * distance), Math.floor(origin.y), Math.floor(origin.z + Math.sin(angle + turn) * distance))
          const floor = b.blockAt(target.offset(0, -1, 0)), feet = b.blockAt(target), head = b.blockAt(target.offset(0, 1, 0))
          if (floor?.boundingBox === 'block' && !/lava|magma|fire|cactus/.test(floor.name)
            && feet?.boundingBox === 'empty' && head?.boundingBox === 'empty' && !/water|lava|fire/.test(`${feet.name} ${head.name}`)) { destination = target; break }
        }
        if (destination) break
      }
      if (!destination) return { outcome: 'partial', reason: '附近没有已知安全撤退落脚点' }
      b.pathfinder.setMovements(protectMovementsFromFluid(b, new Movements(b)))
      b.pathfinder.movements.canDig = false
      b.pathfinder.movements.allow1by1towers = false
      this.host._selfMovingAt = Date.now()
      const result = await this.guarded(patchedGoto(b, new goals.GoalNear(destination.x, destination.y, destination.z, 1), { signal: s }), s, 8000)
      return { ...result, outcome: result.ok ? 'succeeded' : 'partial' }
    }, 9000)
  }
  async combat(args = {}, signal) {
    const budget = boundedInteger(args.budgetMs, 20000, 1000, 60000, 'budgetMs')
    const radius = boundedInteger(args.radius, 16, 3, 32, 'radius')
    const desired = args.entity ? String(args.entity) : undefined
    if (desired && !HOSTILES.has(desired)) throw new Error('本地战斗只支持敌对生物，不攻击玩家或中立动物')
    return this.run('本地 PvE 战斗', signal, async (s, b) => {
      const movements = protectMovementsFromFluid(b, new Movements(b))
      movements.canDig = false
      movements.allow1by1towers = false
      b.pathfinder.setMovements(movements)
      const weapons = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword', 'netherite_axe', 'diamond_axe', 'iron_axe']
      const weapon = weapons.map(name => b.inventory.items().find(item => item.name === name)).find(Boolean)
      if (weapon) await this.guarded(b.equip(weapon, 'hand'), s, 6000)
      const deadline = Date.now() + budget - 200
      let hits = 0, lastAttack = 0
      while (Date.now() < deadline) {
        check(s)
        if ((b.health ?? 20) <= this.settings.healthThreshold) return { outcome: 'partial', hits, reason: '血量过低，已停止追击，交由撤退控制处理' }
        const enemy = this.nearbyHostiles(radius, desired)[0]
        if (!enemy) return { outcome: 'succeeded', hits, reason: '可见范围内没有指定敌对生物' }
        if (enemy.name === 'creeper' && b.entity.position.distanceTo(enemy.position) < 2.5) return { outcome: 'partial', hits, reason: '苦力怕过近，已停止攻击并建议撤退' }
        const distance = b.entity.position.distanceTo(enemy.position)
        if (distance > 2.8) {
          if (!b.pathfinder.goal || b.pathfinder.goal.entity !== enemy) b.pathfinder.setGoal(new goals.GoalFollow(enemy, 2), true)
          this.host._selfMovingAt = Date.now()
        } else if (this.visible(enemy)) {
          if (b.pathfinder.goal) b.pathfinder.setGoal(null)
          if (typeof b.lookAt === 'function') await this.guarded(b.lookAt(enemy.position.offset(0, 1, 0), false), s, 1500)
          if (Date.now() - lastAttack >= (weapon?.name.endsWith('_axe') ? 1100 : 650)) { b.attack(enemy); lastAttack = Date.now(); hits++ }
        }
        await delay(100, s)
      }
      return { outcome: 'partial', hits, reason: '战斗时间预算结束，请重新观察' }
    }, budget)
  }
  updateFollow(now) {
    if (!this.follow || this.busy || this.goals.running || now - this.lastFollowCheck < 200) return
    this.lastFollowCheck = now
    const b = this.raw, target = this.findPlayer(this.follow), state = this.followState
    if (!target) { if (state.phase !== 'waiting') this.release(b); state.phase = 'waiting'; return }
    const distance = b.entity.position.distanceTo(target.position), stopDistance = this.settings.followDistance
    if (distance <= stopDistance) {
      if (state.phase !== 'nearby') this.release(b)
      state.phase = 'nearby'; state.attempts = 0; state.lastProgressAt = now
      return
    }
    if (state.phase === 'nearby' && distance < stopDistance + 1.2) return
    if (state.phase === 'blocked') {
      if (state.targetPosition && state.targetPosition.distanceTo(target.position) < 2) return
      state.attempts = 0
    }
    if (b.pathfinder.movements) b.pathfinder.movements.allowSprinting = distance > stopDistance + 4
    if (!b.pathfinder.goal || b.pathfinder.goal.entity !== target) this.restoreFollow()
    if (!state.position || state.position.distanceTo(b.entity.position) >= 0.25) {
      state.position = b.entity.position.clone(); state.lastProgressAt = now; state.attempts = 0
    } else if (now - state.lastProgressAt >= 3500) {
      state.attempts++; state.lastProgressAt = now; state.targetPosition = target.position.clone()
      this.release(b)
      if (state.attempts >= 3) {
        state.phase = 'blocked'
        this.host.emit('system', { text: 'DeepSeek 跟随受阻：连续重寻路未前进，已停止反复冲撞，等待玩家移动或新的指令。' })
      } else this.restoreFollow()
    }
    this.host._selfMovingAt = now
  }
  onTick() {
    const b = this.raw
    if (!b || !this.host.online || this.paused || this.quarantine || this.pendingReflex || (b.health ?? 20) <= 0) return
    const now = Date.now()
    if (now >= this.reflexUntil) {
      const lowOxygen = this.settings.autoSurface && b.entity?.isInWater && (b.oxygenLevel ?? 20) <= this.settings.oxygenThreshold
      const hungry = this.settings.autoEat && (b.food ?? 20) <= this.settings.foodThreshold && FOOD.some(name => b.inventory.items().some(item => item.name === name))
      const enemy = this.nearbyHostiles(8)[0]
      const threatened = enemy && (enemy.name === 'creeper' && b.entity.position.distanceTo(enemy.position) < 2.5 || (b.health ?? 20) <= this.settings.healthThreshold)
      const retreat = this.settings.autoRetreat && threatened
      const defend = this.settings.autoDefend && !this.busy && enemy && b.entity.position.distanceTo(enemy.position) <= 2.8 && this.visible(enemy)
      if (lowOxygen || retreat || (hungry && !this.busy) || defend) {
        this.pendingReflex = true
        this.reflexUntil = now + 8000
        if (this.active) { this.metrics.interruptions++; this.active.controller.abort(lowOxygen ? '缺氧危险' : '生命危险') }
        const wait = this.active ? new Promise(resolve => { const timer = setInterval(() => { if (!this.active) { clearInterval(timer); resolve() } }, 10) }) : Promise.resolve()
        const label = lowOxygen ? '缺氧上浮' : retreat ? '低血撤退' : hungry ? '自动进食' : '本地自卫'
        void wait.then(() => this.host.online && !this.paused ? (lowOxygen ? this.surface() : retreat ? this.retreat() : hungry ? this.eat() : this.combat({ budgetMs: 8000, radius: 8 })) : null)
          .then(result => {
            if (result) this.host.emit('system', { text: `DeepSeek 生存反应：${label} ${result.outcome}` })
            if (this.goals.running && (retreat || lowOxygen && result?.outcome !== 'succeeded')) this.goals.suspend()
          })
          .catch(e => this.host.log('生存反应：', e.message))
          .finally(() => { this.pendingReflex = false; this.restoreFollow() })
        return
      }
    }
    this.updateFollow(now)
  }
}
