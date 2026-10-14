/** Only completed assistant text, never reasoning, tool blocks, or interrupted streams. */
export function assistantSpeech(message) {
  if (message?.role !== 'assistant') return ''
  const blocks = message.content
  if (typeof blocks === 'string') return blocks
  if (!Array.isArray(blocks) || blocks.some(b => b.type === 'tool-call' || b.type === 'tool_call')) return ''
  return blocks.filter(b => b.type === 'text').map(b => b.text ?? '').join('\n')
}
export function plainSpeech(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*|__|`/g, '')
    .replace(/(?:^|\n)\s*(?:#{1,6}\s+|>\s*)/g, ' ')
    .replace(/[\u0000-\u001f\u007f§]/g, ' ')
    .replace(/\s+/g, ' ').trim()
}
export function speechChunks(text, max = 210, limit = 6) {
  let rest = plainSpeech(text)
  const chunks = []
  while (rest && chunks.length < limit) {
    let end = Math.min(max, rest.length)
    if (end < rest.length && /[\uD800-\uDBFF]/.test(rest[end - 1])) end--
    const part = rest.slice(0, end)
    if (end < rest.length) {
      const punctuation = Math.max(part.lastIndexOf('。'), part.lastIndexOf('！'), part.lastIndexOf('？'), part.lastIndexOf('；'), part.lastIndexOf(' '))
      if (punctuation > max / 2) end = punctuation + 1
    }
    let chunk = rest.slice(0, end).trim()
    if (chunk.startsWith('/')) chunk = `说明：${chunk}`
    chunks.push(chunk)
    rest = rest.slice(end).trim()
  }
  if (rest) chunks[chunks.length - 1] = `${chunks.at(-1).slice(0, max - 9)}…（详见对话）`
  return chunks
}

export class ChatBridge {
  constructor(host, { allowed = () => true, intervalMs = 800 } = {}) {
    this.host = host
    this.allowed = allowed
    this.intervalMs = intervalMs
    this.pending = new Map()
    this.seen = new Set()
    this.recent = []
    this.queue = []
    this.timer = null
    this.connection = null
    this.metrics = { synchronized: 0, deduplicated: 0, discarded: 0 }
    this.onSay = ({ text }) => { this.recent.push({ text: plainSpeech(text), at: Date.now() }); this.recent = this.recent.slice(-32) }
    this.onOffline = () => this.clear()
    host.on('chatSent', this.onSay)
    host.on('offline', this.onOffline)
  }
  observe(event) {
    if (!this.host.online || !this.allowed()) { this.clear(); return }
    const data = event?.data ?? {}, turn = data.turn
    if (event.type === 'assistant/message') {
      const speech = !data.interrupted && assistantSpeech(data.message)
      // Only the last message in a turn is its final answer.
      this.pending.set(turn, speech ? { text: speech, id: data.message.id ?? event.seq } : null)
      while (this.pending.size > 8) this.pending.delete(this.pending.keys().next().value)
    } else if (event.type === 'turn/end') {
      const message = this.pending.get(turn)
      this.pending.delete(turn)
      if (data.reason?.kind !== 'completed' || !message) return
      if (this.seen.has(message.id)) return
      this.seen.add(message.id)
      if (this.seen.size > 128) this.seen.delete(this.seen.values().next().value)
      const text = plainSpeech(message.text)
      const recent = this.recent.filter(x => Date.now() - x.at < 30000)
      if (recent.some(x => x.text === text) || recent.length && recent.map(x => x.text).join('') === text.replace(/\s+/g, '')) {
        this.metrics.deduplicated++; return
      }
      if (this.connection !== this.host.bot) this.clear()
      this.connection = this.host.bot
      const chunks = speechChunks(text).filter(c => !recent.some(x => x.text === plainSpeech(c)))
      if (this.queue.length + chunks.length > 24) { this.metrics.discarded += chunks.length; return }
      this.queue.push(...chunks)
      this.flush()
    }
  }
  flush() {
    if (this.timer || !this.queue.length) return
    if (!this.host.online || this.host.bot !== this.connection || !this.allowed()) { this.clear(); return }
    const text = this.queue.shift()
    try { this.host.chatSay(text); this.metrics.synchronized++ }
    catch (e) { this.host.log('游戏聊天同步失败：', e.message); this.clear(); return }
    this.timer = setTimeout(() => { this.timer = null; this.flush() }, this.intervalMs)
    this.timer.unref?.()
  }
  clear() {
    this.metrics.discarded += this.queue.length
    clearTimeout(this.timer); this.timer = null; this.queue = []; this.pending.clear(); this.connection = null
  }
  destroy() { this.clear(); this.host.off('chatSent', this.onSay); this.host.off('offline', this.onOffline) }
  status() { return { ...this.metrics, queued: this.queue.length, note: 'sent 表示已发往服务器；服务端屏蔽聊天时仍需人工检查' } }
}
