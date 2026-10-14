import { integer, itemName } from './gameplay-utils.mjs'
import { stripChatAddress } from './chat-intents.mjs'

const RESOURCE_NAMES = {
  '钻石': 'diamond', '钻石矿': 'diamond', '钻石矿石': 'diamond',
  '煤': 'coal', '煤炭': 'coal', '煤矿': 'coal', '铁': 'raw_iron', '铁矿': 'raw_iron', '铁矿石': 'raw_iron',
  '金矿': 'raw_gold', '金矿石': 'raw_gold', '铜矿': 'raw_copper', '铜矿石': 'raw_copper',
  '圆石': 'cobblestone', '石头': 'cobblestone', '原木': 'log', '木头': 'log', '橡木原木': 'oak_log',
  '白桦原木': 'birch_log', '云杉原木': 'spruce_log', '红石': 'redstone', '青金石': 'lapis_lazuli',
}
const CN = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
function quantity(value) {
  if (!value) return 1
  if (/^\d+$/.test(value)) return Number(value)
  if (CN[value]) return CN[value]
  const [tens, units] = value.split('十')
  return value.includes('十') ? (CN[tens] ?? 1) * 10 + (CN[units] ?? 0) : NaN
}
/** Intentionally recognizes only complete, direct requests. Other language goes to the host model. */
export function resourceRequest(text, aliases = []) {
  let value = stripChatAddress(text, aliases)
  if (/不要|别|不用|不能|取消|如果|假如|他说|说过|能不能|是不是|[“”"‘’]/.test(value)) return null
  value = value.replace(/[\s,，:：。.!！?？~～]+/g, '')
  const names = Object.keys(RESOURCE_NAMES).sort((a, b) => b.length - a.length).join('|')
  const match = new RegExp(`^(?:(?:你|请|麻烦|帮我|去|快点|赶紧))*` +
    `(?:挖|挖掘|采集|收集|找|寻找)(?:到|出)?(?:一下|点)?(?:直到(?:找到|给我)|给我)?` +
    `([0-9一二两三四五六七八九十]*)(?:颗|个|块|根|枚)?(${names})(?:给我|带回来|拿回来|回来给我|直到找到)?$`).exec(value)
  if (!match) return null
  const count = quantity(match[1])
  if (!Number.isInteger(count) || count < 1 || count > 64) return null
  return { kind: 'gather', item: RESOURCE_NAMES[match[2]], count, deliver: /给我|带回来|拿回来/.test(value) }
}

export function chooseConcreteResource(bot, item) {
  if (item !== 'log') return itemName(item)
  const woods = bot.registry.blocksArray.filter(b => /^(?:log2?)$|_log$|_stem$/.test(b.name) && !b.name.startsWith('stripped_'))
  const positions = bot.findBlocks?.({ matching: woods.map(b => b.id), maxDistance: 32, count: 16 }) ?? []
  const nearest = positions.map(p => bot.blockAt(p)).filter(Boolean).sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position))[0]
  return nearest?.name ?? (bot.registry.itemsByName.oak_log ? 'oak_log' : 'log')
}

/** A normal gather goal counts the drop, not the block it mines. Keep the
 * explicit mc_goal/mc_collect item APIs for Silk Touch/raw-block requests. */
export function gatheredResource(bot, item) {
  const name = itemName(item), base = name.replace(/^deepslate_/, '')
  const drop = { diamond_ore: 'diamond', coal_ore: 'coal', iron_ore: 'raw_iron', gold_ore: 'raw_gold', copper_ore: 'raw_copper',
    redstone_ore: 'redstone', lapis_ore: 'lapis_lazuli', stone: 'cobblestone', deepslate: 'cobbled_deepslate' }[base]
  return drop && bot.registry.itemsByName[drop] ? drop : name
}

