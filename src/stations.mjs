import { deserialize, serialize } from 'node:v8'
import { integer, itemName, itemView, sameItem, selectBlock, assertLive, pause, countItems } from './gameplay-utils.mjs'
import { playerInReach } from './player-navigation.mjs'
const copy = item => item ? { name: item.name, type: item.type, metadata: item.metadata, count: item.count,
  nbt: item.nbt === undefined ? undefined : deserialize(serialize(item.nbt)), components: item.components === undefined ? undefined : deserialize(serialize(item.components)) } : null
const playerItems = w => w.slots.slice(w.inventoryStart, w.inventoryEnd).filter(Boolean)

/** Contain native window listeners if opening is denied or cancelled. One body owns all windows. */
async function nativeWindow(skills, bot, open, signal) {
  const watched = [[bot, 'windowOpen'], [bot._client, 'trade_list'], [bot._client, 'MC|TrList'], [bot._client, 'minecraft:trader_list'], [bot._client, 'craft_progress_bar']]
  const existing = watched.map(([emitter, event]) => new Set(emitter?.rawListeners?.(event) ?? []))
  try { return await skills.guarded(open(), signal, 7000) }
  catch (e) {
    for (const [[emitter, event], previous] of watched.map((pair, i) => [pair, existing[i]])) {
      for (const handler of emitter?.rawListeners?.(event) ?? []) if (!previous.has(handler)) emitter.removeListener(event, handler)
    }
    throw e
  }
}
async function closeWindow(bot, window) { if (window && bot.currentWindow === window) { if (window.close) await window.close(); else await bot.closeWindow(window) } }
function pickInWindow(window, args, nameKey = 'item', slotKey = 'slot') {
  const slot = args[slotKey]
  const item = playerItems(window).find(i => slot === undefined ? i.name === itemName(args[nameKey]) : i.slot === window.inventoryStart + slot - 9)
  if (!item) throw new Error(`背包中没有指定 ${nameKey}/${slotKey}`)
  return item
}

export async function tradeAction(skills, args, signal) {
  const count = integer(args.count, 1, 1, 64, 'count')
  return skills.run('村民交易', signal, async (s, bot) => {
    const villagers = Object.values(bot.entities ?? {}).filter(e => e.name === 'villager' && e.position && (args.entityId === undefined || args.entityId === e.id))
      .sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position))
    const entity = villagers[0]
    if (!entity) throw new Error('附近没有已加载的村民')
    if (!playerInReach(bot, entity, 3)) {
      const nav = await skills.navigateBody({ x: entity.position.x, y: entity.position.y, z: entity.position.z, range: 1 }, s, bot, 20000)
      if (!nav.arrived || !playerInReach(bot, entity, 3.5)) throw new Error('无法接近村民的交互位置')
    }
    let window
    try {
      window = await nativeWindow(skills, bot, () => bot.openVillager(entity), s)
      const offers = () => (window.trades ?? []).map((t, index) => ({ index, cost: [{ ...itemView(t.inputItem1), count: t.realPrice }, ...(t.hasItem2 ? [itemView(t.inputItem2)] : [])], output: itemView(t.outputItem), remaining: Math.max(0, t.maximumNbTradeUses - t.nbTradeUses), disabled: Boolean(t.tradeDisabled) }))
      if ((args.action ?? 'inspect') === 'inspect') return { outcome: 'succeeded', confirmed: true, entityId: entity.id, offers: offers() }
      if (args.action !== 'buy') throw new Error('action 为 inspect/buy')
      const index = integer(args.index, -1, 0, (window.trades ?? []).length - 1, 'index')
      const offer = window.trades[index]
      if (offer.tradeDisabled || offer.maximumNbTradeUses - offer.nbTradeUses < count) return { outcome: 'blocked', confirmed: false, reason: '该交易已售罄或次数不足', offers: offers() }
      const before = playerItems(window).map(copy), output = copy(offer.outputItem)
      const inputs = [offer.inputItem1, ...(offer.hasItem2 ? [offer.inputItem2] : [])]
      if (inputs.some(i => (i.enchants?.length ?? 0) > 0 || i.customName)) return { outcome: 'blocked', confirmed: false, reason: '交易需要带特殊数据的输入，当前不自动替换指定物品' }
      for (let n = 0; n < inputs.length; n++) {
        const price = (n === 0 ? offer.realPrice : inputs[n].count) * count
        const available = playerItems(window).filter(i => sameItem(i, inputs[n])).reduce((sum, i) => sum + i.count, 0)
        if (available < price) return { outcome: 'blocked', confirmed: false, reason: '背包中满足交易数据要求的支付物品不足', offers: offers() }
        // The native transfer API matches IDs. Do not let it pay with a different named/component variant.
        if (playerItems(window).some(i => i.type === inputs[n].type && !sameItem(i, inputs[n]))) return { outcome: 'blocked', confirmed: false, reason: '支付物品存在不同自定义数据，当前拒绝自动选择以免误用', offers: offers() }
      }
      await skills.guarded(bot.trade(window, index, count), s, 20000)
      await skills.inventoryBarrier(bot, s)
      await closeWindow(bot, window); window = null
      await skills.inventoryBarrier(bot, s)
      window = await nativeWindow(skills, bot, () => bot.openVillager(entity), s)
      const variantCount = items => items.filter(i => sameItem(i, output)).reduce((n, i) => n + i.count, 0)
      const gained = Math.max(0, variantCount(playerItems(window)) - variantCount(before))
      const confirmed = gained >= output.count * count
      return { outcome: confirmed ? 'succeeded' : 'partial', confirmed, item: output.name, received: gained, requestedTrades: count, offers: offers() }
    } finally { await closeWindow(bot, window) }
  }, 60000)
}

