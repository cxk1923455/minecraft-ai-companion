import vec3pkg from 'vec3'
import { assertLive, integer, itemName, itemView, sameItem, at, selectBlock, countItems, pause } from './gameplay-utils.mjs'
import { isDoor, blockIsOpen, blockProperties, setDoorState, lineOfSight, playerInReach } from './player-navigation.mjs'
const Vec3 = vec3pkg.Vec3 ?? vec3pkg
const ARMOR = [['head', 5, 'helmet'], ['torso', 6, 'chestplate'], ['legs', 7, 'leggings'], ['feet', 8, 'boots']]
const MATERIALS = { leather: 1, golden: 2, chainmail: 3, iron: 4, diamond: 5, netherite: 6, turtle: 3 }
const WEAPONS = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'netherite_axe', 'diamond_axe', 'iron_axe', 'golden_sword', 'wooden_sword', 'stone_axe']
const cursed = item => item?.enchants?.some(e => /binding_curse|curse_of_binding/.test(e.name ?? ''))
function armorScore(item) {
  if (!item) return -1
  const material = MATERIALS[item.name.split('_')[0]] ?? 0
  const protection = (item.enchants ?? []).filter(e => /^(protection|projectile_protection|blast_protection|fire_protection)$/.test(e.name ?? '')).reduce((sum, e) => sum + e.lvl, 0)
  return material * 10 + Math.min(protection, 8)
}
export function equipmentPlan(bot, { weapon = false, shield = true } = {}) {
  const items = bot.inventory?.items?.() ?? [], slots = bot.inventory?.slots ?? []
  const plan = []
  for (const [destination, slot, suffix] of ARMOR) {
    if (cursed(slots[slot]) || destination === 'torso' && slots[slot]?.name === 'elytra') continue
    const best = [...items, slots[slot]].filter(item => item?.name.endsWith(`_${suffix}`) && !cursed(item))
      .sort((a, b) => armorScore(b) - armorScore(a))[0]
    if (best && armorScore(best) > armorScore(slots[slot])) plan.push({ item: best, destination, slot })
  }
  const offhand = items.find(item => item.name === 'shield')
  // Never replace a held totem or a deliberately equipped utility item.
  if (shield && !slots[45] && offhand) plan.push({ item: offhand, destination: 'off-hand', slot: 45 })
  if (weapon) {
    const best = WEAPONS.map(name => items.find(item => item.name === name)).find(Boolean)
    if (best && !sameItem(best, bot.heldItem)) plan.push({ item: best, destination: 'hand' })
  }
  return plan
}
export async function equipBestBody(skills, bot, signal, args = {}) {
  const changes = []
  for (const step of equipmentPlan(bot, args)) {
    assertLive(signal)
    await skills.guarded(bot.equip(step.item, step.destination), signal, 6000)
    await skills.inventoryBarrier(bot, signal)
    const actual = step.slot === undefined ? bot.heldItem : bot.inventory.slots[step.slot]
    changes.push({ destination: step.destination, item: step.item.name, confirmed: sameItem(actual, step.item) })
  }
  return { outcome: changes.every(c => c.confirmed) ? 'succeeded' : 'partial', confirmed: changes.every(c => c.confirmed), changes,
    equipment: skills.host.equipmentView() }
}
export async function equipmentAction(skills, args, signal) {
  if (args.action === 'inspect') { assertLive(signal); return { outcome: 'succeeded', equipment: skills.host.equipmentView(), inventory: skills.bot.inventory.items().map(itemView) } }
  return skills.run('装备管理', signal, async (s, bot) => {
    if ((args.action ?? 'best') === 'best') return equipBestBody(skills, bot, s, { weapon: args.weapon === true, shield: args.shield !== false })
    if (args.action !== 'equip') throw new Error('action 为 inspect/best/equip')
    const item = bot.inventory.items().find(i => args.slot === undefined ? i.name === itemName(args.item) : i.slot === args.slot)
    const destinations = ['hand', 'off-hand', 'head', 'torso', 'legs', 'feet']
    if (!item || !destinations.includes(args.destination)) throw new Error('需要实际背包 item/slot 和 destination: hand/off-hand/head/torso/legs/feet')
    await skills.guarded(bot.equip(item, args.destination), s, 6000)
    await skills.inventoryBarrier(bot, s)
    const slot = { 'off-hand': 45, head: 5, torso: 6, legs: 7, feet: 8 }[args.destination]
    const actual = slot === undefined ? bot.heldItem : bot.inventory.slots[slot]
    const confirmed = sameItem(actual, item)
    return { outcome: confirmed ? 'succeeded' : 'partial', confirmed, item: item.name, equipment: skills.host.equipmentView() }
  }, 40000)
}

