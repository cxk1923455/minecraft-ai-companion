import { randomUUID } from 'node:crypto'
import vec3pkg from 'vec3'
import { ResourceExpedition } from './resource-expedition.mjs'
import { playerInReach } from './player-navigation.mjs'
import { acceptsAnyWood, materialCount, materialForDelivery } from './material-supply.mjs'
const Vec3 = vec3pkg.Vec3 ?? vec3pkg
const vec = p => new Vec3(p.x, p.y, p.z)

const countItem = materialCount
const TOOL_FOR = { cobblestone: 'wooden_pickaxe', cobbled_deepslate: 'wooden_pickaxe', blackstone: 'wooden_pickaxe', coal: 'wooden_pickaxe', raw_iron: 'stone_pickaxe', raw_copper: 'stone_pickaxe', raw_gold: 'iron_pickaxe', diamond: 'iron_pickaxe', redstone: 'iron_pickaxe', lapis_lazuli: 'stone_pickaxe' }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Deterministic goal execution in the existing session; the host AI remains the planner. */
export class TaskGoals {
  constructor(skills) { this.skills = skills; this.job = null; this.executing = false; this.explored = new Set(); this.expedition = new ResourceExpedition(skills, this) }
  get running() { return this.executing }
  get pending() { return Boolean(this.job && ['running', 'paused', 'blocked', 'failed', 'recovering'].includes(this.job.state)) }
  owns(signal) { return this.executing && signal === this.job?.controller.signal }
  view() {
    if (!this.job) return null
    const { id, kind, item, count, state, phase, startedAt, finishedAt, result, error, progress, plan, deadline, who, deliverTo, requestedBy, retries } = this.job
    return { id, kind, item, count, state, phase, who, deliverTo, requestedBy, retries: retries ?? 0, plan, startedAt, deadline, finishedAt: finishedAt ?? null, result: result ?? null, error: error ?? null, progress: { ...progress } }
  }
  cancel(reason = '用户取消目标') {
    if (this.pending) { this.job.state = 'cancelled'; this.job.controller.abort(reason) }
    return this.view()
  }
  suspend() {
    if (!this.executing) throw new Error('没有正在执行的目标')
    this.job.state = 'paused'
    this.skills.active?.controller.abort('目标暂停')
    return this.view()
  }
  resume() {
    if (!this.executing || this.job.state !== 'paused') throw new Error('没有已暂停的目标')
    this.job.state = 'running'
    this.skills.paused = false
    return this.view()
  }
  start(args = {}) {
    if (this.executing || this.skills.busy || this.skills.quarantine) throw new Error('当前目标或身体动作尚未结束，请先暂停/取消并等待结算')
    const bot = this.skills.bot
    const kind = args.kind
    if (!['craft', 'collect', 'build', 'explore', 'enter'].includes(kind)) throw new Error('kind 必须是 craft、collect、build、explore 或 enter')
    const item = String(args.item ?? '').replace(/^minecraft:/, '')
    const count = args.count ?? 1
    const budget = args.budgetMs ?? (kind === 'collect' && ['diamond', 'raw_gold', 'redstone', 'lapis_lazuli'].includes(item) ? 1800000 : 600000)
    if (!Number.isInteger(count) || count < 1 || count > 64) throw new Error('count 必须为 1–64')
    if (!Number.isInteger(budget) || budget < 1000 || budget > 1800000) throw new Error('budgetMs 必须为 1000–1800000')
    const radius = args.radius ?? 32
    if (!Number.isInteger(radius) || radius < 4 || radius > 128) throw new Error('radius 必须为 4–128')
    if (['craft', 'collect'].includes(kind) && !bot.registry.itemsByName[item] && !(kind === 'collect' && item === 'log')) throw new Error('需要当前游戏版本有效的目标物品 item')
    if (kind === 'explore' && count > 16) throw new Error('一次探索最多 16 个落脚点')
    const who = args.who === undefined ? null : String(args.who).trim()
    if (kind === 'enter' && !who && !['x', 'y', 'z'].every(key => Number.isFinite(args[key]))) throw new Error('进入房间需要 who 或完整 x/y/z 目标')
    const deliverTo = args.deliverTo === undefined ? null : String(args.deliverTo).trim()
    if (deliverTo !== null && (!deliverTo || !['craft', 'collect'].includes(kind))) throw new Error('deliverTo 只用于采集/制作目标，且需要玩家名')
    let blocks
    if (kind === 'build') {
      if (!Array.isArray(args.blocks) || !args.blocks.length || args.blocks.length > 256) throw new Error('blocks 必须包含 1–256 个方块')
      const seen = new Set()
      blocks = args.blocks.map(block => {
        if (!block || !['x', 'y', 'z'].every(key => Number.isInteger(block[key]) && Math.abs(block[key]) <= 30000000)) throw new Error('蓝图坐标必须为合法整数')
        const name = String(block.name ?? item).replace(/^minecraft:/, '')
        if (!bot.registry.blocksByName[name] || !bot.registry.itemsByName[name]) throw new Error(`不支持的建筑材料：${name}`)
        const key = `${block.x},${block.y},${block.z}`
        if (seen.has(key)) throw new Error(`蓝图坐标重复：${key}`)
        seen.add(key)
        return { x: block.x, y: block.y, z: block.z, name }
      }).sort((a, b) => a.y - b.y)
    }
    const controller = new AbortController()
    const startedAt = Date.now()
    const plan = kind === 'collect' ? ['检查库存', '准备工具与补给', '寻找资源/探索/安全下矿', '采集并验证', ...(deliverTo ? ['接近玩家并交接'] : [])]
      : kind === 'enter' ? ['识别门与门内落脚点', '开门并穿过', '确认在目标一侧'] : ['观察材料与地形', '准备', '执行', '验证']
    const job = { id: randomUUID(), kind, item, count, radius, blocks, deliverTo, who, target: { x: args.x, y: args.y, z: args.z }, useExisting: args.useExisting === true,
      origin: bot.entity.position.clone(), body: bot, dimension: bot.game?.dimension, requestedBy: args.requestedBy ?? null, budgetMs: budget, retries: 0,
      plan, deadline: startedAt + budget, controller, state: 'running', phase: 'planning', startedAt, progress: { completed: 0, total: kind === 'build' ? blocks.length : count } }
    this.job = job
    this.launch(job, budget)
    return this.view()
  }
  retry(args = {}) {
    const job = this.job
    if (!job || !['blocked', 'failed'].includes(job.state) || this.executing) throw new Error('没有可继续的受阻目标')
    if (this.skills.busy || this.skills.quarantine) throw new Error('旧身体动作还在结算，请稍后继续')
    if (job.body !== this.skills.bot || job.dimension !== this.skills.bot.game?.dimension) throw new Error('旧目标属于不同身体或维度，需重新明确目标')
    const budget = args.budgetMs ?? job.budgetMs ?? 600000
    if (!Number.isInteger(budget) || budget < 1000 || budget > 1800000) throw new Error('budgetMs 必须为 1000–1800000')
    job.retries++; job.previousError = job.error; job.error = null; job.result = null; job.finishedAt = null
    job.controller = new AbortController(); job.state = 'running'; job.phase = 'recovering'; job.deadline = Date.now() + budget
    this.expedition.resetFailures(job)
    this.launch(job, budget)
    return { ...this.view(), reused: true }
  }
  launch(job, budget) {
    this.executing = true
    this.skills.paused = false
    this.skills.release()
    const controller = job.controller
    const timer = setTimeout(() => { job.error = '目标时间预算耗尽'; controller.abort(job.error) }, budget)
    job.done = this.execute(job).then(result => {
      job.result = result; job.state = controller.signal.aborted ? (job.error ? 'failed' : 'cancelled') : result.outcome === 'succeeded' ? 'succeeded' : 'blocked'
    }, error => {
      if (controller.signal.aborted) job.state = job.error ? 'failed' : 'cancelled'
      else { job.state = 'blocked'; job.error = error.message }
    }).finally(() => {
      clearTimeout(timer)
      job.finishedAt = Date.now()
      this.executing = false
      if (this.pending) { this.skills.release(); if (this.skills.followState) this.skills.followState.phase = 'task-blocked' }
      else this.skills.restoreFollow()
      this.skills.host.emit('goalResult', { id: job.id, kind: job.kind, item: job.item, count: job.count, who: job.who, deliverTo: job.deliverTo, state: job.state, phase: job.phase,
        progress: { ...job.progress }, result: job.result ?? null, error: job.error ?? null })
      this.skills.host.emit('system', { text: `DeepSeek 游戏目标 ${job.kind}：${job.state}${job.error ? `，${job.error}` : ''}。可用 mc_goal 查看结果。` })
    })
  }
  async ready(job) {
    while (job.state === 'paused' || this.skills.pendingReflex || this.skills.busy || this.skills.quarantine) {
      job.controller.signal.throwIfAborted()
      if (!this.skills.host.online) throw new Error('服务器连接已经结束')
      if (this.skills.bodyRecovery?.state === 'reconnectRequired') throw new Error(this.skills.bodyRecovery.reason ?? '旧动作无法结束，需要重新连接游戏身体')
      await pause(50)
    }
    job.controller.signal.throwIfAborted()
    if (!this.skills.host.online) throw new Error('服务器连接已经结束')
  }
  async step(job, phase, fn) {
    for (let attempts = 0; attempts < 3; attempts++) {
      await this.ready(job)
      job.phase = phase
      if (phase !== job.lastReportedPhase && Date.now() - (job.lastReportedAt ?? 0) > 15000) {
        job.lastReportedPhase = phase; job.lastReportedAt = Date.now()
        this.skills.host.emit('goalProgress', { id: job.id, kind: job.kind, phase, progress: { ...job.progress }, state: job.state })
      }
      try { return await fn(job.controller.signal) }
      catch (error) {
        job.controller.signal.throwIfAborted()
        if (job.state === 'paused' || this.skills.pendingReflex) continue
        throw error
      }
    }
    throw new Error('多次生存中断后目标尚未恢复，请重新观察')
  }
  async ensure(job, item, total, ancestry = []) {
    await this.ready(job)
    const bot = this.skills.bot
    if (total - countItem(bot,item) > 64) {
      while (countItem(bot,item) < total) {
        const before = countItem(bot,item)
        await this.ensure(job,item,Math.min(total,before+64),ancestry)
        if (countItem(bot,item) <= before) throw new Error(`批次备料没有进展：${item}`)
      }
      return
    }
    if (countItem(bot, item) >= total) return
    if (ancestry.includes(item) || ancestry.length >= 12) throw new Error(`资源依赖无法自动解决：${[...ancestry, item].join(' → ')}`)
    const chain = [...ancestry, item]
    for (let pass = 0; pass < 24 && countItem(bot, item) < total; pass++) {
      await this.ready(job)
      const need = Math.min(64, total - countItem(bot, item))
      // Resources may also have reversible storage recipes (diamond/coal blocks).
      // Those recipes cannot create an initial resource supply; obtain it in the world.
      if (TOOL_FOR[item] || /^(?:log2?)$|_log$|_stem$/.test(item) || ['dirt', 'sand', 'gravel', 'clay_ball'].includes(item)) {
        const tool = TOOL_FOR[item]
        if (tool && !bot.inventory.items().some(entry => /pickaxe$/.test(entry.name) && (tool === 'wooden_pickaxe' || tool === 'stone_pickaxe' && /stone|iron|diamond|netherite/.test(entry.name) || tool === 'iron_pickaxe' && /iron|diamond|netherite/.test(entry.name)))) await this.ensure(job, tool, 1, chain)
        const result = await this.expedition.obtain(job, item, total, chain)
        if (countItem(bot, item) < total) throw new Error(`${item} 尚未取得：${result.reason ?? '探索或采矿预算耗尽'}`)
        continue
      }
      const plan = await this.skills.craftPlan({ item, count: need }, job.controller.signal)
      await this.ready(job)
      if (!plan.recipeAvailable) {
        const tool = TOOL_FOR[item]
        if (tool && !bot.inventory.items().some(entry => /pickaxe$/.test(entry.name) && (tool === 'wooden_pickaxe' || tool === 'stone_pickaxe' && /stone|iron|diamond|netherite/.test(entry.name) || tool === 'iron_pickaxe' && /iron|diamond|netherite/.test(entry.name)))) {
          await this.ensure(job, tool, 1, chain)
        }
        const result = await this.expedition.obtain(job, item, total, chain)
        if (countItem(bot, item) < total) throw new Error(`${item} 尚未取得：${result.reason ?? '探索或采矿预算耗尽'}`)
      } else {
        for (const [resource, amount] of Object.entries(plan.missing)) {
          if (resource === 'log' && acceptsAnyWood(item)) {
            await this.ensure(job, 'log', countItem(bot, 'log') + amount, chain)
            // Recompute concrete plank recipes from the species actually found.
            // A birch forest must not leave a generic pickaxe waiting for oak.
            break
          }
          // Hiyori normalizes wood shortages into material families. Resolve
          // those back to the concrete ingredients selected by this plan.
          const concrete = resource === 'log' && !bot.registry.itemsByName.log
            ? Object.keys(plan.totalRequired).find(name => /_log$|_wood$|_stem$|_hyphae$/.test(name))
              ?? plan.steps.flatMap(step => Object.keys(step.ingredients)).find(name => /_log$|_wood$|_stem$|_hyphae$/.test(name))
              ?? 'oak_log'
            : resource
          await this.ensure(job, concrete, countItem(bot, concrete) + amount, chain)
        }
        if (plan.missing.log && acceptsAnyWood(item)) continue
        if (plan.requiresCraftingTable && !bot.findBlock({ matching: bot.registry.blocksByName.crafting_table?.id, maxDistance: 32 })) {
          await this.ensure(job, 'crafting_table', 1, chain)
          await this.placeStation(job, 'crafting_table')
        }
        if (plan.steps.some(step => step.kind === 'smelt') && !bot.findBlock({ matching: bot.registry.blocksByName.furnace?.id, maxDistance: 32 })) {
          await this.ensure(job, 'furnace', 1, chain)
          await this.placeStation(job, 'furnace')
        }
        const result = await this.step(job, `制作 ${item}`, signal => this.skills.craft({ item, count: Math.min(64, total - countItem(bot, item)) }, signal))
        if (!['succeeded', 'partial'].includes(result.outcome) && !Object.keys(result.plan?.missing ?? {}).length) throw new Error(`${item} 尚未完成：${JSON.stringify(result.plan?.missing ?? {})}`)
      }
    }
    if (countItem(bot, item) < total) throw new Error(`${item} 在有限规划轮次内未完成`)
  }
  async placeStation(job, name) {
    const bot = this.skills.bot, origin = bot.entity.position.floored()
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [0, 2]]) {
      const target = origin.offset(dx, 0, dz), block = bot.blockAt(target), below = bot.blockAt(target.offset(0, -1, 0))
      if (block?.boundingBox === 'empty' && below?.boundingBox === 'block') {
        await this.step(job, `放置 ${name}`, signal => this.skills.run(`放置 ${name}`, signal, () => this.skills.host.placeBlock({ ...target, name }), 30000))
        return
      }
    }
    throw new Error(`附近没有安全位置放置 ${name}`)
  }
  async execute(job) {
    const bot = this.skills.bot
    if (job.delivery?.pending) await this.step(job, '核对暂停前的物品交接', signal => this.skills.run('交接恢复验收', signal, (s, b) => this.settleDelivery(job, b, s), 6000))
    if (job.kind === 'collect') {
      const before = job.collectionStart ??= countItem(bot, job.item)
      const originalTarget = job.collectionTarget ??= job.useExisting ? Math.max(before, job.count) : before + job.count
      const alreadyDelivered = job.delivery?.dropped ?? 0
      const target = Math.max(0, originalTarget - alreadyDelivered)
      const result = await this.expedition.obtain(job, job.item, target)
      const collected = Math.max(0, countItem(bot, job.item) + alreadyDelivered - before)
      job.progress.completed = job.useExisting ? Math.min(job.count, countItem(bot, job.item) + alreadyDelivered) : collected
      const delivery = job.deliverTo ? await this.deliver(job, Math.min(job.count, job.progress.completed)) : null
      return { ...result, outcome: job.progress.completed >= job.count ? 'succeeded' : 'partial', collected, supplied: job.progress.completed, delivery }
    }
    if (job.kind === 'enter') return this.step(job, '开门进入房间并核验', signal => this.skills.enter({ who: job.who, ...job.target, budgetMs: Math.min(120000, job.deadline - Date.now()) }, signal))
    if (job.kind === 'craft') {
      const before = job.collectionStart ??= countItem(bot, job.item)
      const originalTarget = job.collectionTarget ??= before + job.count
      await this.ensure(job, job.item, originalTarget - (job.delivery?.dropped ?? 0))
      job.progress.completed = countItem(bot, job.item) + (job.delivery?.dropped ?? 0) - before
      const delivery = job.deliverTo ? await this.deliver(job, job.count) : null
      return { outcome: 'succeeded', item: job.item, produced: job.progress.completed, delivery }
    }
    if (job.kind === 'explore') return this.explore(job)
    const needed = {}
    for (const block of job.blocks) {
      const current = bot.blockAt(vec(block))
      if (current?.name === block.name) continue
      if (!current || current.boundingBox !== 'empty') throw new Error(`建筑位置未加载或已被占用：${block.x},${block.y},${block.z}`)
      needed[block.name] = (needed[block.name] ?? 0) + 1
    }
    for (const [item, quantity] of Object.entries(needed)) await this.ensure(job, item, quantity)
    for (const block of job.blocks) {
      await this.ready(job)
      if (bot.blockAt(vec(block))?.name !== block.name) {
        await this.step(job, `建造 ${job.progress.completed + 1}/${job.blocks.length}`, signal => this.skills.run('蓝图建造', signal, async s => {
          await this.skills.approach(bot, { name: block.name, position: vec(block) }, s)
          await this.skills.host.placeBlock(block)
          if (bot.blockAt(vec(block))?.name !== block.name) throw new Error('方块未通过世界状态验证')
        }, 45000))
      }
      job.verifiedBlocks ??= new Set()
      job.verifiedBlocks.add(`${block.x},${block.y},${block.z}`)
      job.progress.completed = job.verifiedBlocks.size
    }
    return { outcome: 'succeeded', placedOrVerified: job.progress.completed, total: job.blocks.length }
  }
  async deliver(job, amount) {
    if (amount <= 0) return null
    const bot = this.skills.bot
    let target = this.skills.findPlayer(job.deliverTo)
    if (!target && job.origin && bot.entity.position.distanceTo(job.origin) > 3) {
      const returnPath = await this.step(job, '返回接任务的位置寻找交接玩家', signal => this.skills.navigate({ ...job.origin, range: 1, budgetMs: 120000 }, signal))
      if (!returnPath.ok) throw new Error('资源已准备，但尚未沿原路线返回；物品保留在背包')
      target = this.skills.findPlayer(job.deliverTo)
    }
    if (!target) throw new Error(`资源已准备，但玩家 ${job.deliverTo} 暂时不可见，尚未交接`)
    if (!playerInReach(bot, target, 2.5)) {
      const navigation = await this.step(job, `走向 ${job.deliverTo}`, signal => this.skills.navigate({ who: job.deliverTo, range: 2, budgetMs: 120000 }, signal))
      if (!navigation.ok) throw new Error(`资源已准备，但无法接近 ${job.deliverTo}`)
    }
    if (!playerInReach(bot, this.skills.findPlayer(job.deliverTo), 3)) throw new Error('交接玩家已离开或被门墙隔开，保留背包物品')
    const delivery = job.delivery ??= { player: job.deliverTo, requested: amount, dropped: 0, pending: null }
    delivery.requested = Math.min(job.count ?? amount, Math.max(delivery.requested, amount))
    return this.step(job, '物品交接', signal => this.skills.run('物品交接', signal, async (s, b) => {
      const settle = () => this.settleDelivery(job, b, s)
      // A paused toss can settle while the body is quarantined. Verify it before
      // sending another stack so resuming never repeats an already sent amount.
      await settle()
      while (delivery.dropped < delivery.requested) {
        s.throwIfAborted()
        if (!playerInReach(b, this.skills.findPlayer(job.deliverTo), 3)) throw new Error('交接玩家已移动或被门墙隔开，保留未交出的物品')
        const remaining = delivery.requested - delivery.dropped
        if (countItem(b, job.item) < remaining) throw new Error('尚未交接的物品不足，已投出数量可在进度中查看')
        const name = materialForDelivery(b, job.item), stack = b.inventory.items().find(item => item.name === name)
        const sent = Math.min(remaining, stack?.count ?? remaining)
        delivery.pending = { before: countItem(b, job.item), name, maxSent: sent }
        await this.skills.guarded(this.skills.host.tossItem({ name, count: sent }), s, 10000)
        await settle()
      }
      return { player: job.deliverTo, dropped: delivery.dropped, note: '已在玩家附近投出；不等同于已确认玩家拾取' }
    }, 45000))
  }
  async settleDelivery(job, bot, signal) {
    const delivery = job.delivery
    if (!delivery?.pending) return
    await this.skills.inventoryBarrier(bot, signal)
    const delta = Math.min(delivery.pending.maxSent ?? Infinity, delivery.pending.before - countItem(bot, job.item))
    delivery.pending = null
    if (delta <= 0) throw new Error('物品投掷未得到库存变化确认')
    delivery.dropped += Math.min(delta, delivery.requested - delivery.dropped)
    job.progress.delivery = { player: delivery.player, dropped: delivery.dropped, requested: delivery.requested }
  }
  async explore(job) {
    const visited = job.visited ??= []
    for (let step = job.progress.completed; step < job.count; step++) {
      await this.ready(job)
      const result = await this.expedition.terrain.advance(job, { purpose: 'resource' })
      if (!result.moved) return { outcome: 'partial', visited, reason: result.reason, recoverable: true }
      visited.push(result.position); job.progress.completed++
    }
    return { outcome: 'succeeded', visited, dimension: this.skills.bot.game?.dimension ?? null }
  }
}
