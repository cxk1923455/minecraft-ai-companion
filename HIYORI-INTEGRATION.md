# Whale Craft 的 Hiyori Minecraft 功能移植

本地增强版：`0.2.0-beta.2.hiyori.6`，基于你提供的 `whale_craft-0.2.0-beta.2.zip`。

保留 DSH 原生插件、每会话一个机器人、连接界面、离线/皮肤站账号、看门狗、记忆和原有建造工具。
新技能使用当前会话已有的 Mineflayer 实例；不需要 Hiyori 桌面程序、Electron、语音服务或额外模型 API。

## 安装本地增强版

1. 把增强版 ZIP 解压到固定文件夹。不要解压后再移动已经安装的 link 路径。
2. 在该文件夹打开 PowerShell，执行 `npm.cmd install --omit=dev --no-audit --no-fund`。
3. 在 DSH 插件管理中添加 `link:你的插件文件夹绝对路径`。例如：
   `link:D:/Minecraft/whale-craft-enhanced`。
4. 完全退出并重启 DSH。已安装原版时使用同名插件替换，避免加载两个 whale_craft。
5. 新建或切换到 MC / MC+ 对话，按原界面连接局域网世界或离线服务器。

如果已安装 DSH CLI，可按实际 profile 使用：

```powershell
dsh plugin --profile desktop add 'link:D:/Minecraft/whale-craft-enhanced'
```

Web profile 把 `desktop` 改为 `web`。上面的命令属于手动安装步骤，尚未替你执行。
增强版也附有 npm `.tgz` 打包产物；本次没有发布到公共 npm。

## 新增 21 个 AI 工具

| 工具 | 功能 |
| --- | --- |
| `mc_survival` | 查询动作、目标与本地决策耗时；设置进食、上浮、自卫、撤退与跟随距离 |
| `mc_halt` | 取消身体动作、关闭跟随、松控制位；保留服务器连接 |
| `mc_pathfind` | A* 生存寻路到坐标或可见玩家，不飞行、不挖路 |
| `mc_follow` | 持续跟随玩家；其他动作期间暂挂，结束后恢复 |
| `mc_collect` | 选工具、靠近资源、挖掘和拾取；以背包增量确认 |
| `mc_craft` | 当前版本配方规划、中间材料合成、缺料反馈、服务器背包确认 |
| `mc_smelt` | 在附近空熔炉熔炼；检查原料、煤和实际输出 |
| `mc_eat` | 使用背包常见食物进食 |
| `mc_combat` | 本地 PvE：选武器、接近、视线检查、冷却控制和停止追击 |
| `mc_container` | 箱子/木桶/末影箱/潜影盒等查看、取出、存入与拿走全部；重新打开验收 |
| `mc_interact` | 幂等开关门、按钮、拉杆、实体右键；自动接近有视线的位置 |
| `mc_equipment` | 查看装备、自动护甲和盾、指定装备与武器选择 |
| `mc_use_item` | 使用/饮食/丢出/交接背包物品；有限时长右键 |
| `mc_player` | 主世界睡觉、起床、钓鱼、上下载具 |
| `mc_farm` | 成熟作物收获与补种、播种、锄地 |
| `mc_trade` | 真实村民报价、支付材料、确认交易所得 |
| `mc_station` | 附魔预览与执行、铁砧重命名/合并，验证并返还物品 |
| `mc_controls` | 短时走动、跳跃、蹲行、游泳、冲刺，到时释放 |
| `mc_goal` | 后台采集/制作/蓝图建造/附近探索目标，支持查询、暂停、继续、取消与指定玩家交接 |
| `mc_agent` | 接受完整目标，检查库存、准备工具、探索/下矿、执行、验证和有限恢复；相同目标复用 |
| `mc_enter` | 走向房间内玩家/落脚点，开门实际穿过；门槛外、门中间与隔墙不算完成 |

游戏里可以直接说：“跟着我”“采集 8 个橡木原木”“看看做一把石镐还缺什么材料”
“停止动作，但不要下线”。主 AI 负责理解这些目标并选择工具。

工具调用示例：

