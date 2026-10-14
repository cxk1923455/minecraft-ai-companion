import vec3pkg from 'vec3'

const Vec3 = vec3pkg.Vec3 ?? vec3pkg
const HOSTILES = new Set(['zombie', 'zombie_villager', 'husk', 'drowned', 'skeleton', 'stray', 'wither_skeleton', 'spider', 'cave_spider', 'creeper', 'blaze', 'pillager', 'ravager', 'vindicator', 'slime', 'magma_cube', 'warden', 'ghast', 'phantom', 'bogged', 'breeze'])
const CONDITIONAL = new Set(['enderman', 'piglin', 'zombified_piglin', 'polar_bear', 'wolf', 'bee'])
const HAZARDS = /^(?:lava|flowing_lava|water|flowing_water|fire|soul_fire|cactus|magma_block|campfire|soul_campfire|powder_snow|sweet_berry_bush)$/
const STATIONS = /^(?:crafting_table|furnace|blast_furnace|smoker|enchanting_table|anvil|chipped_anvil|damaged_anvil|stonecutter|grindstone|smithing_table|brewing_stand|loom|cartography_table)$/
const CONTAINERS = /^(?:chest|trapped_chest|ender_chest|barrel|hopper|dispenser|dropper|(?:\w+_)?shulker_box)$/
const SOURCES = { diamond: ['diamond_ore', 'deepslate_diamond_ore'], coal: ['coal_ore', 'deepslate_coal_ore'], raw_iron: ['iron_ore', 'deepslate_iron_ore'], raw_copper: ['copper_ore', 'deepslate_copper_ore'], raw_gold: ['gold_ore', 'deepslate_gold_ore'], redstone: ['redstone_ore', 'deepslate_redstone_ore'], lapis_lazuli: ['lapis_ore', 'deepslate_lapis_ore'], cobblestone: ['stone', 'cobblestone'], cobbled_deepslate: ['deepslate', 'cobbled_deepslate'], clay_ball: ['clay'] }
const DIRECTIONS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]
const copy = value => structuredClone(value)
const clamp = (value, fallback, min, max) => Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Math.floor(Number(value)))) : fallback
const num = value => Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null
const point = value => value && [value.x, value.y, value.z].every(Number.isFinite) ? { x: num(value.x), y: num(value.y), z: num(value.z) } : null
const positionKey = value => `${value.x},${value.y},${value.z}`
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const text = (value, limit = 120) => typeof value === 'string' ? value.slice(0, limit) : null
function small(value, depth = 0) {
  if (value == null || typeof value === 'boolean') return value ?? null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') return value.slice(0, 240)
  if (depth > 3) return null
  if (Array.isArray(value)) return value.slice(0, 8).map(v => small(v, depth + 1))
  if (typeof value !== 'object') return null
  const result = {}
  let inspected = 0
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue
    if (++inspected > 16) break
    if (/token|password|secret|credential|auth|chat|message/i.test(key)) continue
    result[key] = small(value[key], depth + 1)
  }
  return result
}
function dimension(bot) {
  const value = bot?.game?.dimension
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  return text(value?.name) ?? text(value?.effects) ?? 'unknown'
}
function inventorySnapshot(bot, available) {
  const result = { counts: {}, stacks: [], available, complete: available, selectedSlot: available && Number.isInteger(bot?.quickBarSlot) ? bot.quickBarSlot : null, held: null }
  if (!available) return result
  const inventory = bot?.inventory
  let items
  try { items = inventory?.items?.() ?? [] } catch { items = []; result.complete = false }
  let inspected = 0
  for (const item of items) {
    if (++inspected > 128) { result.complete = false; break }
    if (!item || typeof item.name !== 'string' || !Number.isFinite(item.count) || item.count <= 0) continue
    const name = item.name.slice(0, 100)
    if (!Object.hasOwn(result.counts, name) && Object.keys(result.counts).length >= 64) { result.complete = false; continue }
    result.counts[name] = (result.counts[name] ?? 0) + item.count
    if (result.stacks.length < 64) result.stacks.push({ name, count: item.count, slot: Number.isInteger(item.slot) ? item.slot : null })
    else result.complete = false
  }
  const held = bot?.heldItem
  if (held?.name) result.held = { name: text(held.name, 100), count: Number.isFinite(held.count) ? held.count : null }
  result.counts = Object.fromEntries(Object.entries(result.counts).sort(([a], [b]) => a.localeCompare(b)))
  return result
}
function taskSnapshot(host) {
  let goal
  try { goal = host.skills?.goals?.view?.() ?? null } catch { goal = null }
  const task = goal ? Object.fromEntries(['id', 'kind', 'item', 'count', 'state', 'phase', 'deadline', 'who', 'error', 'progress', 'result'].map(key => [key, small(goal[key])])) : null
  return { goal: task, active: text(host.skills?.active?.label), follow: text(typeof host.skills?.follow === 'string' ? host.skills.follow : host.skills?.follow?.who), paused: host.skills?.paused === true }
}
function selfSnapshot(bot, connected) {
  return { online: connected, name: text(bot?.username), entityId: connected && Number.isFinite(bot?.entity?.id) ? bot.entity.id : null,
    position: connected ? point(bot?.entity?.position) : null, velocity: connected ? point(bot?.entity?.velocity) : null,
    health: connected ? num(bot?.health) : null, food: connected ? num(bot?.food) : null, oxygen: connected ? num(bot?.oxygenLevel) : null,
    onGround: connected && typeof bot?.entity?.onGround === 'boolean' ? bot.entity.onGround : null, dimension: connected ? dimension(bot) : 'unknown', gameMode: connected ? text(bot?.game?.gameMode) : null }
}
function blockProperties(block) {
  let properties
  try { properties = block.getProperties?.() } catch {}
  if (!properties || typeof properties !== 'object') return undefined
  return Object.fromEntries(['open', 'half', 'facing', 'hinge', 'type', 'waterlogged', 'lit', 'age'].filter(key => Object.hasOwn(properties, key)).map(key => [key, small(properties[key])]))
}
function clear(block) {
  return Boolean(block) && !HAZARDS.test(block.name) && !/_door$|_trapdoor$/.test(block.name) && block.boundingBox === 'empty'
}
function supportHeight(block) {
  if (!block || HAZARDS.test(block.name) || /_door$|_trapdoor$/.test(block.name)) return null
  if (Array.isArray(block.shapes) && block.shapes.length) {
    const heights = block.shapes.filter(shape => Array.isArray(shape) && shape.length >= 6 && Number.isFinite(shape[4])).map(shape => shape[4])
    return heights.length ? Math.max(...heights) : null
  }
  return block.boundingBox === 'block' ? 1 : null
}
function keyFor(value) { return value.id != null ? String(value.id) : `${value.kind ?? value.name}:${positionKey(value.position)}` }
function collectionChanges(before, after, canConfirmRemoval = () => false) {
  const previous = new Map(before.map(value => [keyFor(value), value])), current = new Map(after.map(value => [keyFor(value), value]))
  const result = { added: [], updated: [], removed: [], forgotten: [] }
  for (const [key, value] of current) {
    if (!previous.has(key)) result.added.push(value)
    else if (JSON.stringify(previous.get(key)) !== JSON.stringify(value)) result.updated.push(value)
  }
  for (const [key, value] of previous) if (!current.has(key)) (canConfirmRemoval(value) ? result.removed : result.forgotten).push(value)
  return result
}