/** High-level task admission, inventory-first planning, evidence and a bounded decision history. */
export class AgentController {
  constructor(skills) { this.skills = skills; this.history = [] }
  record(decision) { this.history.push({ at: Date.now(), ...decision }); if (this.history.length > 16) this.history.shift() }
  status() {
    const bot = this.skills.raw, goal = this.skills.goals.view()
    return { architecture: 'observe → prepare → execute → verify → recover', online: this.skills.host.online,
      task: goal, body: this.skills.active?.label ?? null, health: bot?.health ?? null, food: bot?.food ?? null,
      position: bot?.entity?.position ? { x: Math.floor(bot.entity.position.x), y: Math.floor(bot.entity.position.y), z: Math.floor(bot.entity.position.z) } : null,
      recovery: this.skills.status?.().recovery ?? null,
      decisions: [...this.history], note: '以 task/body/recovery 的实际状态判断是否运行；status 只是观察，不会重新扫描或重启同一个目标。' }
  }
  act(args = {}) {
    const action = args.action ?? 'status'
    if (action === 'status') return this.status()
    if (action === 'pause') return this.skills.goals.suspend()
    if (['resume', 'continue', 'recover'].includes(action)) {
      const goals = this.skills.goals, job = goals.job
      if (!job) throw new Error('没有可继续的原目标，请先说明要完成的任务')
      if (this.skills.quarantine) return { outcome: 'recovering', reused: true, task: goals.view(), recovery: this.skills.status().recovery,
        note: '旧底层动作尚未退出，正在结算或恢复连接；没有恢复执行，不能声称已经重新开始。' }
      if (!goals.running && !['paused', 'blocked', 'failed'].includes(job.state)) throw new Error(`原目标 ${job.state ?? '已结束'}，没有可恢复的任务；取消或成功的目标不能擅自重启`)
      this.skills.follow = null
      if (this.skills.followState) this.skills.followState.phase = 'inactive'
      let task
      if (job.state === 'paused') task = goals.resume()
      else if (goals.running) task = goals.view()
      else if (['blocked', 'failed'].includes(job.state) && typeof goals.retry === 'function') task = goals.retry(args)
      else throw new Error(`原目标 ${job.state ?? '已结束'}，没有可恢复的任务；取消或成功的目标不能擅自重启`)
      this.record({ action: 'continue', id: job.id, kind: job.kind, item: job.item })
      return { outcome: 'started', reused: true, task, note: '继续原目标并解除跟随；以实际执行进展验收，不把启动说成完成。' }
    }
    if (action === 'cancel') { const result = this.skills.halt('用户取消智能体任务'); this.record({ action: 'cancel' }); return result }
    if (action !== 'start') throw new Error('action 为 start/status/pause/resume/continue/recover/cancel')
    const kind = args.kind ?? 'gather', bot = this.skills.bot
    if (kind === 'follow') { const result = this.skills.setFollow(args.who); this.record({ action: 'follow', who: args.who }); return result }
    if (!['gather', 'craft', 'build', 'explore', 'enter'].includes(kind)) throw new Error('kind 为 gather/craft/build/explore/enter/follow')
    const requestedItem = itemName(args.item ?? '')
    const gathered = kind === 'gather' ? gatheredResource(bot, requestedItem) : requestedItem
    const item = kind === 'gather' && gathered === 'log' ? 'log' : chooseConcreteResource(bot, gathered)
    const spec = { ...args, kind: kind === 'gather' ? 'collect' : kind, item,
      budgetMs: integer(args.budgetMs, kind === 'gather' && ['diamond', 'raw_gold', 'redstone', 'lapis_lazuli'].includes(item) ? 1800000 : 600000, 1000, 1800000, 'budgetMs'),
      radius: integer(args.radius, 32, 4, 128, 'radius'),
      useExisting: args.useExisting !== false }
    const current = this.skills.goals.job
    if (current && current.kind === spec.kind && current.item === spec.item
      && kind !== 'build' && current.count === (spec.count ?? 1) && current.deliverTo === (spec.deliverTo ?? null) && current.who === (spec.who ?? null)
      && current.useExisting === spec.useExisting && current.radius === spec.radius
      && ['x', 'y', 'z'].every(k => current.target?.[k] === spec[k])) {
      if (current.state === 'paused' || !this.skills.goals.running && ['blocked', 'failed'].includes(current.state)) return this.act({ action: 'continue', budgetMs: spec.budgetMs })
      if (this.skills.goals.running) return { ...this.status(), outcome: 'started', reused: true, note: '相同目标已经运行，继续原计划，不重复启动。' }
    }
    const task = this.skills.goals.start(spec)
    this.record({ action: 'start', kind, item: spec.item, count: spec.count ?? 1, deliverTo: spec.deliverTo ?? null,
      rationale: kind === 'gather' ? '先检查已有物品及工具，再寻找资源；缺资源时继续探索或安全下矿，最后验证库存与交接。' : '用持续目标执行，并以实际世界状态验收。' })
    return { outcome: 'started', task, plan: this.history.at(-1).rationale, note: '已启动实际后台任务；未完成前不能宣称物品已取得或已经进入房间。' }
  }
}
