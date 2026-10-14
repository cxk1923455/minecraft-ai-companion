import vec3pkg from 'vec3'
import { integer, assertLive, itemName, selectBlock, at, countItems } from './gameplay-utils.mjs'
import { blockProperties } from './player-navigation.mjs'
const Vec3 = vec3pkg.Vec3 ?? vec3pkg
export const CROPS = {
  wheat: { age: 7, seed: 'wheat_seeds', ground: 'farmland' }, carrots: { age: 7, seed: 'carrot', ground: 'farmland' },
  potatoes: { age: 7, seed: 'potato', ground: 'farmland' }, beetroots: { age: 3, seed: 'beetroot_seeds', ground: 'farmland' },
  nether_wart: { age: 3, seed: 'nether_wart', ground: 'soul_sand' },
}
export const isMatureCrop = block => Boolean(CROPS[block?.name] && Number(blockProperties(block).age) >= CROPS[block.name].age)
async function plant(skills, bot, ground, crop, signal) {
  const recipe = CROPS[crop]
  const space = bot.blockAt(ground.position.offset(0, 1, 0))
  if (ground.name !== recipe.ground || !space || !['air', 'cave_air', 'void_air'].includes(space.name)) throw new Error('种植位置不是对应耕地/灵魂沙，或上方已被占用')
  const seed = bot.inventory.items().find(i => i.name === recipe.seed)
  if (!seed) throw new Error(`缺少 ${recipe.seed}，未播种`)
  await skills.approach(bot, ground, signal)
  await skills.guarded(bot.equip(seed, 'hand'), signal, 5000)
  await skills.guarded(bot.placeBlock(ground, new Vec3(0, 1, 0)), signal, 6000)
  await skills.inventoryBarrier(bot, signal)
  const planted = bot.blockAt(space.position)?.name === crop
  return { confirmed: planted, at: at(space.position), crop }
}
export async function farmAction(skills, args, signal) {
  const action = args.action ?? 'harvest', crop = itemName(args.crop ?? 'wheat')
  if (!CROPS[crop]) throw new Error('crop 支持 wheat/carrots/potatoes/beetroots/nether_wart')
  if (!['harvest', 'plant', 'till'].includes(action)) throw new Error('action 为 harvest/plant/till')
  const count = integer(args.count, 8, 1, 64, 'count'), radius = integer(args.radius, 16, 2, 32, 'radius')
  const budget = integer(args.budgetMs, 120000, 1000, 300000, 'budgetMs')
  return skills.run(`农务 ${action}`, signal, async (s, bot) => {
    if (action === 'plant') {
      const ground = selectBlock(bot, args, b => b.name === CROPS[crop].ground, '种植地面', radius)
      const result = await plant(skills, bot, ground, crop, s)
      return { ...result, outcome: result.confirmed ? 'succeeded' : 'partial' }
    }
    if (action === 'till') {
      const ground = selectBlock(bot, args, b => ['dirt', 'grass_block', 'dirt_path'].includes(b.name), '可锄地面', radius)
      if (!['air', 'cave_air', 'void_air'].includes(bot.blockAt(ground.position.offset(0, 1, 0))?.name)) return { outcome: 'blocked', confirmed: false, reason: '锄地上方被占用' }
      const hoe = ['netherite_hoe', 'diamond_hoe', 'iron_hoe', 'stone_hoe', 'golden_hoe', 'wooden_hoe'].map(name => bot.inventory.items().find(i => i.name === name)).find(Boolean)
      if (!hoe) throw new Error('背包中没有锄头')
      await skills.approach(bot, ground, s)
      await skills.guarded(bot.equip(hoe, 'hand'), s, 5000)
      await skills.guarded(bot.activateBlock(ground), s, 6000)
      await skills.inventoryBarrier(bot, s)
      const confirmed = bot.blockAt(ground.position)?.name === 'farmland'
      return { outcome: confirmed ? 'succeeded' : 'partial', confirmed, at: at(ground.position) }
    }
    const before = countItems(bot.inventory.items())
    const id = bot.registry.blocksByName[crop]?.id
    const candidates = (bot.findBlocks({ matching: id, maxDistance: radius, count: Math.min(128, count * 4) }) ?? []).map(p => bot.blockAt(p))
      .filter(b => b && b.name === crop && isMatureCrop(b))
      .sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position))
    let harvested = 0, replanted = 0, reason = null
    for (const initial of candidates.slice(0, count)) {
      assertLive(s)
      if (!isMatureCrop(bot.blockAt(initial.position))) continue
      try {
        await skills.guarded(bot.collectBlock.collect(initial, { ignoreNoPath: false }), s, 25000)
        await skills.inventoryBarrier(bot, s)
        if (isMatureCrop(bot.blockAt(initial.position))) { reason = '服务端没有确认收获'; continue }
        harvested++
        if (args.replant !== false) {
          const ground = bot.blockAt(initial.position.offset(0, -1, 0))
          const result = await plant(skills, bot, ground, crop, s)
          if (result.confirmed) replanted++; else reason = '播种未得到服务端确认'
        }
      } catch (e) { assertLive(s); reason = e.message; break }
    }
    const after = countItems(bot.inventory.items()), gained = Object.fromEntries(Object.entries(after).map(([name, n]) => [name, n - (before[name] ?? 0)]).filter(([, n]) => n > 0))
    const complete = harvested >= count && (args.replant === false || replanted === harvested)
    return { outcome: complete ? 'succeeded' : 'partial', confirmed: complete, crop, requested: count, harvested, replanted, gained,
      reason: complete ? null : reason ?? '附近成熟作物数量不足；未破坏未成熟作物' }
  }, budget)
}
