import environmentUrl from '../assets/cd-studio-environment.bin.gzip?url'
import { createCdStudioTexture, decodeCdStudioEnvironment } from './cdStudioEnvironmentData.js'

let studioData
async function readStudioData() {
  const response = await fetch(environmentUrl)
  if (!response.ok) throw new Error(`CD studio environment unavailable (${response.status})`)
  if (typeof DecompressionStream === 'function') {
    return decodeCdStudioEnvironment(await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
  }
  const { gunzipSync } = await import('three/addons/libs/fflate.module.js')
  const decoded = gunzipSync(new Uint8Array(await response.arrayBuffer()))
  return decodeCdStudioEnvironment(decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.byteLength))
}

export async function loadCdStudioEnvironment(signal) {
  if (signal?.aborted) throw new DOMException('CD player loading was cancelled', 'AbortError')
  // Share the immutable CPU pixels, but give each renderer its own GPU texture.
  // Cancelling one screen must not abort another screen's asset request.
  studioData ||= readStudioData().catch(error => { studioData = null; throw error })
  const data = await new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort)
      reject(new DOMException('CD player loading was cancelled', 'AbortError'))
    }
    signal?.addEventListener('abort', abort, { once: true })
    studioData.then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort))
  })
  if (signal?.aborted) throw new DOMException('CD player loading was cancelled', 'AbortError')
  return createCdStudioTexture(data)
}