```json
{"tool":"mc_follow","arguments":{"who":"你的玩家名"}}
{"tool":"mc_collect","arguments":{"item":"oak_log","count":8,"radius":32}}
{"tool":"mc_craft","arguments":{"item":"stone_pickaxe","count":1,"planOnly":true}}
{"tool":"mc_smelt","arguments":{"item":"iron_ingot","count":2}}
{"tool":"mc_survival","arguments":{"autoEat":true,"autoSurface":true}}
{"tool":"mc_halt","arguments":{}}
{"tool":"mc_goal","arguments":{"action":"start","kind":"craft","item":"stone_pickaxe","count":1}}
{"tool":"mc_goal","arguments":{"action":"status"}}
{"tool":"mc_goal","arguments":{"action":"pause"}}
{"tool":"mc_goal","arguments":{"action":"resume"}}
{"tool":"mc_goal","arguments":{"action":"start","kind":"explore","count":4,"radius":12}}
{"tool":"mc_goal","arguments":{"action":"start","kind":"collect","item":"oak_log","count":8,"deliverTo":"你的玩家名"}}
{"tool":"mc_combat","arguments":{"entity":"zombie","budgetMs":20000}}
{"tool":"mc_agent","arguments":{"action":"start","kind":"gather","item":"diamond","count":1,"deliverTo":"你的玩家名"}}
{"tool":"mc_agent","arguments":{"action":"status"}}
{"tool":"mc_enter","arguments":{"who":"你的玩家名","budgetMs":60000}}
```

## 行为与边界

- 本地反应从游戏物理事件触发；A* 搜索每轮预算最多 5 ms。这个数字是计算预算，不能当成端到端延迟实测。
- 默认同步当前 MC 会话的最终文字回复到游戏公屏；不转发推理、工具参数或中断的回复，长回复最多6段。MC设置可以关闭同步。
- 生存寻路支持木门、铜门、栅栏门，以及已经由红石打开的铁门；不自动拆墙/放垫脚块。关着的铁门需要用户指出红石控制，活板门只支持显式开关。
- 跟随核验距离和视线，隔着墙不能算已在玩家身边。路径配置复用，避免每轮重复构造整个方块移动表。
- 原有移动、建造、挖掘与新技能共用身体互斥。只允许一个身体任务，查询工具仍可使用。
- 用户停止和宿主 AbortSignal 会取消动作；未结算的底层调用会暂时阻止新身体动作，避免旧任务继续抢控制。
- 食物不足时不会自动狩猎或翻箱；材料不足会返回明确缺口，由主 AI 决定下一步。
- 合成遵循生存材料和配方规则。mc_goal 可补采缺料、制作必要工具并放置工作台/熔炉；单步 mc_craft 仍要求附近已有所需工作站。
- 单步 mc_collect 采集附近资源；完整 mc_agent/mc_goal 采集目标缺资源时会继续移动探索或分步下矿。只使用已加载地形，随移动发现新区域，不能透视未加载区块；不会保证找齐任意模组资源。
- 熔炼目前使用煤与空普通熔炉；不读取或拿走他人已放入熔炉的物品。任务中断后投入的材料可能仍留在熔炉中。
- 缺氧上浮先使用跳跃上浮，最多尝试 5 秒；遇到封闭水下空间会返回未恢复提示，不保证自动脱困。
- 原有 `mc_act` / `mc_build` / `mc_sequence` 继续可用；增加 mc_combat 和 mc_goal 蓝图任务。蓝图支持方块位置和材料，尚不包含完整朝向/方块状态。
- `mc_halt` 会暂停自动生存控制。调用新身体动作或 `mc_survival` 设置会恢复；配置仅在当前会话内保存。
- 准则更新遵循原插件的“随版本更新”开关；若希望保留自定义 RULES.md，请关闭该开关，并把本页新增工具说明补进去。
- 游戏版本与账号方式仍由原插件管理；未增加微软正版登录或基岩版支持。
- 完整能力矩阵、示例与模组/真实游戏测试边界见 [PLAYER-CAPABILITIES.md](PLAYER-CAPABILITIES.md)。

## 验证与源码

```powershell
npm.cmd run check
node tools/check-standalone-import.mjs
```

`src/hiyori/` 保留提取的 TypeScript 原文件，`src/hiyori-skills.mjs` 是已构建产物。
`src/survival.mjs` 把辅助能力接到原有机器人；`extensions/hiyori-survival.mjs` 注册工具。
再构建辅助模块需要开发依赖：`npm.cmd run build:hiyori`。

## 本轮智能与流畅度优化

