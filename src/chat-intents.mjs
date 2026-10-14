/** Only complete, unambiguous movement requests use the local fast path. */
export function localChatIntent(text, aliases = []) {
  let value = String(text ?? '').trim()
  for (const alias of aliases) {
    try { value = value.replace(new RegExp(`^(?:${alias})[\\s,，:：!！]*`, 'i'), '') } catch {}
  }
  value = value.replace(/^[\s,，:：]+|[\s。.!！?？~～]+$/g, '').replace(/^(?:请|麻烦|快点|赶紧)\s*/, '')
  value = value.replace(/^你\s*/, '')
  if (/^(?:进来|到屋里来|进屋(?:来)?|进房间(?:里)?(?:来)?|到房间里来|come inside)$/i.test(value)) return 'enter'
  if (/^(?:跟着我|跟随我|跟我走|跟上我|follow me)$/i.test(value)) return 'follow'
  if (/^(?:过来|来我这(?:里)?|到我这(?:里)?来|come (?:here|to me))$/i.test(value)) return 'come'
  if (/^(?:暂停任务|暂停采集|暂停挖矿|pause task)$/i.test(value)) return 'pause'
  if (/^(?:继续任务|继续采集|继续挖矿|resume task)$/i.test(value)) return 'resume'
  if (/^(?:停下|停一下|取消任务|停止(?:任务|动作|移动|跟随)?|别跟(?:着)?我(?:了)?|stop(?: moving| following)?|halt)$/i.test(value)) return 'halt'
  return null
}
