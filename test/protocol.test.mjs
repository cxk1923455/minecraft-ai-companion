import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { once } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McBot } from '../src/core.mjs'

const require = createRequire(import.meta.url)
const mfRequire = createRequire(require.resolve('mineflayer'))
const protocol = mfRequire('minecraft-protocol')
const mcData = mfRequire('minecraft-data')('1.16.5')

test('offline protocol connection loads skills on the original bot and disconnects cleanly', { timeout: 15000 }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'whale-protocol-test-'))
  const server = protocol.createServer({ host: '127.0.0.1', port: 0, version: '1.16.5', 'online-mode': false, keepAlive: false, hideErrors: true })
  server.on('error', () => {})
  server.on('playerJoin', client => {
    client.write('login', { ...mcData.loginPacket, entityId: client.id, isHardcore: false, gameMode: 0, previousGameMode: 1, worldName: 'minecraft:overworld', hashedSeed: [0, 0], maxPlayers: 10, viewDistance: 2, reducedDebugInfo: false, enableRespawnScreen: true, isDebug: false, isFlat: false })
    client.write('position', { x: 0, y: 64, z: 0, yaw: 0, pitch: 0, flags: 0, teleportId: 1 })
    client.write('update_health', { health: 20, food: 20, foodSaturation: 5 })
  })
  await once(server, 'listening')
  const host = new McBot({ logFile: join(scratch, 'mc.log'), lockDir: scratch, connectTimeoutMs: 5000 })
  try {
    const bot = await host.connect({ host: '127.0.0.1', port: server.socketServer.address().port, auth: { mode: 'offline', name: 'SkillTest' } })
    assert.equal(host.bot, bot)
    assert.equal(host.skills.raw, bot)
    assert.equal(host.online, true)
    assert.ok(bot.pathfinder)
    assert.ok(bot.tool)
    assert.ok(bot.collectBlock)
    assert.equal(bot.pathfinder.tickTimeout, 5)
    assert.equal(host.context({ survival: true }).skills.online, true)
    host.skills.halt()
    assert.equal(host.online, true)
    await host.disconnect('test done', { graceMs: 500 })
    assert.equal(host.online, false)
    assert.equal(host.skills.raw, null)
  } finally {
    if (host.bot) await host.disconnect('cleanup', { graceMs: 100 })
    const closed = once(server.socketServer, 'close')
    server.close()
    await closed
  }
})
