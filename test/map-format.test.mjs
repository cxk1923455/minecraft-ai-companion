import test from 'node:test'
import assert from 'node:assert/strict'
import { mapGridData, heightGridData, gridSvg } from '../src/map-format.mjs'
import { McBot } from '../src/core.mjs'

test('map JSON preserves named tiles, height and coordinate origin without turning unknown into air', () => {
  const data = mapGridData({ names: [['stone', 'stone', null], ['oak_log', 'water', 'water']], heights: [[64, 64, null], [62, 60, 60]], center: { x: 10, y: 64, z: 20 }, radius: 3 }, { step: 1 })
  assert.deepEqual(data.origin, { x: 7, z: 17 }); assert.equal(data.unknownIsAir, false)
  assert.deepEqual(data.rows[0], [[1, 2], [0, 1]])
  assert.equal(data.palette[1], 'stone'); assert.equal(data.heights[1][0], 62)
})
test('large map responses sample at most 4096 cells and report the effective world step', () => {
  const names = Array.from({ length: 192 }, () => Array(192).fill('stone'))
  const data = mapGridData({ names, center: { x: 0, y: 64, z: 0 }, radius: 96 }, { step: 1 })
  assert.equal(data.step, 3); assert.equal(data.width * data.height, 4096)
  assert.equal(data.rows[0].length, 1)
})
test('height sampling keeps the true origin when radius is not divisible by step', () => {
  const data = heightGridData({ center: { x: 10, y: 64, z: 20 }, radius: 5, gridWidth: 4, gridHeight: 4, step: 3, min: 60, max: 65, heights: Array.from({ length: 4 }, () => [60, 65, null, 62]) })
  assert.deepEqual(data.origin, { x: 5, z: 15 }); assert.equal(data.heights[0][2], null)
  assert.equal(data.step, 3)
  const svg = gridSvg(data)
  assert.ok(svg.startsWith('<svg')); assert.ok(svg.includes('<circle')); assert.ok(svg.includes('gray=?'))
})
test('PNG rendering can reuse a single observed map or height grid rather than scanning twice', () => {
  const host = Object.create(McBot.prototype), center = { x: 0, y: 64, z: 0 }
  host.heightmap = () => { throw new Error('unexpected second map scan') }
  host.heightGrid = () => { throw new Error('unexpected second height scan') }
  assert.equal(host.mapImage({ heightmap: { names: [['stone']], center, radius: 1, unloaded: 0, legend: [] }, scale: 1 }).width, 1)
  assert.equal(host.heightImage({ grid: { heights: [[64]], center, startY: 64, step: 1, min: 64, max: 64 }, scale: 1 }).width, 1)
})
test('an unloaded block above solid terrain is not fabricated as a confirmed surface', () => {
  const host = Object.create(McBot.prototype)
  host.bot = { blockAt: p => p.y === 64 ? { name: 'stone' } : null }
  assert.equal(host.surfaceY(0, 64, 0, -64, 319), null)
})
test('fractional image scale resolves to integral pixels and a consistent RGBA size', () => {
  const host = Object.create(McBot.prototype), center = { x: 0, y: 64, z: 0 }
  const image = host.mapImage({ heightmap: { names: [['stone', 'water']], center, radius: 1, unloaded: 0, legend: [] }, scale: 1.5 })
  assert.equal(image.scale, 1); assert.equal(image.width, 2); assert.equal(image.rgba.length, image.width * image.height * 4)
})
test('extreme map height offsets are bounded to the actual world rather than starting a huge loop', () => {
  const host = Object.create(McBot.prototype)
  let reads = 0
  host.requireBot = () => ({ entity: { position: { x: 0, y: 64, z: 0 } }, game: { minY: 0, height: 128 },
    blockAt: p => { reads++; return { name: p.y === 0 ? 'stone' : 'air' } } })
  const map = host.heightmap({ radius: 4, yTop: 1e12, yBottom: -1e12 })
  assert.ok(reads <= 64 * 128); assert.equal(map.heights[0][0], 0)
  assert.throws(() => host.heightmap({ radius: NaN }), /有限数字/)
})
test('fractional character sampling cannot address nonexistent array rows', () => {
  const chars = McBot.glyphMap([['stone'], ['stone'], ['stone']], 1.5)
  assert.equal(chars.split('\n').length, 3)
})