- 跟随在 2 格附近停下，超过 3.2 格才重新跟进；复用动态路径，减少反复起停。距离可在 mc_survival 配置。
- 跟随卡住后限制重寻路次数，连续三次无进展则停止冲撞并报告；玩家明显移动后再尝试。
- mc_agent/mc_goal 在后台运行，任务期间聊天与查询可以继续。一次只运行一个目标；暂停时间也计入预算，最长 30 分钟，深层矿产默认 30 分钟，其余默认 10 分钟。
- 制作目标会根据当前版本配方处理缺料、工具与工作站；无法取得材料会返回 blocked，不保证完成任意模组科技树。
- 配方规划在工作线程中运行，避免复杂配方搜索占用机器人控制线程；根据背包、附近木材与维度调整材料选择。
- 蓝图按高度施工，跳过已完成方块、拒绝重复坐标或占用位置，逐格验证世界状态。规模最多 256 格。
- explore 从附近已加载地形选择安全落脚点，保留有限访问记录；一次最多 16 点。它不会透视未加载区块或强制生成地图。
- deliverTo 会接近指定可见玩家并投出本次资源；只确认投掷与库存变化，不假称玩家已经拾取。玩家不可见时保留资源并报告。
- 本地自卫默认开启，只针对附近敌对生物；可通过 autoDefend=false 关闭。低血/近距离苦力怕触发撤退，检查已知安全落脚点。
- 低血撤退或上浮失败后，后台目标会暂停。主 AI 应重新观察后决定继续；不是盲目自动重试。
- metrics 中 decisionMsP95 是最近 128 次本地物理事件决策耗时，包含控制决策但不包含服务器往返或模型推理；不能当作完整操作延迟。
- 实际世界中的复杂地形、多人协作和大型建筑仍需要在你的服务器试跑；本地协议夹具不是完整游戏物理模拟。
- 死亡、重生或维度切换会取消旧目标和路径，避免继续使用旧世界坐标。

原版自检增加了 10 个工具的计数，并修复“打印失败但 exit(0)”的问题；DNS 提示验证改为离线错误夹具，避免代理干扰。
Hiyori 原始 MIT 许可保留在 `licenses/Hiyori-MIT.txt`，详见 `THIRD_PARTY_NOTICES.md`。

## Git 安装排查

`pnpm add` 日志显示 `Done` 只说明包安装步骤结束，仍需要 DSH 完成插件启用。
本版修复了 vec3 0.1.7 的命名导出兼容性问题；原 hiyori.2 在这种依赖版本下不能加载。
如果 Git 安装界面持续停留在安装中，先取消当前安装，再使用 Releases 中的最新 ZIP 本地安装方式。
不要仅把 package.json 中的依赖写进去：profile 的 dsh.profile.bundles 还需要包含 whale_craft，随后重启 DSH。
## 聊天、权限与执行反馈优化

本版增加指令总开关 `commandsEnabled`，默认关闭。MC设置 → 指令白名单中的“允许 AI 使用服务器指令”控制所有服务器指令；关闭时，即使白名单包含 tp、kill 或“允许白名单之外的指令”已开启，也不能发送。MC/MC+ 游戏会话不能自行修改全局权限。mc_say 仅发送普通聊天，以斜杠开头的内容会被拒绝。

附近或明确叫到机器人的完整短指令“过来”“跟着我”“停下”有本地执行通道，分别使用寻路、持续跟随与停止，省去一次模型推理等待。复杂、否定或不明确的话仍交给主 AI。通道遵守 MC 模式闸门，可在 mc_config 关闭 `localChatControl`。玩家不在已知玩家列表时不自动开始靠近。

“启动跟随”不等于“已经在身边”。mc_survival 返回实际位置、玩家距离、visible 与 verifiedNearby；寻路结果返回 arrived、confirmed、remaining 和 outcome。指令工具仅报告 sent/confirmed=false，需额外观察世界状态。每个正在游戏中的模型步骤附加简短实时状态，帮助主 AI核对完成情况。

聊天提醒和规则提示分开处理，更新规则不会过滤玩家的聊天提醒；更新单条规则也不会清空其他已投递规则的去重记录。限流会保留有上限的事件队列，稍后合并投递，明确的本地动作仍可执行。签名聊天、私聊和多路重复消息统一识别。

旧 mc_move 的 walk 模式在增强版机器人上也使用安全 A*。连续动作会在未到达时停止并报告 partial。蓝图备料超过 64 件时分批执行；配方规划优先减少操作与材料消耗，避免把原木先转成木头再转木板的浪费路径。熔炼材料可跨背包中的同类堆叠使用，Worker 规划响应取消并清理失败请求。

更新后需要彻底退出 DSH（包括托盘后台）再重开。旧对话可能还含有旧规则和大量重复确认，建议在相同工作区新建 MC/MC+ 会话；原对话和长期记忆保留。不要只关闭窗口或在仍运行的进程里重复点击安装。

这些检查不能证明任意模型、任意 Forge 模组或任意服务器地形都没有问题。游戏聊天的普通文本仍由主 AI 生成，工具状态提供事实依据，不保证模型永不夸大。
