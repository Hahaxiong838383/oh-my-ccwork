function admissionError(message, code, statusCode) {
  return Object.assign(new Error(message), { code, statusCode })
}

export function createAdmissionController({ maxConcurrency = 4, maxQueue = 32, queueTimeoutMs = 10_000 } = {}) {
  const concurrency = Math.max(1, Number(maxConcurrency) || 4)
  const queueLimit = Math.max(0, Number(maxQueue) || 0)
  const timeoutMs = Math.max(10, Number(queueTimeoutMs) || 10_000)
  let active = 0
  const queue = []

  function release() {
    active = Math.max(0, active - 1)
    const next = queue.shift()
    if (!next) return
    clearTimeout(next.timer)
    active += 1
    next.resolve(release)
  }

  async function acquire() {
    if (active < concurrency) {
      active += 1
      return release
    }
    if (queue.length >= queueLimit) throw admissionError('H Engine admission queue is full', 'h_engine_overloaded', 429)
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null }
      entry.timer = setTimeout(() => {
        const index = queue.indexOf(entry)
        if (index >= 0) queue.splice(index, 1)
        reject(admissionError('H Engine admission queue timed out', 'h_engine_queue_timeout', 429))
      }, timeoutMs)
      queue.push(entry)
    })
  }

  function snapshot() {
    return { active, queued: queue.length, maxConcurrency: concurrency, maxQueue: queueLimit, queueTimeoutMs: timeoutMs }
  }

  return { acquire, snapshot }
}
