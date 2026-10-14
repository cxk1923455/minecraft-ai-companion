/** Compact observed facts for the current model step; never infer task success. */
export function runtimeState(host, { commandsEnabled = false } = {}) {
  if (!host?.online || !host.bot?.entity?.position) return null
  const bot = host.bot
  const state = host.skills.status()
  const me = bot.entity.position
  const observed = host.observer?.observe({ detail: 'compact', radius: 16 })
  const players = Object.entries(bot.players ?? {}).filter(([,p]) => p.entity?.position && p.entity !== bot.entity)
    .map(([name,p]) => ({ name, position:{x:Math.floor(p.entity.position.x),y:Math.floor(p.entity.position.y),z:Math.floor(p.entity.position.z)}, distance:Number(me.distanceTo(p.entity.position).toFixed(2)) }))
    .sort((a,b)=>a.distance-b.distance).slice(0,4)
  return { observedAt:Date.now(), online:true, position:state.position, players, follow:state.follow,
    active:state.active, lastAction:state.lastResult,
    goal:state.goal ? {id:state.goal.id,kind:state.goal.kind,item:state.goal.item,state:state.goal.state,phase:state.goal.phase,progress:state.goal.progress,deadline:state.goal.deadline,error:state.goal.error} : null,
    observation: observed ? { revision: observed.revision, connectionEpoch: observed.connectionEpoch, inventory: observed.inventory.counts,
      threats: observed.threats.slice(0, 4), landmarks: Object.fromEntries(Object.entries(observed.landmarks).map(([key, items]) => [key, items.slice(0, 4)])), scope: observed.scope } : null,
    commandsEnabled:commandsEnabled === true }
}
