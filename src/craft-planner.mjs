import { Worker } from 'node:worker_threads'
let worker
let sequence = 0
const pending = new Map()

export function planInWorker(payload) {
  if (!worker) {
    const current = new Worker(new URL('./craft-worker.mjs', import.meta.url), { execArgv: [] })
    worker = current
    current.on('message', response => {
      const request = pending.get(response.id)
      if (!request) return
      pending.delete(response.id); clearTimeout(request.timer)
      if (response.error) request.reject(new Error(response.error))
      else request.resolve(response.result)
      if (!pending.size) current.unref()
    })
    const fail = error => {
      if (worker !== current) return
      worker = null
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error) }
      pending.clear()
    }
    current.on('error', fail)
    current.on('exit', code => fail(new Error(`配方规划线程结束：${code}`)))
    current.unref()
  }
  const id = ++sequence
  const current = worker
  current.ref()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!pending.has(id)) return
      // A stalled planning worker must release all callers before it is restarted.
      const error = new Error('配方规划超时，请缩小目标或重新规划')
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error) }
      pending.clear(); worker = null
      void current.terminate()
    }, 8000)
    pending.set(id, { resolve, reject, timer })
    current.postMessage({ ...payload, id })
  })
}
