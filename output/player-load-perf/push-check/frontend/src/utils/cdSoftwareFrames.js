import { SRGBColorSpace, WebGLRenderTarget } from 'three'
import { cdMotionRegion } from './cdMotionRegion.js'
import { createCdFrameCadence } from './cdFrameCadence.js'
import { cdSoftwareFrameStore } from './cdSoftwareFrameStore.js'
import { cdQuadToQuadTransform } from './cdProjection.js'
import { CD_SKIP_MAX_ANGLE, CD_SKIP_PEAK_MS, createCdSoftwareSkip, sampleCdSoftwareSkip } from './cdSkipMotion.js'
export { createCdSoftwareSkip, sampleCdSoftwareSkip } from './cdSkipMotion.js'

export const CD_SOFTWARE_FRAME_COUNT = 41
export const CD_SOFTWARE_FRAME_BYTES = 24 * 1024 * 1024
const FRAME_FPS = 30

// More samples near rest keep the slow return smooth. Both directions share
// one cache, independent of the album artwork and the displayed time.
export const CD_SOFTWARE_ANGLES = Object.freeze(Array.from({ length: CD_SOFTWARE_FRAME_COUNT }, (_, i) => {
  const t = (i - (CD_SOFTWARE_FRAME_COUNT - 1) / 2) / ((CD_SOFTWARE_FRAME_COUNT - 1) / 2)
  return Math.sign(t) * t * t * CD_SKIP_MAX_ANGLE
}))

export function cdSoftwareFrameSize(width, height) {
  // Include the reusable readback/paint buffers in the resident pixel budget.
  const pixels = CD_SOFTWARE_FRAME_BYTES / (4 * (CD_SOFTWARE_FRAME_COUNT + 5))
  const ratio = Math.min(1, 512 / Math.max(width, height), Math.sqrt(pixels / (width * height)))
  return { width: Math.max(1, Math.floor(width * ratio)), height: Math.max(1, Math.floor(height * ratio)) }
}

export function nearestCdSoftwareFrame(angle) {
  let nearest = 0
  for (let i = 1; i < CD_SOFTWARE_ANGLES.length; i++) {
    if (Math.abs(CD_SOFTWARE_ANGLES[i] - angle) < Math.abs(CD_SOFTWARE_ANGLES[nearest] - angle)) nearest = i
  }
  return nearest
}

export function cdSoftwareFramePixels(pixels, destination, width, height) {
  const row = width * 4
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < row; x += 4) {
      const from = (height - 1 - y) * row + x, to = y * row + x
      const alpha = pixels[from + 3], factor = alpha ? 255 / alpha : 0
      for (let channel = 0; channel < 3; channel++) destination[to + channel] = pixels[from + channel] * factor
      destination[to + 3] = alpha
    }
  }
}

// Filter only the transparent silhouette, once during preparation. Work in
// premultiplied color so transparent black cannot leave a dark fringe.
export function cdSoftwareFrameEdges(pixels, width, height, centerWeight = 0.75) {
  const source = pixels.slice()
  const offsets = [-width * 4, width * 4, -4, 4]
  const neighborWeight = (1 - centerWeight) / 4
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const at = (y * width + x) * 4
    const alpha = source[at + 3]
    if (offsets.every(offset => source[at + offset + 3] === alpha)) continue
    const coverage = alpha * centerWeight + offsets.reduce((sum, offset) => sum + source[at + offset + 3] * neighborWeight, 0)
    for (let channel = 0; channel < 3; channel++) {
      const color = source[at + channel] * alpha * centerWeight
        + offsets.reduce((sum, offset) => sum + source[at + offset + channel] * source[at + offset + 3] * neighborWeight, 0)
      pixels[at + channel] = coverage ? color / coverage : 0
    }
    pixels[at + 3] = coverage
  }
}

export function cdSoftwareStoredRegion(region, width, height) {
  return { x: (region.x - width / 2) / height, y: (region.y - height / 2) / height, width: region.width / height, height: region.height / height }
}

