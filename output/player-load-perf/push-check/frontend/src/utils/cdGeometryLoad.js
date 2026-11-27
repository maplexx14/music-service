import { Matrix4 } from 'three'
import { buildCdGeometryBatch, cdGeometryBuffers, packCdGeometry, unpackCdGeometry } from './cdGeometryBatch.js'

export function createCdGeometryLoader(load, signal, {
  createWorker = () => new Worker(new URL('./cdGeometry.worker.js', import.meta.url), { type: 'module' }),
} = {}) {
  let worker, unavailable = false, sequence = 0, disposed = false
  const pending = new Map()
  const abortError = () => new DOMException('CD player loading was cancelled', 'AbortError')
  const stopWorker = error => {
    worker?.terminate()
    worker = null
    for (const task of pending.values()) task.reject(error)
    pending.clear()
  }
  const dispose = () => {
    if (disposed) return
    disposed = true
    signal?.removeEventListener('abort', dispose)
    stopWorker(abortError())
  }
  signal?.addEventListener('abort', dispose, { once: true })
  load.onCleanup(dispose)
  return {
    dispose,
    async batch(objects, inverse, sources, parameterized) {
      load.check()
      if (disposed) throw abortError()
      const packParts = async () => {
        const parts = []
        for (const object of objects) {
          await load.checkpoint()
          parts.push({ geometry: packCdGeometry(object.geometry),
            matrix: new Matrix4().multiplyMatrices(inverse, object.matrixWorld).toArray(),
            surfaceIndex: parameterized ? sources.indexOf(object.material) : null })
        }
        return parts
      }
      if (!unavailable && !worker) {
        try {
          worker = createWorker()
          worker.onmessage = ({ data }) => {
            const task = pending.get(data.id)
            if (!task) return
            pending.delete(data.id)
            if (data.error) task.reject(new Error(data.error))
            else task.resolve(data.result)
          }
          worker.onerror = event => {
            event.preventDefault?.()
            unavailable = true
            stopWorker(new Error('CD geometry worker could not start'))
          }
          worker.onmessageerror = () => { unavailable = true; stopWorker(new Error('Invalid CD geometry worker response')) }
        } catch { unavailable = true; stopWorker(new Error('CD geometry worker unavailable')) }
      }
      if (worker) {
        try {
          const parts = await packParts()
          load.check()
          const result = await new Promise((resolve, reject) => {
            const id = ++sequence
            pending.set(id, { resolve, reject })
            try { worker.postMessage({ id, parts }, parts.flatMap(part => cdGeometryBuffers(part.geometry))) }
            catch (error) { pending.delete(id); unavailable = true; stopWorker(error); reject(error) }
          })
          load.check()
          return unpackCdGeometry(result)
        } catch (error) {
          load.check()
          if (disposed) throw abortError()
          if (!unavailable) throw error
          // The original hit-test meshes retain their buffers, so a worker
          // startup failure can retry with cooperative construction.
        }
      }
      return buildCdGeometryBatch(await packParts(), load)
    },
  }
}
