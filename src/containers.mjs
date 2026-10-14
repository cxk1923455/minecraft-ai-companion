import { deserialize, serialize } from 'node:v8'
import { integer, assertLive, itemName, itemView, sameItem, at, selectBlock, openBlockWindow, closeBlockWindow } from './gameplay-utils.mjs'

const CONTAINERS = new Set(['chest', 'trapped_chest', 'ender_chest', 'barrel', 'hopper', 'dispenser', 'dropper', 'shulker_box'])
export const isContainer = block => CONTAINERS.has(block.name) || /_shulker_box$/.test(block.name)
const isStorageWindow = window => /^(?:minecraft:)?(?:generic(?:_\d+x\d+)?|chest|container|dispenser|dropper|hopper|shulker_box|barrel|ender_chest)$/.test(window.type)
const containerItems = window => window.slots.slice(0, window.inventoryStart)
const playerItems = window => window.slots.slice(window.inventoryStart, window.inventoryEnd)
const snapshot = items => items.filter(Boolean).map(i => ({ name: i.name, type: i.type, metadata: i.metadata, count: i.count,
  nbt: i.nbt === undefined ? undefined : deserialize(serialize(i.nbt)), components: i.components === undefined ? undefined : deserialize(serialize(i.components)) }))
const variantCount = (items, item) => items.filter(i => sameItem(i, item)).reduce((n, i) => n + i.count, 0)
function validateWindow(window) {
  if (!Number.isInteger(window.inventoryStart) || window.inventoryStart < 1 || window.inventoryStart > 108
    || !Number.isInteger(window.inventoryEnd) || window.inventoryEnd - window.inventoryStart !== 36) throw new Error('容器界面布局不受支持；没有移动物品')
}
function view(window, block) {
  return { container: block.name, at: at(block.position), slots: window.inventoryStart,
    contents: containerItems(window).filter(Boolean).map(itemView), inventory: playerItems(window).filter(Boolean).map(itemView) }
}

/** Server-opened snapshots before and after transfers; never treat optimistic clicks as loot. */
export async function containerAction(skills, args, signal) {
  const action = args.action ?? 'inspect'
  if (!['inspect', 'withdraw', 'deposit', 'take_all'].includes(action)) throw new Error('action 为 inspect/withdraw/deposit/take_all')
  const budget = integer(args.budgetMs, 45000, 1000, 120000, 'budgetMs')
  const requested = integer(args.count, action === 'take_all' ? 512 : 64, 1, 2304, 'count')
  if (['withdraw', 'deposit'].includes(action) && !args.item && args.slot === undefined) throw new Error('取放物品需要 item 或 slot；先 inspect 查看实际槽位')
  return skills.run(`容器 ${action}`, signal, async (s, bot) => {
    const block = selectBlock(bot, args, isContainer, '容器')
    await skills.approach(bot, block, s)
    let window, beforeContainer, beforePlayer, afterContainer, afterPlayer, attempted = 0, reason = null
    const open = async () => {
      const w = await openBlockWindow(bot, bot.blockAt(block.position) ?? block, s, { accept: isStorageWindow })
      try { validateWindow(w) } catch (e) { await closeBlockWindow(bot, w); throw e }
      return w
    }
    try {
      window = await open()
      if (action === 'inspect') return { outcome: 'succeeded', confirmed: true, ...view(window, block) }
      beforeContainer = snapshot(containerItems(window)); beforePlayer = snapshot(playerItems(window))
      const deposit = action === 'deposit'
      const start = deposit ? window.inventoryStart : 0, end = deposit ? window.inventoryEnd : window.inventoryStart
      const destStart = deposit ? 0 : window.inventoryStart, destEnd = deposit ? window.inventoryStart : window.inventoryEnd
      const slot = args.slot === undefined ? null : integer(args.slot, 0, start, end - 1, 'slot')
      const name = args.item ? itemName(args.item) : null
      const initial = window.slots.slice(start, end).map((item, i) => ({ item: item ? snapshot([item])[0] : null, slot: i + start }))
        .filter(e => e.item && (slot === null || e.slot === slot) && (!name || e.item.name === name))
      if (!initial.length && action !== 'take_all') reason = '来源中没有指定物品'
      const available = initial.reduce((n, e) => n + e.item.count, 0)
      const intents = []
      for (const entry of initial) {
        let remainingInStack = entry.item.count
        while (attempted < requested && remainingInStack > 0) {
          assertLive(s)
          const current = window.slots[entry.slot]
          if (!current || !sameItem(current, entry.item)) break
          const dest = Array.from({ length: destEnd - destStart }, (_, i) => i + destStart)
            .find(i => window.slots[i] && sameItem(window.slots[i], current) && window.slots[i].count < (current.stackSize ?? 64))
            ?? Array.from({ length: destEnd - destStart }, (_, i) => i + destStart).find(i => !window.slots[i])
          if (dest === undefined) { reason = deposit ? '容器已满' : '背包已满'; break }
          const n = Math.min(current.count, remainingInStack, requested - attempted, (current.stackSize ?? 64) - (window.slots[dest]?.count ?? 0))
          if (n <= 0) { reason = '物品堆叠容量不受支持'; break }
          try {
            // Restrict both ranges to the chosen slots: distinct NBT/component variants cannot be substituted.
            await skills.guarded(bot.transfer({ window, itemType: current.type, metadata: current.metadata, nbt: current.nbt, count: n,
              sourceStart: entry.slot, sourceEnd: entry.slot + 1, destStart: dest, destEnd: dest + 1 }), s, 10000)
            await skills.inventoryBarrier(bot, s)
          } catch (e) { assertLive(s); reason = e.message; break }
          attempted += n
          const existing = intents.find(e => sameItem(e.item, entry.item))
          if (existing) existing.count += n
          else intents.push({ item: entry.item, count: n })
          remainingInStack -= n
        }
        if (reason || attempted >= requested) break
      }
      // The authoritative window_items on reopening also refreshes the player's inventory.
      await closeBlockWindow(bot, window); window = null
      await skills.inventoryBarrier(bot, s)
      window = await open()
      afterContainer = containerItems(window).filter(Boolean); afterPlayer = playerItems(window).filter(Boolean)
      const moved = {}
      for (const { item, count: intended } of intents) {
        const playerDelta = variantCount(afterPlayer, item) - variantCount(beforePlayer, item)
        const boxDelta = variantCount(beforeContainer, item) - variantCount(afterContainer, item)
        const confirmed = Math.max(0, Math.min(intended, deposit ? -playerDelta : playerDelta, deposit ? -boxDelta : boxDelta))
        if (confirmed) moved[item.name] = (moved[item.name] ?? 0) + confirmed
      }
      const total = Object.values(moved).reduce((a, b) => a + b, 0)
      const expected = action === 'take_all' ? Math.min(available, requested) : requested
      const complete = total >= expected && !reason
      return { outcome: complete ? 'succeeded' : 'partial', confirmed: complete, action, requested, transferred: total, moved,
        remainingRequested: Math.max(0, expected - total), limited: action === 'take_all' && available > requested,
        reason: complete ? null : reason ?? '服务器容器与背包变化没有同时确认全部转移', ...view(window, block) }
    } finally { await closeBlockWindow(bot, window) }
  }, budget)
}
