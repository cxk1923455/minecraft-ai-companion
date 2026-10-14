import { getHeapStatistics } from 'node:v8'

const attachments = new WeakMap()
const bounded = (n, fallback, min, max) => Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback

/** Bound the native search, including compute() continuations run on physicsTick.
 * Time slices alone do not bound the retained A* frontier. No dependency files
 * or global prototypes are patched; everything is scoped to this game body. */
export function attachPathfinderBudget(bot, options = {}) {
  if (attachments.has(bot)) return attachments.get(bot)
  const pf = bot.pathfinder
  const limits = {
    generatedNodes: Math.floor(bounded(options.generatedNodes, 8192, 64, 32768)),
    timeoutMs: bounded(options.timeoutMs, 2000, 10, 5000),
    tickMs: bounded(options.tickMs, 5, 1, 10),
    searchRadius: bounded(options.searchRadius, 64, 4, 128),
    heapRatio: bounded(options.heapRatio, 0.75, 0.5, 0.9),
  }
  const original = pf?.getPathFromTo, originalGoal = pf?.setGoal, originalMovements = pf?.setMovements
  const contexts = new Set()
  const stats = { searches: 0, limited: 0, cancelled: 0, generatedNodesMax: 0, last: null }
  const readHeap = options.readHeap ?? (() => ({ used: process.memoryUsage().heapUsed, limit: getHeapStatistics().heap_size_limit }))
  let detached = false

  function pressure() {
    const heap = readHeap()
    return heap.limit > 0 && heap.used >= heap.limit * limits.heapRatio
  }
  function retire(record) {
    if (record.retired) return
    record.retired = true
    contexts.delete(record)
    const context = record.context
    context?.closedDataSet?.clear()
    context?.openDataMap?.clear()
    if (context?.openHeap?.heap) context.openHeap.heap = [null]
    if (context) context.bestNode = null
    // Upstream uses visitedChunks to invalidate a path when a new chunk loads.
    // Keep the small set for terminal searches; do not retain path-node parents.
  }
  function resultLimited(record, result, reason) {
    if (!record.limited) { record.limited = true; stats.limited++ }
    const failed = { ...result, status: 'noPath', path: [], budgetExceeded: true, reason,
      generatedNodes: Math.min(record.generated, limits.generatedNodes), context: record.context }
    stats.last = { status: failed.status, generatedNodes: failed.generatedNodes, reason }
    retire(record)
    return failed
  }
  function inspect(record, result) {
    if (record.exceeded || result.generatedNodes > limits.generatedNodes) return resultLimited(record, result, '寻路节点预算耗尽，需换近处落脚点或换路线')
    if (pressure()) return resultLimited(record, result, 'DSH 后台内存压力过高，已停止扩展寻路以保护宿主')
    stats.generatedNodesMax = Math.max(stats.generatedNodesMax, result.generatedNodes ?? record.generated)
    stats.last = { status: result.status, generatedNodes: result.generatedNodes ?? record.generated, reason: result.reason ?? null }
    if (result.status !== 'partial') retire(record)
    return result
  }
  function cancelContexts() {
    for (const record of [...contexts]) { record.cancelled = true; stats.cancelled++; retire(record) }
  }

  const wrapped = original && function* (movements, start, goal, searchOptions = {}) {
    const record = { generated: 1, exceeded: false, context: null, retired: false, cancelled: false }
    // Copy the policy, rather than temporarily replacing getNeighbors on a
    // shared walking/harvesting policy. Limit allocation inside the first slice.
    const policy = Object.assign(Object.create(Object.getPrototypeOf(movements)), movements)
    if (movements.getNeighbors) policy.getNeighbors = function(node) {
      if (record.cancelled || record.exceeded) return []
      const neighbors = movements.getNeighbors.call(this, node)
      if (record.generated + neighbors.length > limits.generatedNodes) { record.exceeded = true; return [] }
      record.generated += neighbors.length
      return neighbors
    }
    stats.searches++
    // With an abandoned preview, do not keep any number of live frontiers.
    if (contexts.size >= 4) { const old = contexts.values().next().value; old.cancelled = true; retire(old) }
    const radius = searchOptions.searchRadius ?? pf.searchRadius
    const search = original.call(this, policy, start, goal, { ...searchOptions,
      timeout: bounded(searchOptions.timeout ?? pf.thinkTimeout, limits.timeoutMs, 1, limits.timeoutMs),
      tickTimeout: bounded(searchOptions.tickTimeout ?? pf.tickTimeout, limits.tickMs, 1, limits.tickMs),
      searchRadius: Number.isFinite(radius) && radius >= 0 ? Math.min(radius, limits.searchRadius) : limits.searchRadius,
    })
    try {
      if (pressure()) {
        yield { result: resultLimited(record, {}, 'DSH 后台内存压力过高，已停止扩展寻路以保护宿主'), astarContext: null }
        return
      }
      for (const value of search) {
        const context = value.astarContext ?? value.result?.context
        if (context && !record.context) {
          record.context = context
          contexts.add(record)
          const compute = context.compute
          context.compute = function() {
            if (record.retired || record.cancelled) return { status: 'noPath', path: [], reason: '旧寻路已结束或取消', context: this }
            if (pressure()) return resultLimited(record, {}, 'DSH 后台内存压力过高，已停止扩展寻路以保护宿主')
            return inspect(record, compute.call(this))
          }
        }
        const result = inspect(record, value.result)
        yield { ...value, result }
        if (result.status !== 'partial') return
      }
    } finally {
      search.return?.()
      retire(record)
    }
  }
  const setGoal = originalGoal && function(...args) { cancelContexts(); return originalGoal.apply(this, args) }
  const setMovements = originalMovements && function(...args) { cancelContexts(); return originalMovements.apply(this, args) }
  if (wrapped) pf.getPathFromTo = wrapped
  if (setGoal) pf.setGoal = setGoal
  if (setMovements) pf.setMovements = setMovements
  const state = {
    limits, cancel: cancelContexts,
    snapshot() {
      const heap = readHeap()
      return { ...stats, last: stats.last && { ...stats.last }, activeSearches: contexts.size, limits: { ...limits },
        hostHeapMB: Math.round(heap.used / 1048576), hostHeapLimitMB: Math.round(heap.limit / 1048576), memoryPressure: pressure() }
    },
    detach() {
      if (detached) return
      detached = true; cancelContexts()
      if (wrapped && pf.getPathFromTo === wrapped) pf.getPathFromTo = original
      if (setGoal && pf.setGoal === setGoal) pf.setGoal = originalGoal
      if (setMovements && pf.setMovements === setMovements) pf.setMovements = originalMovements
      attachments.delete(bot)
    },
  }
  attachments.set(bot, state)
  return state
}