function findEntity(bot, args, predicate = () => true) {
  const needle = String(args.entity ?? args.who ?? '').toLowerCase()
  const candidates = Object.values(bot.entities ?? {}).filter(e => e && e !== bot.entity && e.position && predicate(e)
    && (args.entityId === undefined || e.id === args.entityId) && (!needle || String(e.username ?? e.name ?? '').toLowerCase() === needle))
    .sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position))
  const entity = candidates[0]
  if (!entity) throw new Error('找不到指定可见实体，请用 mc_entities 查询实体 ID')
  return entity
}
async function approachEntity(skills, bot, entity, signal) {
  if (!playerInReach(bot, entity, 3)) {
    const result = await skills.navigateBody({ x: entity.position.x, y: entity.position.y, z: entity.position.z, range: 1 }, signal, bot, 20000)
    if (!result.arrived) throw new Error('无法接近实体')
  }
  if (!playerInReach(bot, entity, 3.5)) throw new Error('实体已离开交互距离或被障碍遮挡')
}

export async function interactAction(skills, args, signal) {
  const budget = integer(args.budgetMs, 30000, 1000, 120000, 'budgetMs')
  return skills.run('世界交互', signal, async (s, bot) => {
    if (args.entityId !== undefined || args.entity || args.who) {
      const entity = findEntity(bot, args)
      await approachEntity(skills, bot, entity, s)
      if (args.item) {
        const item = bot.inventory.items().find(i => i.name === itemName(args.item))
        if (!item) throw new Error('背包中没有指定交互物品')
        await skills.guarded(bot.equip(item, 'hand'), s, 5000)
      }
      await skills.guarded(bot.activateEntity(entity), s, 5000)
      await skills.inventoryBarrier(bot, s)
      return { outcome: 'sent', confirmed: false, entityId: entity.id, entity: entity.name, reason: '已进行右键交互；需继续观察动物/载具/界面实际变化' }
    }
    const action = args.action ?? 'activate'
    if (!['activate', 'open', 'close'].includes(action)) throw new Error('action 为 activate/open/close')
    const block = selectBlock(bot, args, b => ['open', 'close'].includes(action) ? isDoor(b) : Boolean(b.name && !/^(air|cave_air|void_air)$/.test(b.name)), '交互方块', 8)
    await skills.approach(bot, block, s)
    if (isDoor(block)) {
      const result = await setDoorState(bot, block, action === 'close' ? false : action === 'open' ? true : !blockIsOpen(block),
        { signal: s, activate: skills.originalActivate ?? bot.activateBlock.bind(bot) })
      return { ...result, block: block.name, at: at(block.position) }
    }
    if (args.item) {
      const item = bot.inventory.items().find(i => i.name === itemName(args.item))
      if (!item) throw new Error('背包中没有指定物品')
      await skills.guarded(bot.equip(item, 'hand'), s, 5000)
    }
    const before = { ...blockProperties(block) }
    await skills.guarded(bot.activateBlock(block), s, 5000)
    await skills.inventoryBarrier(bot, s)
    const actual = bot.blockAt(block.position)
    const properties = blockProperties(actual)
    const changed = actual?.type !== block.type || JSON.stringify(before) !== JSON.stringify(properties)
    return { outcome: changed ? 'succeeded' : 'sent', confirmed: changed, block: actual?.name, at: at(block.position), properties,
      note: changed ? '已观察到方块状态变化' : '交互已发送，尚未观察到方块状态变化；容器取放请用 mc_container' }
  }, budget)
}

export async function itemAction(skills, args, signal) {
  const action = args.action ?? 'use'
  if (!['use', 'drop', 'give', 'consume'].includes(action)) throw new Error('action 为 use/drop/give/consume')
  const duration = integer(args.durationMs, 1200, 50, 5000, 'durationMs')
  return skills.run(`物品 ${action}`, signal, async (s, bot) => {
    const item = bot.inventory.items().find(i => args.slot === undefined ? i.name === itemName(args.item) : i.slot === args.slot)
    if (!item) throw new Error('需要背包中的 item/slot，可用 mc_inventory 查询')
    const before = countItems(bot.inventory.items())
    if (['give', 'drop'].includes(action)) {
      const quantity = integer(args.count, 1, 1, item.count, 'count')
      if (action === 'give') {
        const target = skills.findPlayer(String(args.who ?? ''))
        if (!target) throw new Error('交接需要附近可见玩家 who')
        await approachEntity(skills, bot, target, s)
        await skills.guarded(bot.lookAt(target.position.offset(0, 0.7, 0)), s, 2000)
      }
      await skills.guarded(bot.transfer({ window: bot.inventory, itemType: item.type, metadata: item.metadata, nbt: item.nbt, count: quantity,
        sourceStart: item.slot, sourceEnd: item.slot + 1, destStart: -999 }), s, 6000)
      await skills.inventoryBarrier(bot, s)
      const removed = Math.max(0, (before[item.name] ?? 0) - (countItems(bot.inventory.items())[item.name] ?? 0))
      return { outcome: removed >= quantity ? 'succeeded' : 'partial', confirmed: removed >= quantity, item: item.name, removed,
        note: action === 'give' ? '已在玩家附近丢出物品；尚未确认玩家拾取' : '按背包减少量确认丢出' }
    }
    await skills.guarded(bot.equip(item, args.offhand ? 'off-hand' : 'hand'), s, 6000)
    assertLive(s)
    if (action === 'consume') await skills.guarded(bot.consume(), s, 8000)
    else {
      if (['x', 'y', 'z'].some(k => args[k] !== undefined)) {
        if (!['x', 'y', 'z'].every(k => Number.isFinite(args[k]))) throw new Error('看向目标需完整有效 x/y/z')
        await skills.guarded(bot.lookAt(new Vec3(args.x, args.y, args.z), false), s, 2000)
      }
      bot.activateItem(args.offhand === true)
      await pause(duration, s)
      bot.deactivateItem()
    }
    await skills.inventoryBarrier(bot, s)
    const after = countItems(bot.inventory.items())
    const changes = Object.fromEntries([...new Set([...Object.keys(before), ...Object.keys(after)])].map(name => [name, (after[name] ?? 0) - (before[name] ?? 0)]))
    return { outcome: 'sent', confirmed: false, item: item.name, action, inventoryChanges: Object.fromEntries(Object.entries(changes).filter(([, n]) => n)),
      health: bot.health, food: bot.food, note: '使用动作已发送；物品效果需按背包/生命/世界状态继续验收' }
  }, 25000)
}

