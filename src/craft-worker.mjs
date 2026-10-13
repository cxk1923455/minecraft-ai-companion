import { parentPort } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { planCraft } from './hiyori-skills.mjs'
const require = createRequire(import.meta.url)
const mineflayerRequire = createRequire(require.resolve('mineflayer'))
const registries = new Map()
parentPort?.on('message', message => {
  try {
    let registry = registries.get(message.version)
    if (!registry) {
      registry = mineflayerRequire('prismarine-registry')(message.version)
      registries.set(message.version, registry)
      if (registries.size > 4) registries.delete(registries.keys().next().value)
    }
    const bot = { version: message.version, registry, inventory: { items: () => message.inventory } }
    parentPort.postMessage({ id: message.id, result: planCraft(bot, message.item, message.count, message.resourcePreferences) })
  } catch (error) { parentPort.postMessage({ id: message.id, error: error.message }) }
})
