import { buildCdGeometryBatch, cdGeometryBuffers, packCdGeometry } from './cdGeometryBatch.js'

self.onmessage = async ({ data: { id, parts } }) => {
  let geometry
  try {
    geometry = await buildCdGeometryBatch(parts)
    const result = packCdGeometry(geometry)
    self.postMessage({ id, result }, cdGeometryBuffers(result))
  } catch (error) {
    self.postMessage({ id, error: error.message })
  } finally { geometry?.dispose() }
}
