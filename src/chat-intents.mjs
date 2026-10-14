const mentionCache = new Map()
/** Small, bounded patterns preserve nickname regexes without permitting backtracking programs. */
export function mentionRegex(pattern, prefix = false) {
  if (typeof pattern !== 'string' || !pattern || pattern.length > 128) return null
  const key = `${prefix ? 'prefix' : 'search'}:${pattern}`
  if (mentionCache.has(key)) return mentionCache.get(key)
  const syntax = pattern.replace(/\\./g, 'E').replace(/\[(?:\\.|[^\]\\])*\]/g, 'C')
  if (/[(){}]/.test(syntax) || /\\[1-9]|\\k</.test(pattern)
    || (syntax.match(/[?*+]/g) ?? []).length > 2 || (syntax.match(/[*+]/g) ?? []).length > 1) return null
  try {
    const regex = new RegExp(prefix ? `^(?:${pattern})[\\s,，:：!！]*` : `(?:${pattern})`, 'i')
    mentionCache.set(key, regex)
    while (mentionCache.size > 128) mentionCache.delete(mentionCache.keys().next().value)
    return regex
  } catch { return null }
}
export function stripChatAddress(text, aliases = []) {
  if (String(text ?? '').length > 2048) return ''
  let value = String(text ?? '').trim()
  for (const alias of aliases.slice(0, 64)) {
    const pattern = mentionRegex(alias, true)
    if (pattern) value = value.replace(pattern, '')
  }
  return value
}

/** Only complete, unambiguous movement requests use the local fast path. */
export function localChatIntent(text, aliases = []) {
  let value = stripChatAddress(text, aliases)
  value = value.replace(/^[\s,，:：]+|[\s。.!！?？~～]+$/g, '').replace(/^(?:请|麻烦|快点|赶紧)\s*/, '')
  value = value.replace(/^你\s*/, '')
  if (/^(?:进来|到屋里来|进屋(?:来)?|进房间(?:里)?(?:来)?|到房间里来|come inside)$/i.test(value)) return 'enter'
  if (/^(?:跟着我|跟随我|跟我走|跟上我|follow me)$/i.test(value)) return 'follow'
  if (/^(?:过来|来我这(?:里)?|到我这(?:里)?来|come (?:here|to me))$/i.test(value)) return 'come'
  if (/^(?:暂停任务|暂停采集|暂停挖矿|pause task)$/i.test(value)) return 'pause'
  if (/^(?:继续任务|继续采集|继续挖矿|继续挖|继续(?:去)?找|继续|resume task)$/i.test(value)) return 'resume'
  if (/^(?:(?:去)?自己(?:去)?找(?:资源|材料|矿石)?|自己(?:去)?(?:找|挖|完成)(?:原来的?|这个|你的?)?任务|独自(?:去)?找|别跟(?:着)?我(?:了)?[，,\s]*(?:去)?完成(?:原来的?|这个)?任务)$/i.test(value)) return 'continue'
  if (/^(?:停下|停一下|取消任务|停止(?:任务|动作|移动|跟随)?|别跟(?:着)?我(?:了)?|stop(?: moving| following)?|halt)$/i.test(value)) return 'halt'
  return null
}
