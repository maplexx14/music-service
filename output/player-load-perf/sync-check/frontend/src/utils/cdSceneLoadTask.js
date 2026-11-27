// Yield to browser tasks between construction stages, including in WebKit,
// where scheduler.yield is unavailable. Promise.resolve alone cannot paint.
export function createCdSceneLoadTask(signal, { budget = 8, now = () => performance.now(),
  requestFrame = callback => requestAnimationFrame(callback), cancelFrame = frame => cancelAnimationFrame(frame), yieldTask = () =>
  typeof globalThis.scheduler?.yield === 'function'
    ? globalThis.scheduler.yield()
    : new Promise(resolve => setTimeout(resolve, 0)) } = {}) {
  let startedAt = now()
  const cleanups = []
  const check = () => {
    if (signal?.aborted) throw new DOMException('CD player loading was cancelled', 'AbortError')
  }
  return {
    check,
    onCleanup(callback) { cleanups.push(callback) },
    async checkpoint(force = false) {
      check()
      if (force || now() - startedAt >= budget) {
        await yieldTask()
        check()
        startedAt = now()
      }
    },
    async waitForGpu(renderer) {
      check()
      const gl = renderer.getContext()
      const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
      if (!fence) return
      try {
        gl.flush()
        while (!gl.isContextLost()) {
          check()
          const status = gl.clientWaitSync(fence, 0, 0)
          if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) return
          if (status === gl.WAIT_FAILED) throw new Error('CD player GPU preparation failed')
          // A timer also gives Chromium's GPU process a chance to submit work;
          // scheduler.yield can keep this polling loop continuously runnable.
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        throw new Error('CD player WebGL context was lost during loading')
      } finally { gl.deleteSync(fence) }
    },
    complete() { check(); cleanups.length = 0 },
    async waitForPaint() {
      // Commit the prepared canvas before the pull tab accepts a gesture.
      // Abort also works while rAF is suspended in a hidden tab.
      for (let index = 0; index < 2; index++) {
        check()
        await new Promise((resolve, reject) => {
          let frame
          const abort = () => {
            cancelFrame(frame)
            signal.removeEventListener('abort', abort)
            reject(new DOMException('CD player loading was cancelled', 'AbortError'))
          }
          signal?.addEventListener('abort', abort, { once: true })
          frame = requestFrame(() => { signal?.removeEventListener('abort', abort); resolve() })
        })
      }
      check()
    },
    dispose() {
      for (const callback of cleanups.reverse()) {
        try { callback() } catch { /* Continue releasing the remaining resources. */ }
      }
      cleanups.length = 0
    },
  }
}