export function cdSoftwareLayoutRegion(region, width, height) {
  return { x: width / 2 + region.x * height, y: height / 2 + region.y * height, width: region.width * height, height: region.height * height }
}

// Preparation is independent of input. Software-only callers can wait for
// the original pixels; live scenes can react immediately while they load.
export function createCdSoftwareFrames({ surface, renderer, scene, points, captureCamera, captureOverlays, captureFrameQuad, enabled, motionClock, frameRate = motionClock ? 0 : FRAME_FPS, onPose, onRest, onReady, beforeCapture, afterCapture, frameStore = cdSoftwareFrameStore }) {
  const output = document.createElement('canvas')
  output.className = 'cd-deck-software-frames'
  output.setAttribute('aria-hidden', 'true')
  Object.assign(output.style, { position: 'absolute', pointerEvents: 'none', zIndex: '1', display: 'none' })
  surface.after(output)
  const context = output.getContext('2d', { alpha: true })
  const cadence = createCdFrameCadence()
  let disposed = false, failedKey = null, failure = null, cache = null, key = null, generation = 0
  let timer = 0, idle = 0, frame = 0, preparing = false
  let motion = null, startedAt = 0, displayed = -1, activeCamera = null, capturing = null
  let firstStep = false, externalPose = false, externalStartAngle = null
  let externalAngle = 0
  let pendingAction = null
  let layout = ''

  function cancelPreparation() {
    clearTimeout(timer)
    if (idle) window.cancelIdleCallback?.(idle)
    timer = idle = 0
  }
  function cancelMotionFrame() {
    if (typeof frame === 'function') frame()
    else cancelAnimationFrame(frame)
    frame = 0
  }
  function stop() {
    cancelMotionFrame()
    const wasPlaying = Boolean(motion || externalPose)
    motion = null
    externalPose = false
    externalAngle = 0
    externalStartAngle = null
    pendingAction = null
    activeCamera = null
    output.style.display = 'none'
    surface.style.visibility = ''
    if (wasPlaying && !disposed) onRest()
  }
  function releaseBuffers(current) {
    current.target?.dispose()
    if (current.encoder) current.encoder.width = current.encoder.height = 0
    current.target = current.pixels = current.data = current.encoder = null
  }
  function releaseBitmap(bitmap) {
    if (typeof bitmap.close === 'function') bitmap.close()
    else bitmap.width = bitmap.height = 0
  }
  function releaseCache() {
    if (!cache) return
    const previous = cache
    cache = null
    for (const item of previous.frames) if (item) releaseBitmap(item.bitmap)
    previous.frames = []
    // Async readback still owns the target and pixel buffer. Retire them
    // after it finishes, including when appearance/size changes or we unmount.
    if (previous !== capturing) releaseBuffers(previous)
  }
  function prepare() {
    const width = surface.clientWidth, height = surface.clientHeight
    const corners = points()
    const cameras = CD_SOFTWARE_ANGLES.map(captureCamera)
    let left = width, bottom = height, right = 0, top = 0
    for (const camera of cameras) {
      const region = cdMotionRegion(corners, camera, width, height, 20)
      left = Math.min(left, region.x); bottom = Math.min(bottom, region.y)
      right = Math.max(right, region.x + region.width); top = Math.max(top, region.y + region.height)
    }
    const region = { x: left, y: height - top, width: right - left, height: top - bottom }
    const size = cdSoftwareFrameSize(region.width, region.height)
    // Rest is ready first; actions wait until both directions are complete.
    const order = Array.from({ length: cameras.length }, (_, i) => i).sort((a, b) => Math.abs(CD_SOFTWARE_ANGLES[a]) - Math.abs(CD_SOFTWARE_ANGLES[b]))
    cache = { region, size, cameras, order, frames: [], blobs: [], index: 0, width, height, ready: false, checkedStore: false }
  }
  function prepareBuffers(current) {
    // Loading stored poses never allocates a WebGL target or readback buffers.
    const { width, height } = current.size
    current.target = new WebGLRenderTarget(width, height, { samples: Math.min(2, renderer.capabilities.maxSamples), colorSpace: SRGBColorSpace, internalFormat: 'RGBA8' })
    current.target.isXRRenderTarget = true
    current.pixels = new Uint8Array(width * height * 4)
    current.data = new ImageData(width, height)
    current.encoder = document.createElement('canvas')
    current.encoder.width = width
    current.encoder.height = height
  }
  function capture(current, index, read) {
    const camera = current.cameras[index], cropped = camera.clone()
    const view = camera.view
    cropped.setViewOffset(view?.fullWidth ?? current.width, view?.fullHeight ?? current.height,
      (view?.offsetX ?? 0) + current.region.x,
      (view?.offsetY ?? 0) + current.region.y, current.region.width, current.region.height)
    const previousTarget = renderer.getRenderTarget()
    beforeCapture?.()
    try {
      renderer.setRenderTarget(current.target)
      renderer.render(scene, cropped)
      return read()
    } finally {
      renderer.setRenderTarget(previousTarget)
      afterCapture?.()
    }
  }
  function storeFrame(current, index, bitmap) {
    if (current.frames[index]) { releaseBitmap(bitmap); return }
    const camera = current.cameras[index]
    current.frames[index] = { bitmap, camera, overlays: captureOverlays(camera), quad: captureFrameQuad?.(camera) }
    current.index++
    if (current.index === current.order.length) {
      current.ready = true
      if (capturing !== current) releaseBuffers(current)
      onReady?.()
    }
  }
  async function restore(current, epoch) {
    current.checkedStore = true
    let record
    try { record = await frameStore.get(key) } catch { return false }
    if (!enabled()) { current.checkedStore = false; return false }
    if (disposed || generation !== epoch || record?.blobs?.length !== CD_SOFTWARE_FRAME_COUNT) return false
    const decoded = []
    let atlas
    try {
      // Decode a shipped atlas once. Decoding its compressed bytes separately
      // for every crop would repeat the same large CPU job forty-one times.
      if (record.rectangles) atlas = await createImageBitmap(record.blobs[0])
      // Decode sequentially so obsolete mounts can stop without allocating a
      // whole second set of pixels alongside the active scene.
      for (let index = 0; index < record.blobs.length; index++) {
        if (!enabled()) { current.checkedStore = false; decoded.forEach(releaseBitmap); return false }
        const blob = record.blobs[index], rect = record.rectangles?.[index]
        const bitmap = rect ? await createImageBitmap(atlas, rect.x, rect.y, rect.width, rect.height) : await createImageBitmap(blob)
        decoded.push(bitmap)
        const expected = record.size || current.size
        if (disposed || generation !== epoch || bitmap.width !== expected.width || bitmap.height !== expected.height) {
          decoded.forEach(releaseBitmap)
          return false
        }
      }
    } catch { decoded.forEach(releaseBitmap); return false }
    finally { atlas?.close() }
    if (record.region && record.size) {
      current.region = cdSoftwareLayoutRegion(record.region, current.width, current.height)
      current.size = record.size
    }
    decoded.forEach((bitmap, index) => storeFrame(current, index, bitmap))
    return true
  }
  async function bake() {
    if (disposed || !enabled() || motion || preparing || cache?.ready) return
    preparing = true
    const epoch = generation
    const began = performance.now()
    let bitmap
    try {
      if (!cache) prepare()
      const current = cache
      if (!current.checkedStore && await restore(current, epoch)) return
      if (disposed || generation !== epoch || !enabled()) return
      const index = current.order.find(index => !current.frames[index])
      if (!current.target) prepareBuffers(current)
      capturing = current
      const readback = capture(current, index, () => renderer.readRenderTargetPixelsAsync(current.target, 0, 0, current.size.width, current.size.height, current.pixels))
      await readback
      if (disposed || generation !== epoch || !enabled() || current.frames[index]) return
      // WebGL stores premultiplied colors with bottom-up rows. ImageData takes
      // straight alpha and top-down rows, including transparent disc apertures.
      cdSoftwareFramePixels(current.pixels, current.data.data, current.size.width, current.size.height)
      cdSoftwareFrameEdges(current.data.data, current.size.width, current.size.height)
      bitmap = await createImageBitmap(current.data)
      if (disposed || generation !== epoch || !enabled()) { bitmap.close(); return }
      // Compression is preparation work, never playback work. Storage is an
      // optional acceleration: denied/full storage must not break the player.
      try {
        current.encoder.getContext('2d').putImageData(current.data, 0, 0)
        current.blobs[index] = await new Promise(resolve => current.encoder.toBlob(resolve, 'image/png'))
      } catch { /* The decoded cache still works without persistent storage. */ }
      if (disposed || generation !== epoch || !enabled()) { bitmap.close(); return }
      storeFrame(current, index, bitmap)
      if (current.ready && current.blobs.filter(Boolean).length === CD_SOFTWARE_FRAME_COUNT) {
        frameStore.put(key, current.blobs, { size: current.size, region: cdSoftwareStoredRegion(current.region, current.width, current.height) }).catch(() => {})
        current.blobs = []
      }
    } catch (error) {
      bitmap?.close()
      if (generation === epoch) { failedKey = key; failure = error.message; releaseCache() }
    } finally {
      if (capturing && (capturing !== cache || capturing.ready)) releaseBuffers(capturing)
      capturing = null
      preparing = false
      if (cache?.ready && pendingAction && enabled()) play(pendingAction)
      // Keep preparation out of the active turn and leave idle time between
      // captures. Reopening an unchanged player decodes stored poses instead.
      if (!disposed && key !== failedKey && !cache?.ready) schedule(Math.max(50, performance.now() - began))
    }
  }
  function schedule(delay = 75) {
    if (disposed || !enabled() || timer || idle || preparing || cache?.ready || failedKey === key) return
    timer = window.setTimeout(() => {
      timer = 0
      if (!enabled() || motion) return
      if (typeof window.requestIdleCallback === 'function') {
        idle = window.requestIdleCallback(deadline => {
          idle = 0
          if (deadline.timeRemaining() >= 8) bake()
          else schedule(90)
        })
      } else bake()
    }, delay)
  }
  function draw(angle) {
    const index = nearestCdSoftwareFrame(angle)
    const changed = index !== displayed
    if (!captureFrameQuad && !changed) return
    const item = cache.frames[index]
    if (changed) {
      context.clearRect(0, 0, output.width, output.height)
      context.drawImage(item.bitmap, 0, 0)
    }
    displayed = index
    activeCamera = captureFrameQuad ? captureCamera(angle) : item.camera
    if (captureFrameQuad) {
      const { region } = cache
      const source = item.quad.map(point => ({ x: point.x - region.x, y: point.y - region.y }))
      const destination = captureFrameQuad(activeCamera).map(point => ({ x: point.x - region.x, y: point.y - region.y }))
      output.style.transformOrigin = '0 0'
      output.style.transform = cdQuadToQuadTransform(source, destination)
    }
    onPose(captureFrameQuad ? captureOverlays(activeCamera) : item.overlays)
  }
  function tick(at) {
    if (!motionClock) frame = 0
    if (!enabled()) { stop(); return }
    let elapsed = Math.max(0, at - startedAt)
    // A late first refresh must still show the turn, not just its tail.
    // Preparation never consumes the spring's visible duration.
    if (firstStep && elapsed > CD_SKIP_PEAK_MS) {
      elapsed = CD_SKIP_PEAK_MS
      startedAt = at - elapsed
    }
    if (elapsed >= motion.duration) { stop(); schedule(); return }
    if (!frameRate || cadence.shouldRender(at, frameRate)) {
      try { draw(sampleCdSoftwareSkip(motion, elapsed).angle); firstStep = false }
      catch (error) { failure = error.message; failedKey = key; stop(); return }
    }
    if (!motionClock) frame = requestAnimationFrame(tick)
  }
  function showOutput() {
    if (output.width !== cache.size.width || output.height !== cache.size.height) {
      output.width = cache.size.width; output.height = cache.size.height
    }
    Object.assign(output.style, { left: `${surface.offsetLeft + cache.region.x}px`, top: `${cache.region.y}px`, width: `${cache.region.width}px`, height: `${cache.region.height}px`, display: 'block' })
    surface.style.visibility = 'hidden'
  }
  function present(angle) {
    if (disposed || !context || !enabled() || !cache?.ready || !Number.isFinite(angle) || failedKey === key) return false
    const at = performance.now()
    const firstExternalFrame = !externalPose || externalStartAngle !== null
    // The initial pose can be placed between refreshes. Always draw the first
    // moving frame with the capsule before applying the software frame budget.
    if (frameRate && externalPose && !firstExternalFrame && !cadence.shouldRender(at, frameRate)) return true
    if (!externalPose || firstExternalFrame) cadence.shouldRender(at, frameRate || FRAME_FPS, true)
    cancelPreparation()
    cancelMotionFrame()
    pendingAction = null
    motion = null
    if (!externalPose) externalStartAngle = angle
    else if (angle !== externalStartAngle) externalStartAngle = null
    externalPose = true
    showOutput()
    try { externalAngle = Math.max(-CD_SKIP_MAX_ANGLE, Math.min(CD_SKIP_MAX_ANGLE, angle)); draw(externalAngle) }
    catch (error) { failure = error.message; failedKey = key; stop(); return false }
    return true
  }
  function play(action, { waitForReady = true } = {}) {
    if (disposed || !context || !enabled() || surface.clientWidth < 1 || surface.clientHeight < 1 || typeof createImageBitmap !== 'function' || failedKey !== null && failedKey === key) return false
    const now = performance.now()
    const previous = motion || (externalPose ? { angle: externalAngle, velocity: 0 } : null)
    const next = createCdSoftwareSkip(action, previous, motion ? now - startedAt : 0)
    if (!next) return false
    if (!cache?.ready) {
      pendingAction = waitForReady ? action : null
      // warm() already scheduled preparation. Do not render/allocate on input.
      return waitForReady
    }
    pendingAction = null
    cancelPreparation()
    cancelMotionFrame()
    motion = next
    externalPose = false
    firstStep = true
    startedAt = now
    cadence.shouldRender(now, frameRate || FRAME_FPS, true)
    displayed = -1
    showOutput()
    try { draw(next.angle) }
    catch (error) { failure = error.message; failedKey = key; stop(); return false }
    frame = motionClock ? motionClock.subscribe(tick) : requestAnimationFrame(tick)
    return true
  }
  return {
    warm(nextKey) {
      if (disposed || !context || surface.clientWidth < 1 || surface.clientHeight < 1 || typeof createImageBitmap !== 'function') return
      const nextLayout = `${surface.clientWidth}|${surface.clientHeight}`
      if (key !== nextKey || layout !== nextLayout) {
        generation++
        cancelPreparation()
        stop()
        releaseCache()
        key = nextKey
        layout = nextLayout
        failedKey = null
        failure = null
      }
      if (enabled()) schedule()
    },
    play,
    present,
    stop,
    suspend() { cancelPreparation(); stop() },
    get camera() { return activeCamera },
    status() { return { ready: Boolean(cache?.ready), prepared: cache?.index ?? 0, playing: Boolean(motion), pending: pendingAction, failure, bytes: cache ? cache.size.width * cache.size.height * 4 * (cache.ready ? CD_SOFTWARE_FRAME_COUNT : CD_SOFTWARE_FRAME_COUNT + 5) : 0 } },
    dispose() {
      disposed = true
      generation++
      cancelPreparation()
      stop()
      releaseCache()
      output.remove()
    },
  }
}