/** A bounded local sensor. Unknown chunks and unsampled terrain are never interpreted as air. */
export class WorldObserver {
  constructor(host, options = {}) {
    this.host = host
    this.now = options.now ?? Date.now
    this.clock = options.clock ?? (() => performance.now())
    this.ttlMs = clamp(options.ttlMs, 250, 0, 1000)
    this.budgetMs = clamp(options.budgetMs, 8, 1, 20)
    this.maxBlockReads = clamp(options.maxBlockReads, 768, 32, 1024)
    this.maxEntityReads = clamp(options.maxEntityReads, 256, 8, 512)
    this.bot = null
    this.inventory = null
    this.epoch = 0
    this.revision = 0
    this.history = new Map()
    this.cache = null
    this.dirty = true
    this.resetRequested = false
    this.listeners = []
    this.inventoryListener = () => { this.dirty = true }
  }
  dispose() {
    for (const [emitter, event, listener] of this.listeners) emitter.removeListener?.(event, listener)
    this.listeners = []
    this.inventory?.removeListener?.('updateSlot', this.inventoryListener)
    this.inventory = null
    this.bot = null
    this.cache = null
    this.history.clear()
  }
  synchronise(bot) {
    const world = dimension(bot)
    if (bot !== this.bot || world !== this.world || this.resetRequested) {
      this.dispose()
      this.bot = bot
      this.world = world
      this.epoch++
      this.resetRequested = false
      this.dirty = true
      if (bot?.on) {
        for (const event of ['blockUpdate', 'entityMoved', 'entitySpawn', 'entityGone', 'playerJoined', 'playerLeft', 'health', 'game', 'heldItemChanged', 'windowOpen', 'windowClose', 'end']) {
          const listener = () => { this.dirty = true }
          bot.on(event, listener)
          this.listeners.push([bot, event, listener])
        }
        const listener = () => { this.dirty = true; this.resetRequested = true }
        bot.on('respawn', listener)
        this.listeners.push([bot, 'respawn', listener])
      }
    }
    if (bot?.inventory !== this.inventory) {
      this.inventory?.removeListener?.('updateSlot', this.inventoryListener)
      this.inventory = bot?.inventory ?? null
      this.inventory?.on?.('updateSlot', this.inventoryListener)
      this.dirty = true
    }
  }
  observe(args = {}) {
    if (args.signal?.aborted) throw Object.assign(new Error('Minecraft observation was cancelled'), { mcAborted: true })
    const bot = this.host?.bot ?? null
    this.synchronise(bot)
    const radius = clamp(args.radius, 24, 4, 48), detail = args.detail === 'full' ? 'full' : 'compact'
    const item = text(args.item, 100), optionsKey = JSON.stringify([radius, detail, item])
    const now = this.now(), online = Boolean(bot?.entity?.position) && bot?._client?.ended !== true && this.host?.online !== false
    const self = selfSnapshot(bot, online), inventory = inventorySnapshot(bot, online), task = taskSnapshot(this.host)
    const quickKey = JSON.stringify([self, inventory, task])
    let entry
    if (!this.dirty && this.cache?.optionsKey === optionsKey && this.cache.quickKey === quickKey && now - this.cache.at < this.ttlMs) entry = this.cache.entry
    else {
      entry = this.sample({ bot, radius, detail, item, self, inventory, task, online, now, signal: args.signal })
      const facts = JSON.stringify([optionsKey, entry.frame.self, entry.frame.inventory, entry.frame.task, entry.frame.players, entry.frame.threats, entry.frame.landmarks, entry.frame.terrain])
      if (this.cache?.facts === facts) entry.frame.revision = this.cache.entry.frame.revision
      else entry.frame.revision = ++this.revision
      entry.frame.connectionEpoch = this.epoch
      this.history.set(entry.frame.revision, entry)
      while (this.history.size > 8) this.history.delete(this.history.keys().next().value)
      this.cache = { entry, facts, optionsKey, quickKey, at: now }
      this.dirty = false
    }
    const result = copy(entry.frame)
    if (args.delta || args.sinceRevision !== undefined) result.changes = this.changes(entry, args.sinceRevision)
    else result.changes = null
    return result
  }
  sample({ bot, radius, detail, item, self, inventory, task, online, now, signal }) {
    const started = this.clock(), blockLimit = Math.min(this.maxBlockReads, detail === 'full' ? 768 : 320)
    const observedBlocks = new Map(), landmarks = { trees: [], resources: [], stations: [], doors: [], containers: [] }
    const terrain = { columns: [], frontiers: [], hazards: [], selfSupport: null, unknownSamples: 0, pathChecked: false }
    const stats = { blockReads: 0, entityReads: 0, blockReadLimit: blockLimit, entityReadLimit: this.maxEntityReads, budgetMs: this.budgetMs, budgetExhausted: false, entityScanComplete: true, entityResultsTruncated: false }
    const atLimit = () => {
      if (signal?.aborted) throw Object.assign(new Error('Minecraft observation was cancelled'), { mcAborted: true })
      if ((this.host?.bot ?? null) !== bot || this.resetRequested) throw Object.assign(new Error('Minecraft body changed during observation'), { mcAborted: true })
      return stats.budgetExhausted ||= stats.blockReads >= blockLimit || this.clock() - started >= this.budgetMs
    }
    const seenLandmarks = new Set(), requested = new Set(SOURCES[item] ?? (item ? [item] : []))
    const read = (x, y, z) => {
      const pos = { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) }, key = positionKey(pos)
      if (observedBlocks.has(key)) return observedBlocks.get(key)
      if (atLimit()) return undefined
      let block
      try { block = bot?.blockAt?.(new Vec3(pos.x, pos.y, pos.z)) ?? null } catch { block = null }
      stats.blockReads++
      observedBlocks.set(key, block)
      if (!block) { terrain.unknownSamples++; return null }
      const name = typeof block.name === 'string' ? block.name : 'unknown'
      const d = self.position ? num(distance(self.position, pos)) : null
      const base = { name, position: pos, distance: d }
      if (HAZARDS.test(name) && terrain.hazards.length < 16) terrain.hazards.push({ ...base, kind: /water/.test(name) ? 'water' : name })
      let kind
      if (/^log2?$|_log$|_stem$/.test(name) && !/^stripped_/.test(name)) kind = 'trees'
      else if (/_ore$/.test(name) || requested.has(name)) kind = 'resources'
      else if (STATIONS.test(name)) kind = 'stations'
      else if (CONTAINERS.test(name)) kind = 'containers'
      else if (/_door$|_trapdoor$|_fence_gate$/.test(name)) kind = 'doors'
      if (kind && landmarks[kind].length < 16 && !seenLandmarks.has(key)) {
        seenLandmarks.add(key)
        const value = { ...base, kind, properties: blockProperties(block) }
        if (kind === 'resources') value.requiresHarvestTool = Boolean(block.harvestTools && Object.keys(block.harvestTools).length)
        landmarks[kind].push(value)
      }
      return block
    }
    // Entities are cheap protocol facts and immediate threats matter more than an extra terrain probe.
    const players = [], threats = []
    const keepNearest = (list, value) => {
      list.push(value)
      list.sort((a, b) => a.distance - b.distance)
      if (list.length > 16) { list.pop(); stats.entityResultsTruncated = true }
    }
    if (online && self.position) {
      for (const id in bot?.entities ?? {}) {
        if (!Object.hasOwn(bot.entities, id)) continue
        if (stats.entityReads >= this.maxEntityReads || this.clock() - started >= this.budgetMs) { stats.entityScanComplete = false; stats.budgetExhausted ||= this.clock() - started >= this.budgetMs; break }
        if (signal?.aborted) throw Object.assign(new Error('Minecraft observation was cancelled'), { mcAborted: true })
        stats.entityReads++
        const entity = bot.entities[id], p = point(entity?.position)
        if (!p || entity === bot.entity || entity.id === bot.entity?.id || distance(p, self.position) > radius) continue
        const name = text(entity.name) ?? text(entity.mobType) ?? 'unknown'
        const base = { id: Number.isFinite(entity.id) ? entity.id : text(id), name, position: p, distance: num(distance(p, self.position)) }
        if (entity.type === 'player' || entity.username) {
          keepNearest(players, { ...base, name: text(entity.username) ?? name })
        }
        if (HOSTILES.has(name) || CONDITIONAL.has(name)) {
          keepNearest(threats, { ...base, risk: CONDITIONAL.has(name) ? 'conditional' : 'potentially_hostile' })
        }
      }
    }
    const origin = self.position && { x: Math.floor(self.position.x), y: Math.floor(self.position.y), z: Math.floor(self.position.z) }
    if (online && origin) {
      const below = read(origin.x, origin.y - 1, origin.z)
      terrain.selfSupport = below ? { name: below.name, position: { x: origin.x, y: origin.y - 1, z: origin.z }, hazardous: HAZARDS.test(below.name) } : { known: false }
      const terrainLimit = Math.min(Math.floor(blockLimit * 0.48), stats.blockReads + (detail === 'full' ? 320 : 152))
      const distances = [...new Set([2, Math.max(3, Math.floor(radius / 2)), radius])]
      for (const d of distances) {
        for (const [dx, dz] of DIRECTIONS) {
          if (atLimit() || stats.blockReads >= terrainLimit) break
          const scale = d / Math.hypot(dx, dz), x = Math.round(origin.x + dx * scale), z = Math.round(origin.z + dz * scale)
          const offsets = [0, 1, -1, 2, -2, 3, -3, 4, -4, 6, -6, 8, -8].slice(0, detail === 'full' ? 13 : (d <= 2 ? 5 : 9))
          let candidate, unknown = false, inspected = 0
          for (const offset of offsets) {
            if (atLimit() || stats.blockReads >= terrainLimit) break
            inspected++
            const y = origin.y + offset, support = read(x, y - 1, z)
            if (!support) { unknown ||= support === null; continue }
            const height = supportHeight(support)
            if (height === null || height <= 0) continue
            const feet = read(x, y, z), head = read(x, y + 1, z)
            unknown ||= feet === null || head === null
            if (clear(feet) && clear(head)) { candidate = { position: { x, y: num(y - 1 + height), z }, support: support.name, heightDelta: num(y - 1 + height - self.position.y), loaded: true, pathChecked: false, reachable: null }; break }
          }
          terrain.columns.push(candidate ?? { position: { x, z }, loaded: unknown ? false : null, unknown, inspectedHeights: inspected, reason: unknown ? 'unloaded_samples' : 'no_verified_standing_surface' })
          if (candidate && d >= 3 && terrain.frontiers.length < 12) terrain.frontiers.push({ ...candidate, direction: { x: dx, z: dz }, reason: 'loaded_surface_candidate_requires_pathfinding' })
        }
      }
      // Stratified probes cover every distance band before extra height layers, rather than only the nearby altitude.
      const rings = [...new Set([1, 3, Math.min(6, radius), Math.max(4, Math.floor(radius / 2)), radius])]
      for (const dy of [0, 1, -1, 2, 4]) {
        for (const d of rings) {
          for (const [dx, dz] of DIRECTIONS) {
            if (atLimit()) break
            const scale = d / Math.hypot(dx, dz)
            read(Math.round(origin.x + dx * scale), origin.y + dy, Math.round(origin.z + dz * scale))
          }
          if (atLimit()) break
        }
        if (atLimit()) break
      }
    }
    if (signal?.aborted || (this.host?.bot ?? null) !== bot || this.resetRequested) throw Object.assign(new Error('Minecraft observation was interrupted'), { mcAborted: true })
    for (const list of [players, threats, ...Object.values(landmarks), terrain.hazards]) list.sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0))
    const elapsed = Math.max(0, this.clock() - started)
    const frame = { schemaVersion: 1, revision: 0, observedAt: now, connectionEpoch: this.epoch,
      scope: { radius, detail, source: 'mineflayer_protocol_state', coverage: 'bounded_samples_of_loaded_local_world', globalMap: false, unknownIsAir: false,
        requestedItem: item, verticalOffsets: detail === 'full' ? [-9, 9] : [-5, 5], missingLandmarkIsAbsent: false, inventoryComplete: inventory.complete, ...stats, elapsedMs: num(elapsed) },
      self, inventory, players, threats, landmarks, terrain, task, changes: null }
    // Retain only position/name facts, never the mutable Prismarine block objects or credential-bearing bot.
    const blocks = new Map([...observedBlocks].map(([key, block]) => [key, block ? { name: block.name } : null]))
    return { frame, blocks }
  }
  changes(entry, sinceRevision) {
    const previous = this.history.get(sinceRevision)
    const sameEpoch = previous?.frame.connectionEpoch === entry.frame.connectionEpoch
    const result = { sinceRevision: Number.isInteger(sinceRevision) ? sinceRevision : null, baselineAvailable: Boolean(previous && sameEpoch), reset: !previous || !sameEpoch,
      note: 'forgotten means outside this sample or no longer observed; it does not prove destruction or death.' }
    if (!previous || !sameEpoch) return result
    const before = previous.frame, after = entry.frame
    result.selfChanged = JSON.stringify(before.self) !== JSON.stringify(after.self)
    result.taskChanged = JSON.stringify(before.task) !== JSON.stringify(after.task)
    result.players = collectionChanges(before.players, after.players)
    result.threats = collectionChanges(before.threats, after.threats)
    result.landmarks = Object.fromEntries(Object.keys(after.landmarks).map(kind => [kind, collectionChanges(before.landmarks[kind], after.landmarks[kind], value => {
      const block = entry.blocks.get(positionKey(value.position))
      return Boolean(block) && block.name !== value.name
    })]))
    result.inventory = { gained: {}, lost: {}, complete: before.inventory.complete && after.inventory.complete }
    if (result.inventory.complete) for (const name of new Set([...Object.keys(before.inventory.counts), ...Object.keys(after.inventory.counts)])) {
      const difference = (after.inventory.counts[name] ?? 0) - (before.inventory.counts[name] ?? 0)
      if (difference > 0) result.inventory.gained[name] = difference
      if (difference < 0) result.inventory.lost[name] = -difference
    }
    return result
  }
}
