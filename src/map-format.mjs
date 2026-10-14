const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c])
const strideFor = (width, height, desired = 1) => Math.max(1, Math.floor(Number(desired) || 1), Math.ceil(Math.sqrt(width * height / 4096)))
function runs(row) {
  const result = []
  for (const value of row) {
    const last = result.at(-1)
    if (last?.[0] === value) last[1]++
    else result.push([value, 1])
  }
  return result
}
/** Compact coordinates and palette IDs are facts; null remains an unknown tile. */
export function mapGridData(map, { step = 2 } = {}) {
  const s = strideFor(map.names[0]?.length ?? 0, map.names.length, step), palette = [null], ids = new Map([[null, 0]])
  const rows = [], heights = []
  for (let z = 0; z < map.names.length; z += s) {
    const row = [], ys = []
    for (let x = 0; x < map.names[z].length; x += s) {
      const name = map.names[z][x] ?? null
      if (!ids.has(name)) { ids.set(name, palette.length); palette.push(name) }
      row.push(ids.get(name)); ys.push(map.heights?.[z]?.[x] ?? null)
    }
    rows.push(runs(row)); heights.push(ys)
  }
  return { schemaVersion: 1, kind: 'surface_blocks', encoding: 'palette_run_length_rows',
    origin: { x: map.center.x - map.radius, z: map.center.z - map.radius }, step: s,
    width: rows.length ? Math.ceil(map.names[0].length / s) : 0, height: rows.length,
    axes: { rows: 'north_to_south', columns: 'west_to_east' }, palette, rows, heights,
    self: map.center, scope: 'sampled_loaded_columns_in_requested_vertical_window', unknownIndex: 0, unknownIsAir: false }
}
export function heightGridData(grid) {
  const stride = strideFor(grid.gridWidth, grid.gridHeight), heights = grid.heights.filter((_, i) => i % stride === 0).map(row => row.filter((_, i) => i % stride === 0))
  const radius = grid.radius ?? Math.floor(grid.gridWidth * grid.step / 2)
  return { schemaVersion: 1, kind: 'surface_heights', self: grid.center, origin: { x: grid.center.x - radius, z: grid.center.z - radius },
    step: grid.step * stride, width: heights[0]?.length ?? 0, height: heights.length,
    axes: { rows: 'north_to_south', columns: 'west_to_east' }, heights, min: grid.min, max: grid.max, unknown: null, unknownIsAir: false,
    scope: 'sampled_loaded_surface_columns; not a traversability certificate' }
}
function blockColor(name) {
  if (name === null) return '#4b5563'
  if (/lava|fire/.test(name)) return '#f97316'
  if (/water|ice/.test(name)) return '#3b82f6'
  if (/log|wood|plank|stem/.test(name)) return '#a57546'
  if (/grass|leaves|moss|crop/.test(name)) return '#51a55e'
  if (/sand/.test(name)) return '#dfcc94'
  if (/snow/.test(name)) return '#e5edf6'
  if (/dirt|farmland/.test(name)) return '#876244'
  return '#8f98a4'
}
/** Optional human-readable vector map; AI decisions consume the JSON, not this drawing. */
export function gridSvg(data) {
  const cell = 8, margin = 36, width = Math.max(1, data.width) * cell + margin * 2, height = Math.max(1, data.height) * cell + 72
  const shapes = []
  for (let z = 0; z < data.height; z++) {
    const row = data.kind === 'surface_blocks' ? data.rows[z] : runs(data.heights[z])
    let x = 0
    for (const [value, length] of row) {
      const color = data.kind === 'surface_blocks' ? blockColor(data.palette[value]) : value === null ? '#4b5563' : `hsl(${Math.round(210 - 160 * (value - data.min) / Math.max(1, data.max - data.min))} 52% 53%)`
      shapes.push(`<rect x="${margin + x * cell}" y="${28 + z * cell}" width="${length * cell}" height="${cell}" fill="${color}"/>`)
      x += length
    }
  }
  const caption = `N ↑ · W ← · x=${data.origin.x}, z=${data.origin.z} · ${data.step} blocks/cell · gray=?`
  const marker = data.self ? `<circle cx="${margin + (data.self.x - data.origin.x) / data.step * cell}" cy="${28 + (data.self.z - data.origin.z) / data.step * cell}" r="4" fill="#f8fafc" stroke="#111827"/>` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img"><title>${escape(caption)}</title><rect width="100%" height="100%" fill="#10151d"/>${shapes.join('')}${marker}<text x="${margin}" y="${height - 18}" fill="#eef3fb" font-family="sans-serif" font-size="11">${escape(caption)}</text></svg>`
}