export async function playerAction(skills, args, signal) {
  const action = args.action
  const budget = integer(args.budgetMs, action === 'fish' ? 90000 : 30000, 1000, 180000, 'budgetMs')
  return skills.run(`玩家 ${action}`, signal, async (s, bot) => {
    if (action === 'sleep') {
      if (!/^(?:minecraft:)?overworld$/.test(bot.game?.dimension ?? '')) return { outcome: 'blocked', confirmed: false, reason: '只在主世界使用床，避免下界/末地床爆炸' }
      const block = selectBlock(bot, args, b => /(?:^|_)bed$/.test(b.name), '床')
      await skills.approach(bot, block, s)
      const follow = skills.follow
      skills.follow = null // Sleeping should not immediately resume a movement path.
      try { await skills.guarded(bot.sleep(block), s, 8000) }
      catch (e) { skills.follow = follow; throw e }
      await skills.inventoryBarrier(bot, s)
      return { outcome: bot.isSleeping ? 'succeeded' : 'partial', confirmed: bot.isSleeping === true, sleeping: bot.isSleeping }
    }
    if (action === 'wake') {
      if (bot.isSleeping) await skills.guarded(bot.wake(), s, 6000)
      await skills.inventoryBarrier(bot, s)
      return { outcome: bot.isSleeping ? 'partial' : 'succeeded', confirmed: !bot.isSleeping, sleeping: bot.isSleeping }
    }
    if (action === 'mount') {
      const entity = findEntity(bot, args, e => /boat|minecart|horse|donkey|mule|pig|strider|camel|llama/.test(e.name ?? ''))
      await approachEntity(skills, bot, entity, s)
      bot.mount(entity)
      await skills.inventoryBarrier(bot, s)
      const vehicle = bot.vehicle?.entity ?? bot.vehicle
      if (vehicle?.id === entity.id) skills.follow = null
      return { outcome: vehicle?.id === entity.id ? 'succeeded' : 'partial', confirmed: vehicle?.id === entity.id, vehicle: vehicle?.name ?? null }
    }
    if (action === 'dismount') {
      if (bot.vehicle) bot.dismount()
      await skills.inventoryBarrier(bot, s)
      return { outcome: bot.vehicle ? 'partial' : 'succeeded', confirmed: !bot.vehicle }
    }
    if (action === 'fish') {
      const rod = bot.inventory.items().find(i => i.name === 'fishing_rod')
      if (!rod) throw new Error('需要背包中有 fishing_rod')
      const water = selectBlock(bot, args, b => b.name === 'water', '水域', 8)
      if (bot.entity.position.distanceTo(water.position) > 8 || !lineOfSight(bot, bot.entity.position.offset(0, 1.5, 0), water.position.offset(0.5, 0.5, 0.5), water.position)) throw new Error('需要先走到能看见水面的岸边再钓鱼')
      const before = countItems(bot.inventory.items())
      await skills.guarded(bot.equip(rod, 'hand'), s, 6000)
      await skills.guarded(bot.lookAt(water.position.offset(0.5, 0.5, 0.5), false), s, 2000)
      const cancel = () => { try { bot.activateItem() } catch {} }
      await skills.guarded(bot.fish(), s, Math.max(1000, budget - 8000), cancel)
      await pause(700, s)
      await skills.inventoryBarrier(bot, s)
      const after = countItems(bot.inventory.items())
      const caught = Object.fromEntries(Object.entries(after).map(([name, n]) => [name, n - (before[name] ?? 0)]).filter(([, n]) => n > 0))
      return { outcome: Object.keys(caught).length ? 'succeeded' : 'partial', confirmed: Boolean(Object.keys(caught).length), caught,
        note: '仅按实际进入背包的钓获验收' }
    }
    throw new Error('action 为 sleep/wake/fish/mount/dismount')
  }, budget)
}
