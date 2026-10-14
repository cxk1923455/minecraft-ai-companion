export const name = 'Hiyori 生存技能'

export function apply({ ctx, asTool, getSession, logLine }) {
  const output = { schema: { type: 'object', properties: {}, additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }
  const register = (name, description, parameters, execute, timeoutMs = 310000) => ctx.tools.register(asTool({
    name, description, parameters, output, timeoutMs,
    execute: (args, exec) => execute(getSession(exec).bot.skills, args, exec?.signal),
  }))
  register('mc_survival', '查询真实位置、follow.distance、verifiedNearby、当前动作、后台目标和本地决策耗时；确认在玩家身边前必须检查实际距离。可设置自动进食、上浮、自卫和撤退。只用当前会话的机器人，省略参数只查询。', {
    autoEat: { type: 'boolean' }, autoSurface: { type: 'boolean' }, autoRetreat: { type: 'boolean' }, autoDefend: { type: 'boolean' }, autoEquip: { type: 'boolean' }, doorAssist: { type: 'boolean' }, foodThreshold: { type: 'integer' }, oxygenThreshold: { type: 'integer' }, healthThreshold: { type: 'integer' }, followDistance: { type: 'integer' },
  }, (skills, args) => Object.keys(args).length ? skills.configure(args) : skills.status())
  register('mc_halt', '立即停止当前 Minecraft 动作与持续跟随，保持游戏连接；暂停自动生存动作。随后调用新动作或 mc_survival 设置可恢复。', {}, skills => skills.halt(), 10000)
  register('mc_pathfind', 'A* 生存寻路到坐标或可见玩家，绕障碍；不飞行、不自动挖路。返回真实到达结果和失败原因。', {
    x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, who: { type: 'string' }, range: { type: 'integer' }, budgetMs: { type: 'integer' },
  }, (skills, args, signal) => skills.navigate(args, signal), 125000)
  register('mc_follow', '持续跟随指定玩家，直到 mc_halt、下线或死亡。执行其他动作时暂时挂起，结束后恢复；玩家暂时不可见时等待。', {
    who: { type: 'string', required: true },
  }, (skills, args) => skills.setFollow(args.who), 10000)
  register('mc_enter', '真正进入玩家所在房间：识别门、门内目标和通行侧，开门并走过门槛，以实际站位确认。给 who 玩家名，或给房间内部 x/y/z 坐标。不能在门外仅因距离近就报已进屋；不传送、不拆墙。', {
    who: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, budgetMs: { type: 'integer' },
  }, (skills, args, signal) => skills.enter(args, signal), 125000)
  register('mc_agent', '持续执行玩家目标的智能体入口。start 启动后台 gather 找资源、craft 制作、enter 进入房间、explore 探索、build 蓝图、follow 跟随；status 查询实际阶段和进度，pause/resume/cancel 管理目标。gather 会检查背包、准备正确工具，附近没有资源就实际探索/安全下矿、遇阻换路线，直到验收或具体安全/时间边界；不会一次扫描无矿就结束。钻石可能需正常采矿时间，默认最多30分钟。deliverTo 可指定交接玩家；相同目标复用而不重复启动。', {
    action: { type: 'string', enum: ['start', 'status', 'pause', 'resume', 'continue', 'recover', 'cancel'], required: true },
    kind: { type: 'string', enum: ['gather', 'craft', 'enter', 'explore', 'build', 'follow'] },
    item: { type: 'string' }, count: { type: 'integer' }, who: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, radius: { type: 'integer' }, budgetMs: { type: 'integer' }, deliverTo: { type: 'string' }, useExisting: { type: 'boolean' },
    blocks: { type: 'array', items: { type: 'object', additionalProperties: true } },
  }, (skills, args) => skills.agent.act(args), 10000)
  register('mc_collect', '单次附近生存采集：选工具、寻路、挖掘并拾取，以背包增加量验收。完整“去找/挖钻石”等持续目标必须用 mc_agent gather；不能只反复调用本工具扫描附近后宣称无法完成。item 是目标物品，block 可指定资源方块。', {
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
  const coordinates = { x: { type: 'integer' }, y: { type: 'integer' }, z: { type: 'integer' }, radius: { type: 'integer' }, budgetMs: { type: 'integer' } }
  register('mc_container', '打开附近或指定坐标的箱子、木桶、末影箱、潜影盒、漏斗、发射器或投掷器，查看/取出/存入/拿走全部。action 为 inspect/withdraw/deposit/take_all；取放指定 item 或 inspect 返回的 slot，count 是数量上限。自动走近并开门，不使用服务器指令。转移后重新打开容器，必须以服务器容器和背包两边的变化确认；满背包或保护拒绝返回实际原因。', {
    ...coordinates, action: { type: 'string', enum: ['inspect', 'withdraw', 'deposit', 'take_all'], required: true },
    item: { type: 'string' }, slot: { type: 'integer' }, count: { type: 'integer' },
  }, (skills, args, signal) => skills.container(args, signal), 125000)
  register('mc_equipment', '查看装备和背包，或自动选择较好的护甲与盾；weapon=true 同时选近战武器。equip 可按实际 item/slot 装到 hand/off-hand/head/torso/legs/feet。自动装备保留鞘翅、现有副手与绑定诅咒，不强换。结果需服务器背包确认。', {
    action: { type: 'string', enum: ['inspect', 'best', 'equip'] }, item: { type: 'string' }, slot: { type: 'integer' }, destination: { type: 'string', enum: ['hand', 'off-hand', 'head', 'torso', 'legs', 'feet'] }, weapon: { type: 'boolean' }, shield: { type: 'boolean' },
  }, (skills, args, signal) => skills.equipment(args, signal), 45000)
  register('mc_interact', '先走到有视线的交互位置，再开/关木门、铜门、栅栏门、活板门，或右键按钮、拉杆、方块/实体。open/close 对门按真实状态确认且不重复切换；铁门需指定红石控制，不会破坏房间。entityId/entity/who 指定实体，可用 item 喂养、剪羊毛等，通用交互 sent 不等于效果成功。箱子取放用 mc_container。', {
    ...coordinates, action: { type: 'string', enum: ['activate', 'open', 'close'] }, entity: { type: 'string' }, entityId: { type: 'integer' }, who: { type: 'string' }, item: { type: 'string' },
  }, (skills, args, signal) => skills.interact(args, signal), 125000)
  register('mc_use_item', '真实使用背包物品：use 持续右键（举盾/弓/药水等，可给目标坐标与 durationMs）；consume 进食或饮用；drop 丢出；give 走近 who 后交接。按 item 或 mc_inventory 的 slot 指定物品；绝不创造物品。给玩家只确认丢出，不能声称对方已拾取；通用使用按返回的背包/生命/世界变化判断。', {
    action: { type: 'string', enum: ['use', 'consume', 'drop', 'give'] }, item: { type: 'string' }, slot: { type: 'integer' }, count: { type: 'integer' }, who: { type: 'string' }, offhand: { type: 'boolean' }, durationMs: { type: 'integer' }, x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' },
  }, (skills, args, signal) => skills.useItem(args, signal), 30000)
  register('mc_player', '普通玩家行为：sleep 在主世界寻找床睡觉（禁止在下界/末地使用床）；wake 起床；fish 在岸边朝指定/附近水面钓一竿，按背包增加确认钓获；mount/dismount 上下载具（需可见 entity/entityId）。所有动作可取消，不使用服务器指令。钓鱼要有 fishing_rod，仍需等待游戏咬钩时间。', {
    ...coordinates, action: { type: 'string', enum: ['sleep', 'wake', 'fish', 'mount', 'dismount'], required: true }, entity: { type: 'string' }, entityId: { type: 'integer' },
  }, (skills, args, signal) => skills.player(args, signal), 185000)
  register('mc_farm', '生存农务：harvest 只收获成熟小麦/胡萝卜/马铃薯/甜菜/下界疣并默认补种；plant 指定耕地或灵魂沙坐标播种；till 用已有锄头锄地。crop 为 wheat/carrots/potatoes/beetroots/nether_wart。count 是收获成熟作物的株数，默认8，上限64。不会破坏未成熟作物或占用已有建筑，缺种子则报告部分完成。', {
    ...coordinates, action: { type: 'string', enum: ['harvest', 'plant', 'till'] }, crop: { type: 'string' }, count: { type: 'integer' }, replant: { type: 'boolean' },
  }, (skills, args, signal) => skills.farm(args, signal))
  register('mc_trade', '走近可见村民并 inspect 查看真实交易价格和剩余次数；buy 按 inspect 的 index 交易 count 次，消耗自己的物品。entityId 可指定村民。交易后重新打开界面，按实际收到的物品验收；不使用服务器指令。', {
    action: { type: 'string', enum: ['inspect', 'buy'] }, entityId: { type: 'integer' }, index: { type: 'integer' }, count: { type: 'integer' },
  }, (skills, args, signal) => skills.trade(args, signal), 65000)
  register('mc_station', '生存工作站：enchant_preview 把背包物品放入附魔台查看真实选项；enchant 选择 choice 0/1/2，消耗已有等级和青金石；anvil_rename 用 name 重命名；anvil_combine 用 secondItem/secondSlot 修复或合并。需要对应工作站、物品和经验。slot/secondSlot 使用 mc_inventory 的背包槽位。自动返还界面物品并关闭，不能把发送动作视为完成。', {
    ...coordinates, action: { type: 'string', enum: ['enchant_preview', 'enchant', 'anvil_rename', 'anvil_combine'], required: true }, item: { type: 'string' }, slot: { type: 'integer' }, secondItem: { type: 'string' }, secondSlot: { type: 'integer' }, choice: { type: 'integer' }, name: { type: 'string' },
  }, (skills, args, signal) => skills.station(args, signal), 70000)
  register('mc_controls', '短时真实玩家按键，适合蹲行、跳跃、游泳与脱困。按键为 forward/back/left/right/jump/sprint/sneak，durationMs 50–5000；到时或取消会释放全部按键，返回实际位移。常规赶路优先 mc_pathfind，持续跟随用 mc_follow。', {
    forward: { type: 'boolean' }, back: { type: 'boolean' }, left: { type: 'boolean' }, right: { type: 'boolean' }, jump: { type: 'boolean' }, sprint: { type: 'boolean' }, sneak: { type: 'boolean' }, durationMs: { type: 'integer' },
  }, (skills, args, signal) => skills.controls(args, signal), 10000)
  register('mc_goal', '后台连续执行目标，不阻塞当前对话：craft 自动补采材料、工具和工作站；collect 持续寻找资源并安全探索/下矿；enter 进入房间；build 蓝图备料并建造；explore 探索附近地形。action 为 start/status/pause/resume/cancel。采集或制作可用 deliverTo 指定交接玩家。优先用 mc_agent 规划完整目标；危险可能暂停，只有具体资源/安全/预算边界才结算未完成。', {
    action: { type: 'string', enum: ['start', 'status', 'pause', 'resume', 'continue', 'recover', 'cancel'], required: true },
    kind: { type: 'string', enum: ['craft', 'collect', 'build', 'explore', 'enter'] }, item: { type: 'string' }, count: { type: 'integer' }, radius: { type: 'integer' }, budgetMs: { type: 'integer' }, deliverTo: { type: 'string' }, who: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, useExisting: { type: 'boolean' },
    blocks: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'build 蓝图：每项 x/y/z 整数和 name 材料，最多256格' },
  }, (skills, args) => {
    if (args.action === 'start') return skills.goals.start(args)
    if (args.action === 'continue' || args.action === 'recover') return skills.agent.act(args)
    if (args.action === 'pause') return skills.goals.suspend()
    if (args.action === 'resume') return skills.goals.resume()
    if (args.action === 'cancel') { const result = skills.goals.cancel(); skills.active?.controller.abort('目标取消'); return result }
    return skills.goals.view() ?? { state: 'idle' }
  }, 10000)
  logLine?.('已注册 Hiyori 技能及智能目标：生存、寻路、跟随、采集、合成、熔炼、进食、PvE 与后台目标')
}
