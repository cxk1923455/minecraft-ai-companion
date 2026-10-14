export const isNaturalLog = name => /^(?:log2?)$|_log$|_stem$/.test(name ?? '') && !String(name).startsWith('stripped_')
export function materialCount(bot, name) {
  return (bot.inventory?.items?.() ?? []).filter(item => name === 'log' ? isNaturalLog(item.name) : item.name === name)
    .reduce((sum, item) => sum + item.count, 0)
}
export const acceptsAnyWood = name => ['stick', 'crafting_table', 'chest', 'trapped_chest', 'barrel', 'shield', 'furnace', 'ladder', 'bowl', 'campfire', 'soul_campfire', 'bookshelf'].includes(name)
  || /^(?:wooden|stone|iron|golden|diamond|netherite)_(?:pickaxe|axe|sword|shovel|hoe)$|_bed$/.test(name)
export function materialForDelivery(bot, name) {
  return name === 'log' ? bot.inventory.items().find(item => isNaturalLog(item.name))?.name : name
}