export async function stationAction(skills, args, signal) {
  const action = args.action
  if (!['enchant_preview', 'enchant', 'anvil_rename', 'anvil_combine'].includes(action)) throw new Error('action 为 enchant_preview/enchant/anvil_rename/anvil_combine')
  return skills.run(`工作站 ${action}`, signal, async (s, bot) => {
    const enchant = action.startsWith('enchant')
    const block = selectBlock(bot, args, b => enchant ? b.name === 'enchanting_table' : /^(?:chipped_|damaged_)?anvil$/.test(b.name), enchant ? '附魔台' : '铁砧')
    await skills.approach(bot, block, s)
    let window
    try {
      window = await nativeWindow(skills, bot, () => enchant ? bot.openEnchantmentTable(block) : bot.openAnvil(block), s)
      const target = pickInWindow(window, args), original = copy(target)
      if (enchant) {
        await skills.guarded(window.putTargetItem(target), s, 5000)
        const lapis = playerItems(window).find(i => i.name === 'lapis_lazuli')
        if (lapis) await skills.guarded(window.putLapis(lapis), s, 5000)
        const deadline = Date.now() + 3000
        while ((window.enchantments ?? []).some(e => e.level < 0) && Date.now() < deadline) await pause(50, s)
        const options = window.enchantments ?? []
        if (options.length !== 3 || options.some(e => e.level < 0)) throw new Error('服务器未返回完整附魔选项')
        if (action === 'enchant_preview') return { outcome: 'planned', confirmed: true, item: target.name, level: bot.experience?.level, options }
        const choice = integer(args.choice, 0, 0, 2, 'choice')
        if (options[choice].level < 1 || (bot.experience?.level ?? 0) < options[choice].level || (window.slots[1]?.count ?? 0) < choice + 1) return { outcome: 'blocked', confirmed: false, reason: '该选项不可用、经验等级不足或青金石不足', options }
        await skills.guarded(window.enchant(choice), s, 8000)
        await skills.inventoryBarrier(bot, s)
        const actual = copy(window.slots[0]), changed = Boolean(actual && !sameItem(actual, original))
        if (window.slots[0]) await skills.guarded(bot.putAway(0), s, 5000)
        if (window.slots[1]) await skills.guarded(bot.putAway(1), s, 5000)
        await skills.inventoryBarrier(bot, s)
        await closeWindow(bot, window); window = null
        await skills.inventoryBarrier(bot, s)
        window = await nativeWindow(skills, bot, () => bot.openEnchantmentTable(block), s)
        const returned = actual ? playerItems(window).find(i => sameItem(i, actual)) : null
        const confirmed = changed && Boolean(returned)
        return { outcome: confirmed ? 'succeeded' : 'partial', confirmed, item: itemView(returned), options }
      }
      const beforeItems = playerItems(window).map(copy), before = countItems(beforeItems), xp = bot.experience?.level ?? 0
      const creative = bot.game.gameMode === 'creative'
      // Mineflayer rename waits for an XP event, which creative servers need not send.
      if (creative && action === 'anvil_rename') return { outcome: 'blocked', confirmed: false, reason: '创造模式铁砧重命名的上游接口缺少经验确认，请在生存模式使用' }
      const anvil = target.constructor?.anvil
      if (typeof anvil !== 'function') return { outcome: 'blocked', confirmed: false, reason: '当前版本缺少铁砧配方验证，未消耗物品' }
      if (action === 'anvil_rename') {
        if (typeof args.name !== 'string' || !args.name.trim() || args.name.length > 35) throw new Error('铁砧名字需为 1–35 个字符')
        const { xpCost } = anvil(target, null, creative, args.name)
        if (!xpCost || xp < xpCost) return { outcome: 'blocked', confirmed: false, reason: '重命名不可用或经验等级不足' }
        await skills.guarded(window.rename(target, args.name), s, 15000)
      } else {
        const second = pickInWindow(window, args, 'secondItem', 'secondSlot')
        if (second.slot === target.slot) throw new Error('铁砧合并需要两格不同的物品')
        const costs = [anvil(target, second, creative, args.name).xpCost, anvil(second, target, creative, args.name).xpCost].filter(n => n > 0)
        if (!costs.length || !creative && xp < Math.min(...costs)) return { outcome: 'blocked', confirmed: false, reason: '无法修复/合并，或经验等级不足' }
        await skills.guarded(window.combine(target, second, args.name), s, 15000)
      }
      await skills.inventoryBarrier(bot, s)
      await closeWindow(bot, window); window = null
      await skills.inventoryBarrier(bot, s)
      window = await nativeWindow(skills, bot, () => bot.openAnvil(block), s)
      const candidates = playerItems(window).filter(i => i.type === original.type && !sameItem(i, original)
        && playerItems(window).filter(x => sameItem(x, i)).reduce((n, x) => n + x.count, 0) > beforeItems.filter(x => sameItem(x, i)).reduce((n, x) => n + x.count, 0))
      const changed = candidates.length > 0 && ((bot.experience?.level ?? 0) < xp || bot.game.gameMode === 'creative')
      return { outcome: changed ? 'succeeded' : 'partial', confirmed: changed, items: candidates.map(itemView), xpBefore: xp, xpAfter: bot.experience?.level,
        inventoryBefore: before, inventoryAfter: countItems(bot.inventory.items()) }
    } finally {
      if (window && bot.currentWindow === window && enchant) {
        // Return the target and unused lapis. Closing the server window also returns them on abort.
        if (!s.aborted) for (const slot of [0, 1]) if (window.slots[slot]) {
          try { await skills.guarded(bot.putAway(slot), s, 4000) } catch { break }
        }
      }
      await closeWindow(bot, window)
    }
  }, 65000)
}

export async function controlsAction(skills, args, signal) {
  const keys = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']
  const duration = integer(args.durationMs, 400, 50, 5000, 'durationMs')
  return skills.run('短时按键操作', signal, async (s, bot) => {
    if (args.forward && args.back || args.left && args.right) throw new Error('相反方向不能同时按下')
    const before = bot.entity.position.clone()
    for (const key of keys) if (args[key] !== undefined) {
      if (typeof args[key] !== 'boolean') throw new Error('按键状态必须是布尔值')
      bot.setControlState(key, args[key])
    }
    try { await pause(duration, s) } finally { bot.clearControlStates() }
    assertLive(s)
    const actual = bot.entity.position
    return { outcome: 'sent', confirmed: false, moved: Number(before.distanceTo(actual).toFixed(2)), position: { x: actual.x, y: actual.y, z: actual.z }, note: '已按下并释放按键；需要按实际位置验证目标，不会无限持续按键' }
  }, duration + 1000)
}
