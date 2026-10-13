export const name = 'Hiyori 生存技能'

export function apply({ ctx, asTool, getSession, logLine }) {
  const output = { schema: { type: 'object', properties: {}, additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }
  const register = (name, description, parameters, execute, timeoutMs = 310000) => ctx.tools.register(asTool({
    name, description, parameters, output, timeoutMs,
    execute: (args, exec) => execute(getSession(exec).bot.skills, args, exec?.signal),
  }))
  register('mc_survival', '查询真实位置、follow.distance、verifiedNearby、当前动作、后台目标和本地决策耗时；确认在玩家身边前必须检查实际距离。可设置自动进食、上浮、自卫和撤退。只用当前会话的机器人，省略参数只查询。', {
    autoEat: { type: 'boolean' }, autoSurface: { type: 'boolean' }, autoRetreat: { type: 'boolean' }, autoDefend: { type: 'boolean' }, foodThreshold: { type: 'integer' }, oxygenThreshold: { type: 'integer' }, healthThreshold: { type: 'integer' }, followDistance: { type: 'integer' },
  }, (skills, args) => Object.keys(args).length ? skills.configure(args) : skills.status())
  register('mc_halt', '立即停止当前 Minecraft 动作与持续跟随，保持游戏连接；暂停自动生存动作。随后调用新动作或 mc_survival 设置可恢复。', {}, skills => skills.halt(), 10000)
  register('mc_pathfind', 'A* 生存寻路到坐标或可见玩家，绕障碍；不飞行、不自动挖路。返回真实到达结果和失败原因。', {
    x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, who: { type: 'string' }, range: { type: 'integer' }, budgetMs: { type: 'integer' },
  }, (skills, args, signal) => skills.navigate(args, signal), 125000)
  register('mc_follow', '持续跟随指定玩家，直到 mc_halt、下线或死亡。执行其他动作时暂时挂起，结束后恢复；玩家暂时不可见时等待。', {
    who: { type: 'string', required: true },
  }, (skills, args) => skills.setFollow(args.who), 10000)
  register('mc_collect', '生存采集：选工具、寻路、挖掘并拾取，以背包增加量验收。item 是目标物品，block 可指定资源方块；默认附近搜索，不自动漫游。', {
    item: { type: 'string', required: true }, block: { type: 'string' }, count: { type: 'integer' }, radius: { type: 'integer' }, budgetMs: { type: 'integer' },
  }, (skills, args, signal) => skills.collect(args, signal))
  register('mc_craft', '生存合成：根据当前版本配方拆出中间材料、缺料和工作台需求。planOnly=true 只规划；缺料则返回 blocked。执行结果经服务器背包确认，不使用创造给物品。', {
    item: { type: 'string', required: true }, count: { type: 'integer' }, planOnly: { type: 'boolean' }, budgetMs: { type: 'integer' },
  }, (skills, args, signal) => skills.craft(args, signal))
  register('mc_smelt', '在附近空熔炉中熔炼目标物品；需要背包原料与煤，按背包实际增加量确认结果。默认等待游戏正常熔炼时间，可中断。', {
    item: { type: 'string', required: true }, count: { type: 'integer' }, budgetMs: { type: 'integer' },
  }, (skills, args, signal) => skills.smelt(args, signal))
  register('mc_eat', '使用背包中的常见安全食物进食，服务端确认后返回饥饿值。', {}, (skills, _args, signal) => skills.eat(signal), 20000)
  register('mc_combat', '本地持续 PvE：选择武器、走近、检查视线并按攻击冷却出手；低血或苦力怕过近停止追击。不攻击玩家或中立动物。', {
    entity: { type: 'string' }, radius: { type: 'integer' }, budgetMs: { type: 'integer' },
  }, (skills, args, signal) => skills.combat(args, signal), 65000)
  register('mc_goal', '后台连续执行目标，不阻塞当前对话：craft 自动补采材料、工具和工作站；collect 采集；build 蓝图备料并建造；explore 探索附近已加载安全地形。action 为 start/status/pause/resume/cancel。采集或制作可用 deliverTo 指定交接玩家。危险可能暂停目标，无法取得资源时返回 blocked。', {
    action: { type: 'string', enum: ['start', 'status', 'pause', 'resume', 'cancel'], required: true },
    kind: { type: 'string', enum: ['craft', 'collect', 'build', 'explore'] }, item: { type: 'string' }, count: { type: 'integer' }, radius: { type: 'integer' }, budgetMs: { type: 'integer' }, deliverTo: { type: 'string' },
    blocks: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'build 蓝图：每项 x/y/z 整数和 name 材料，最多256格' },
  }, (skills, args) => {
    if (args.action === 'start') return skills.goals.start(args)
    if (args.action === 'pause') return skills.goals.suspend()
    if (args.action === 'resume') return skills.goals.resume()
    if (args.action === 'cancel') { const result = skills.goals.cancel(); skills.active?.controller.abort('目标取消'); return result }
    return skills.goals.view() ?? { state: 'idle' }
  }, 10000)
  logLine?.('已注册 Hiyori 技能及智能目标：生存、寻路、跟随、采集、合成、熔炼、进食、PvE 与后台目标')
}
