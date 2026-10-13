import { randomUUID } from 'node:crypto'
import vec3pkg from 'vec3'
const Vec3 = vec3pkg.Vec3 ?? vec3pkg
const vec = p => new Vec3(p.x, p.y, p.z)

const countItem = (bot, name) => (bot.inventory?.items?.() ?? []).filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0)
const TOOL_FOR = { cobblestone: 'wooden_pickaxe', cobbled_deepslate: 'wooden_pickaxe', blackstone: 'wooden_pickaxe', coal: 'wooden_pickaxe', raw_iron: 'stone_pickaxe', raw_copper: 'stone_pickaxe', raw_gold: 'iron_pickaxe', diamond: 'iron_pickaxe' }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Deterministic goal execution in the existing session; the host AI remains the planner. */
export class TaskGoals {
  constructor(skills) { this.skills = skills; this.job = null; this.executing = false; this.explored = new Set() }
  get running() { return this.executing }
  owns(signal) { return this.executing && signal === this.job?.controller.signal }
  view() {
    if (!this.job) return null
    const { id, kind, item, count, state, phase, startedAt, finishedAt, result, error, progress } = this.job
    return { id, kind, item, count, state, phase, startedAt, finishedAt: finishedAt ?? null, result: result ?? null, error: error ?? null, progress: { ...progress } }
  }
  cancel(reason = '用户取消目标') {
    if (this.executing) { this.job.state = 'cancelled'; this.job.controller.abort(reason) }
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
    if (!['craft', 'collect', 'build', 'explore'].includes(kind)) throw new Error('kind 必须是 craft、collect、build 或 explore')
    const item = String(args.item ?? '').replace(/^minecraft:/, '')
    const count = args.count ?? 1
    const budget = args.budgetMs ?? 300000
    if (!Number.isInteger(count) || count < 1 || count > 64) throw new Error('count 必须为 1–64')
    if (!Number.isInteger(budget) || budget < 1000 || budget > 600000) throw new Error('budgetMs 必须为 1000–600000')
    const radius = args.radius ?? 32
    if (!Number.isInteger(radius) || radius < 4 || radius > 128) throw new Error('radius 必须为 4–128')
    if (['craft', 'collect'].includes(kind) && !bot.registry.itemsByName[item]) throw new Error('需要当前游戏版本有效的目标物品 item')
    if (kind === 'explore' && count > 16) throw new Error('一次探索最多 16 个落脚点')
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
    const job = { id: randomUUID(), kind, item, count, radius, blocks, deliverTo, controller, state: 'running', phase: 'planning', startedAt: Date.now(), progress: { completed: 0, total: kind === 'build' ? blocks.length : count } }
    this.job = job
    this.executing = true
    this.skills.paused = false
    this.skills.release()
    const timer = setTimeout(() => { job.error = '目标时间预算耗尽'; controller.abort(job.error) }, budget)
    job.done = this.execute(job).then(result => {
      job.result = result; job.state = controller.signal.aborted ? 'cancelled' : result.outcome === 'succeeded' ? 'succeeded' : 'blocked'
    }, error => {
      if (controller.signal.aborted) job.state = job.error ? 'failed' : 'cancelled'
      else { job.state = 'blocked'; job.error = error.message }
    }).finally(() => {
      clearTimeout(timer)
      job.finishedAt = Date.now()
      this.executing = false
      this.skills.restoreFollow()
      this.skills.host.emit('system', { text: `DeepSeek 游戏目标 ${job.kind}：${job.state}${job.error ? `，${job.error}` : ''}。可用 mc_goal 查看结果。` })
    })
    return this.view()
  }
  async ready(job) {
    while (job.state === 'paused' || this.skills.pendingReflex || this.skills.busy) {
      job.controller.signal.throwIfAborted()
      await pause(50)
    }
    job.controller.signal.throwIfAborted()
    if (this.skills.quarantine) throw new Error('旧身体动作尚未结算，需要等待或重连')
    if (!this.skills.host.online) throw new Error('服务器连接已经结束')
  }
  async step(job, phase, fn) {
    for (let attempts = 0; attempts < 3; attempts++) {
      await this.ready(job)
      job.phase = phase
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
    if (countItem(bot, item) >= total) return
    if (ancestry.includes(item) || ancestry.length >= 12) throw new Error(`资源依赖无法自动解决：${[...ancestry, item].join(' → ')}`)
    const chain = [...ancestry, item]
    for (let pass = 0; pass < 12 && countItem(bot, item) < total; pass++) {
      await this.ready(job)
      const need = Math.min(64, total - countItem(bot, item))
      const plan = await this.skills.craftPlan({ item, count: need })
      await this.ready(job)
      if (!plan.recipeAvailable) {
        const tool = TOOL_FOR[item]
        if (tool && !bot.inventory.items().some(entry => /pickaxe$/.test(entry.name) && (tool === 'wooden_pickaxe' || tool === 'stone_pickaxe' && /stone|iron|diamond|netherite/.test(entry.name) || tool === 'iron_pickaxe' && /iron|diamond|netherite/.test(entry.name)))) {
          await this.ensure(job, tool, 1, chain)
        }
        const result = await this.step(job, `采集 ${item}`, signal => this.skills.collect({ item, count: need, radius: job.radius }, signal))
        if (!result.collected) throw new Error(`${item} 无法采集：${result.reason}`)
      } else {
        for (const [resource, amount] of Object.entries(plan.missing)) {
          // Hiyori normalizes wood shortages into material families. Resolve
          // those back to the concrete ingredients selected by this plan.
          const concrete = resource === 'log' && !bot.registry.itemsByName.log
            ? Object.keys(plan.totalRequired).find(name => /_log$|_wood$|_stem$|_hyphae$/.test(name))
              ?? plan.steps.flatMap(step => Object.keys(step.ingredients)).find(name => /_log$|_wood$|_stem$|_hyphae$/.test(name))
              ?? 'oak_log'
            : resource
          await this.ensure(job, concrete, countItem(bot, concrete) + amount, chain)
        }
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
    if (job.kind === 'collect') {
      const before = countItem(bot, job.item)
      const result = await this.step(job, `采集 ${job.item}`, signal => {
        const remaining = job.count - (countItem(bot, job.item) - before)
        return remaining <= 0 ? { outcome: 'succeeded' } : this.skills.collect({ item: job.item, count: remaining, radius: job.radius }, signal)
      })
      job.progress.completed = Math.max(0, countItem(bot, job.item) - before)
      const delivery = job.deliverTo ? await this.deliver(job, Math.min(job.count, job.progress.completed)) : null
      return { ...result, collected: job.progress.completed, delivery }
    }
    if (job.kind === 'craft') {
      const before = countItem(bot, job.item)
      await this.ensure(job, job.item, before + job.count)
      job.progress.completed = countItem(bot, job.item) - before
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
      job.progress.completed++
    }
    return { outcome: 'succeeded', placedOrVerified: job.progress.completed, total: job.blocks.length }
  }
  async deliver(job, amount) {
    if (amount <= 0) return null
    const bot = this.skills.bot
    const target = this.skills.findPlayer(job.deliverTo)
    if (!target) throw new Error(`资源已准备，但玩家 ${job.deliverTo} 暂时不可见，尚未交接`)
    if (bot.entity.position.distanceTo(target.position) > 2.5) {
      const navigation = await this.step(job, `走向 ${job.deliverTo}`, signal => this.skills.navigate({ who: job.deliverTo, range: 2 }, signal))
      if (!navigation.ok) throw new Error(`资源已准备，但无法接近 ${job.deliverTo}`)
    }
    if (!this.skills.findPlayer(job.deliverTo) || bot.entity.position.distanceTo(this.skills.findPlayer(job.deliverTo).position) > 3) throw new Error('交接玩家已离开，保留背包物品')
    return this.step(job, '物品交接', signal => this.skills.run('物品交接', signal, async () => {
      const before = countItem(bot, job.item)
      await this.skills.host.tossItem({ name: job.item, count: amount })
      const dropped = before - countItem(bot, job.item)
      if (dropped < amount) throw new Error('物品投掷未得到库存变化确认')
      return { player: job.deliverTo, dropped, note: '已在玩家附近投出；不等同于已确认玩家拾取' }
    }, 15000))
  }
  async explore(job) {
    const bot = this.skills.bot
    const visited = []
    for (let step = 0; step < job.count; step++) {
      await this.ready(job)
      const origin = bot.entity.position.floored()
      let reached = false
      const directionOffset = this.explored.size
      for (let direction = 0; direction < 8 && !reached; direction++) {
        const angle = ((direction + directionOffset) % 8) * Math.PI / 4
        const distance = Math.min(job.radius, 12)
        const x = Math.floor(origin.x + Math.cos(angle) * distance), z = Math.floor(origin.z + Math.sin(angle) * distance)
        const key = `${JSON.stringify(this.skills.host.connectionView())}:${bot.game?.dimension}:${Math.floor(x / 4)},${Math.floor(z / 4)}`
        if (this.explored.has(key)) continue
        let target
        for (const dy of [0, -1, 1, -2, 2]) {
          const p = new Vec3(x, origin.y + dy, z), floor = bot.blockAt(p.offset(0, -1, 0)), feet = bot.blockAt(p), head = bot.blockAt(p.offset(0, 1, 0))
          if (floor?.boundingBox === 'block' && !/magma|lava|fire|cactus/.test(floor.name) && feet?.boundingBox === 'empty' && head?.boundingBox === 'empty'
            && !/lava|water|fire/.test(`${feet.name} ${head.name}`)) { target = p; break }
        }
        if (!target) continue
        this.explored.add(key)
        if (this.explored.size > 256) this.explored.delete(this.explored.values().next().value)
        const result = await this.step(job, `探索 ${step + 1}/${job.count}`, signal => this.skills.navigate(target, signal))
        if (result.ok) { reached = true; visited.push({ x: target.x, y: target.y, z: target.z }); job.progress.completed++ }
      }
      if (!reached) return { outcome: 'partial', visited, reason: '附近没有新的已加载安全落脚点或路径不可达，请重新观察' }
    }
    return { outcome: 'succeeded', visited, dimension: bot.game?.dimension ?? null }
  }
}
