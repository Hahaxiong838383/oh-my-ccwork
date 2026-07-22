/**
 * 有界并发 worker 池：替代全串行 queue，允许多会话并行跑 grok。
 * 排队任务可拿到 ahead 数用于微信「排队中」提示。
 */

export function createWorkerPool(size = 2) {
  const max = Math.max(1, Number(size) || 1)
  let active = 0
  /** @type {{ fn: (ahead: number) => Promise<any>, resolve: Function, reject: Function }[]} */
  const waiters = []

  function pump() {
    while (active < max && waiters.length > 0) {
      const job = waiters.shift()
      if (!job) break
      const ahead = active + waiters.length // 已在跑 + 仍在等（不含自己）
      active += 1
      Promise.resolve()
        .then(() => job.fn(ahead))
        .then(job.resolve, job.reject)
        .finally(() => {
          active = Math.max(0, active - 1)
          pump()
        })
    }
  }

  /**
   * @param {(ahead: number) => Promise<any>} taskFactory
   *   ahead = 进入执行瞬间，前面还有多少任务（活跃+排队，不含自己）
   */
  function run(taskFactory) {
    return new Promise((resolve, reject) => {
      waiters.push({ fn: taskFactory, resolve, reject })
      pump()
    })
  }

  function stats() {
    return {
      size: max,
      active,
      waiting: waiters.length,
      total: active + waiters.length,
    }
  }

  return { run, stats, size: max }
}
