import { isDeepStrictEqual } from 'node:util'
import vec3pkg from 'vec3'
const Vec3 = vec3pkg.Vec3 ?? vec3pkg

export function assertLive(signal) { signal?.throwIfAborted() }
export function integer(value, fallback, min, max, name) {
  const n = value === undefined ? fallback : Number(value)
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} 必须为 ${min}–${max} 的整数`)
  return n
}
export function pause(ms, signal) {
  assertLive(signal)
  return new Promise((resolve, reject) => {
    const done = error => { clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve() }
    const abort = () => done(new Error('动作已中断'))
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}
export const itemName = value => String(value ?? '').replace(/^minecraft:/, '')
export const at = p => ({ x: p.x, y: p.y, z: p.z })
export const sameItem = (a, b) => Boolean(a && b && a.type === b.type && a.metadata === b.metadata
  && isDeepStrictEqual(a.nbt, b.nbt) && isDeepStrictEqual(a.components, b.components))
export const itemView = item => item ? { slot: item.slot, name: item.name, count: item.count, metadata: item.metadata,
  ...(item.customName ? { customName: item.customName } : {}), ...(item.enchants?.length ? { enchants: item.enchants } : {}) } : null
export function countItems(items) {
  const result = {}
  for (const item of items.filter(Boolean)) result[item.name] = (result[item.name] ?? 0) + item.count
  return result
}
export function selectBlock(bot, args, predicate, label, defaultRadius = 24) {
  const supplied = ['x', 'y', 'z'].filter(k => args[k] !== undefined)
  if (supplied.length && (supplied.length !== 3 || !supplied.every(k => Number.isInteger(args[k])))) throw new Error('方块坐标 x/y/z 必须一起提供，且为整数')
  let block
  if (supplied.length) block = bot.blockAt(new Vec3(args.x, args.y, args.z))
  else {
    const radius = integer(args.radius, defaultRadius, 2, 64, 'radius')
    const ids = bot.registry.blocksArray.filter(predicate).map(b => b.id)
    const points = ids.length ? bot.findBlocks({ matching: ids, maxDistance: radius, count: 24 }) ?? [] : []
    block = points.map(p => bot.blockAt(p)).filter(b => b && predicate(b))
      .sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position))[0]
  }
  if (!block || !predicate(block)) throw new Error(`没有找到已加载的${label}，可指定 mc_scan 返回的坐标`)
  return block
}

/** Use public interaction APIs with an abortable listener (no abandoned openBlock once()). */
export async function openBlockWindow(bot, block, signal, { timeoutMs = 6000, accept = () => true } = {}) {
  assertLive(signal)
  let timer, abort, opened, closed
  const result = new Promise((resolve, reject) => {
    const finish = (error, window) => {
      clearTimeout(timer); bot.off('windowOpen', opened); bot.off('end', closed); signal?.removeEventListener('abort', abort)
      error ? reject(error) : resolve(window)
    }
    opened = window => {
      if (!accept(window)) { try { bot.closeWindow(window) } catch {}; finish(new Error(`服务器打开了非预期界面 ${window.type}`)); return }
      finish(null, window)
    }
    closed = () => finish(new Error('连接已断开'))
    abort = () => finish(new Error('打开界面已中断'))
    timer = setTimeout(() => finish(new Error('服务器没有打开容器；检查距离、上方遮挡或领地权限')), timeoutMs)
    bot.on('windowOpen', opened); bot.once('end', closed); signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
  void result.catch(() => {})
  try { await bot.activateBlock(block); assertLive(signal); return await result }
  catch (e) { abort(); throw e }
}
export async function closeBlockWindow(bot, window) {
  if (window && bot.currentWindow === window) await bot.closeWindow(window)
}
