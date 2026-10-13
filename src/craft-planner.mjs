import { Worker } from 'node:worker_threads'
let worker
let sequence = 0
const pending = new Map()

export function planInWorker(payload, { signal } = {}) {
  if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('配方规划已取消'))
  if (pending.size >= 32) return Promise.reject(new Error('配方规划队列已满，请等待当前请求结束'))
  if (!worker) {
    const current = new Worker(new URL('./craft-worker.mjs', import.meta.url), { execArgv: [] })
    worker = current
    current.on('message', response => {
      const request = pending.get(response.id)
      if (!request) return
      pending.delete(response.id); request.cleanup()
      if (response.error) request.reject(new Error(response.error))
      else request.resolve(response.result)
      if (!pending.size) current.unref()
    })
    const fail = error => {
      if (worker !== current) return
      worker = null
      for (const request of pending.values()) { request.cleanup(); request.reject(error) }
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
    const abort = () => {
      if (!pending.delete(id)) return
      cleanup()
      reject(signal.reason instanceof Error ? signal.reason : new Error('配方规划已取消'))
      if (!pending.size && worker === current) { worker = null; void current.terminate().catch(() => {}) }
    }
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
    const timer = setTimeout(() => {
      if (!pending.has(id)) return
      // A stalled planning worker must release all callers before it is restarted.
      const error = new Error('配方规划超时，请缩小目标或重新规划')
      for (const request of pending.values()) { request.cleanup(); request.reject(error) }
      pending.clear(); worker = null
      void current.terminate().catch(() => {})
    }, 8000)
    pending.set(id, { resolve, reject, cleanup })
    signal?.addEventListener('abort', abort, { once: true })
    try { current.postMessage({ ...payload, id }) } catch (error) {
      pending.delete(id); cleanup(); reject(error)
      if (!pending.size) current.unref()
    }
    if (signal?.aborted) abort()
  })
}
