/** Only complete, unambiguous movement requests use the local fast path. */
export function localChatIntent(text, aliases = []) {
  let value = String(text ?? '').trim()
  for (const alias of aliases) {
    try { value = value.replace(new RegExp(`^(?:${alias})[\\s,，:：!！]*`, 'i'), '') } catch {}
  }
  value = value.replace(/^[\s,，:：]+|[\s。.!！?？~～]+$/g, '').replace(/^(?:请|麻烦|快点|赶紧)\s*/, '')
  if (/^(?:跟着我|跟随我|跟我走|跟上我|follow me)$/i.test(value)) return 'follow'
  if (/^(?:过来|进来|到屋里来|进屋来|来我这(?:里)?|到我这(?:里)?来|come (?:here|to me))$/i.test(value)) return 'come'
  if (/^(?:停下|停一下|停止(?:动作|移动|跟随)?|别跟(?:着)?我(?:了)?|stop(?: moving| following)?|halt)$/i.test(value)) return 'halt'
  return null
}
