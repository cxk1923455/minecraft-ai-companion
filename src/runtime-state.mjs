/** Compact observed facts for the current model step; never infer task success. */
export function runtimeState(host, { commandsEnabled = false } = {}) {
  if (!host?.online || !host.bot?.entity?.position) return null
  const bot = host.bot
  const state = host.skills.status()
  const me = bot.entity.position
  const players = Object.entries(bot.players ?? {}).filter(([,p]) => p.entity?.position && p.entity !== bot.entity)
    .map(([name,p]) => ({ name, position:{x:Math.floor(p.entity.position.x),y:Math.floor(p.entity.position.y),z:Math.floor(p.entity.position.z)}, distance:Number(me.distanceTo(p.entity.position).toFixed(2)) }))
    .sort((a,b)=>a.distance-b.distance).slice(0,4)
  return { observedAt:Date.now(), online:true, position:state.position, players, follow:state.follow,
    active:state.active, lastAction:state.lastResult,
    goal:state.goal ? {kind:state.goal.kind,state:state.goal.state} : null,
    commandsEnabled:commandsEnabled === true }
}
