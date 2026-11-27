import {
  ACESFilmicToneMapping, AlwaysStencilFunc, BoxGeometry, CanvasTexture, Color,
  CylinderGeometry, DepthStencilFormat, DepthTexture, DirectionalLight, DoubleSide, EqualStencilFunc, ExtrudeGeometry, FramebufferTexture, Group, HalfFloatType,
  HemisphereLight, InstancedBufferAttribute, InstancedMesh, KeepStencilOp, LatheGeometry, Matrix4, Mesh, MeshBasicMaterial, MeshDepthMaterial, MeshPhysicalMaterial,
  Object3D, Path, PCFShadowMap, PerspectiveCamera, Plane,
  PlaneGeometry, Raycaster, RepeatWrapping, ReplaceStencilOp, RingGeometry,
  Scene, ShaderChunk, ShaderMaterial, Shape, SRGBColorSpace, UnsignedInt248Type, Vector2, Vector3, Vector4, WebGLRenderer, WebGLRenderTarget,
} from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { createCdGeometryLoader } from './cdGeometryLoad.js'
import { applyCdDrawingBufferSize, cdCanvasSize } from './cdCanvasSize.js'
import { loadCdStudioEnvironment } from './cdStudioEnvironment.js'
import { createDiscSpin, SOFTWARE_DISC_FPS } from './discSpin.js'
import { createCdFrameCadence } from './cdFrameCadence.js'
import { cdAnimationClock } from './cdAnimationClock.js'
import { trackCarouselMotion } from './trackCarouselMotion.js'
import { createCdSoftwareFrames } from './cdSoftwareFrames.js'
import { createCdPlaybackMotion, cdPlaybackMotionKeyframes } from './cdPlaybackMotion.js'
import { CD_SKIP_MAX_ANGLE } from './cdSkipMotion.js'
import { createCdGpuVolume } from './cdGpuVolume.js'
import { cdPlaybackVolumeFaces, cdCssCameraMatrix, cdCssCameraDelta, cdCssPlaneMatrix, cdCssMatrixTransform, cdRayFromCssVolume, createCdPlaybackVolume } from './cdPlaybackVolume.js'
import { freezeCdSceneTransforms } from './cdSceneTransforms.js'
import { canBatchCdSurface, createCdSurfaceBatch, updateCdSurfaceBatch } from './cdSurfaceBatch.js'
import { centerCdCamera, cdMotionRegion, growCdMotionRegion } from './cdMotionRegion.js'
import { squareToQuadTransform, cdQuadToQuadTransform } from './cdProjection.js'
import { DEFAULT_CD_APPEARANCE, normalizeCdAppearance } from './cdPlayerAppearance.js'
import { paintCdDiscPrint } from './cdDiscArtwork.js'
import { createCdSceneLoadTask } from './cdSceneLoadTask.js'
import logoHeart from '../assets/loader-heart.webp'
import boltWordmark from '../assets/bolt-wordmark.webp'

const TAU = Math.PI * 2
const DISC_RADIUS = 2.1
const DISC_ARTWORK_RADIUS = 2.065
const DISC_HUB_RADIUS = 0.27
const DISC_CENTER_Z = -0.245
const TRAY_RADIUS = 2.225
const INITIAL_VIEW = { theta: Math.PI / 18, phi: Math.PI / 2 }
const FRONTAL_VIEW = { theta: 0, phi: Math.PI / 2 }
const DECK_STANDING_Y = 2.73
// The orthographic chassis captures flatten visible details onto this plane.
// Live patches and their cutouts must share it to avoid parallax cracks.
const PLAYBACK_SURFACE_Z = 0.81
const PLAYBACK_FPS = 60
const DISC_PLAYBACK_LAYER = 1
const GLASS_CACHE_LAYER = 2
const MOTION_RENDER_SCALE = 0.85
const MAX_ARTWORK_SIZE = 1024
const SOFTWARE_PLAYBACK_FPS = 4
const SOFTWARE_INTERACTION_FPS = 12
// Software mode no longer redraws the rotating deck continuously, so the
// saved frame budget can go into a sharper static image instead.
const LID_CLOSED_ANGLE = 0
const LID_DURATION_MS = 420
const VIEW_SPRING_OMEGA = TAU / 0.4
const REACTION_SPRING_OMEGA = 14
const BODY_REACTIONS = {
  next: { theta: 0.28, roll: -0.065, zoom: 0 },
  previous: { theta: -0.28, roll: 0.065, zoom: 0 },
  shuffle: { theta: -0.18, roll: 0.12, zoom: 0.04 },
  repeat: { theta: 0.18, roll: -0.12, zoom: 0.04 },
  volume: { roll: 0.06, zoom: 0.035 },
  seek: { theta: -0.12, phi: -0.06, zoom: 0.035 },
}
const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

function roundedOutline(width, height, radius) {
  const shape = new Shape()
  const x = -width / 2
  const y = -height / 2
  shape.moveTo(x + radius, y)
  shape.lineTo(x + width - radius, y)
  shape.quadraticCurveTo(x + width, y, x + width, y + radius)
  shape.lineTo(x + width, y + height - radius)
  shape.quadraticCurveTo(x + width, y + height, x + width - radius, y + height)
  shape.lineTo(x + radius, y + height)
  shape.quadraticCurveTo(x, y + height, x, y + height - radius)
  shape.lineTo(x, y + radius)
  shape.quadraticCurveTo(x, y, x + radius, y)
  return shape
}

function makeCanvas(width, height, paint) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  paint?.(canvas.getContext('2d'), width, height)
  return canvas
}

// Microsurface variation belongs to the material, so highlights follow the
// camera and lights rather than a painted gradient on the face of the object.
function brushedSurface() {
  return makeCanvas(512, 256, (ctx, width, height) => {
    const pixels = ctx.createImageData(width, height)
    let seed = 9273
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed / 4294967296
    }
    for (let y = 0; y < height; y++) {
      const grain = random() * 12
      for (let x = 0; x < width; x++) {
        const at = (y * width + x) * 4
        const value = 170 + grain * 1.5 + random() * 4
        pixels.data[at] = pixels.data[at + 1] = pixels.data[at + 2] = value
        pixels.data[at + 3] = 255
      }
    }
    ctx.putImageData(pixels, 0, 0)
  })
}

function discSurface() {
  return makeCanvas(512, 512, (ctx) => {
    ctx.fillStyle = '#bdbdbd'
    ctx.fillRect(0, 0, 512, 512)
    for (let radius = 28; radius < 257; radius += 0.8) {
      ctx.beginPath()
      ctx.arc(256, 256, radius, 0, TAU)
      ctx.strokeStyle = radius % 3 < 1 ? '#c1c1c1' : '#bababa'
      ctx.lineWidth = 0.3
      ctx.stroke()
    }
  })
}

function paintIcon(ctx, kind, size, color = '#ffffff') {
  ctx.strokeStyle = color
  ctx.fillStyle = color
  ctx.lineWidth = size * 0.065
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  const line = (points) => {
    ctx.beginPath()
    points.forEach(([x, y], index) => index ? ctx.lineTo(x * size, y * size) : ctx.moveTo(x * size, y * size))
    ctx.stroke()
  }
  if (kind === 'play') {
    ctx.beginPath()
    ctx.moveTo(size * 0.38, size * 0.27)
    ctx.lineTo(size * 0.73, size * 0.5)
    ctx.lineTo(size * 0.38, size * 0.73)
    ctx.closePath()
    ctx.fill()
  } else if (kind === 'pause') {
    ctx.fillRect(size * 0.32, size * 0.28, size * 0.12, size * 0.44)
    ctx.fillRect(size * 0.56, size * 0.28, size * 0.12, size * 0.44)
  } else if (kind === 'previous' || kind === 'next') {
    ctx.save()
    if (kind === 'previous') { ctx.translate(size, 0); ctx.scale(-1, 1) }
    ctx.beginPath()
    ctx.moveTo(size * 0.28, size * 0.28)
    ctx.lineTo(size * 0.6, size * 0.5)
    ctx.lineTo(size * 0.28, size * 0.72)
    ctx.closePath()
    ctx.fill()
    ctx.fillRect(size * 0.66, size * 0.28, size * 0.065, size * 0.44)
    ctx.restore()
  } else if (kind === 'shuffle') {
    line([[0.23, 0.3], [0.35, 0.3], [0.65, 0.7], [0.79, 0.7]])
    line([[0.23, 0.7], [0.35, 0.7], [0.65, 0.3], [0.79, 0.3]])
    line([[0.68, 0.2], [0.79, 0.3], [0.68, 0.4]])
    line([[0.68, 0.6], [0.79, 0.7], [0.68, 0.8]])
  } else if (kind === 'repeat') {
    line([[0.25, 0.45], [0.25, 0.29], [0.73, 0.29], [0.81, 0.38]])
    line([[0.7, 0.2], [0.81, 0.38], [0.65, 0.4]])
    line([[0.75, 0.55], [0.75, 0.71], [0.27, 0.71], [0.19, 0.62]])
    line([[0.3, 0.8], [0.19, 0.62], [0.35, 0.6]])
  }
}

export async function createCdDeckScene(canvas, options = {}) {
  const load = createCdSceneLoadTask(options.signal)
  try {
    const api = await buildCdDeckScene(canvas, options, load)
    load.complete()
    return api
  } catch (error) {
    load.dispose()
    throw error
  }
}

async function buildCdDeckScene(canvas, { onError, softwareRendering = false, onDiscOverlayChange, onFramingChange, onAction, onDiscChange, playbackElement, mapPointer, presentation = 'default', appearance = DEFAULT_CD_APPEARANCE, signal } = {}, load) {
  let initializing = true
  let disposed = false
  const canvasStyle = canvas.style.cssText
  load.onCleanup(() => { disposed = true; canvas.style.cssText = canvasStyle })
  await load.checkpoint(true)
  const cachedRendering = presentation !== 'setup' || softwareRendering
  const stageElement = playbackElement?.parentElement || canvas.parentElement
  const mobile = presentation === 'mobile'
  const constrainedDevice = (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 4
  const measureCanvas = (powerSave = false) => cdCanvasSize({ stageWidth: stageElement.clientWidth,
    height: stageElement.clientHeight, mobile, cachedRendering, powerSave, constrainedDevice,
    devicePixelRatio: window.devicePixelRatio || 1 })
  const initialSize = measureCanvas()
  // Allocate the final drawing buffer before creating a context or submitting
  // any GPU work. Later layout setup reuses this allocation.
  if (initialSize) { canvas.width = initialSize.pixelWidth; canvas.height = initialSize.pixelHeight }
  // Firefox resolves an antialiased canvas on every presentation, even when
  // only the disc changes. Keep MSAA in the render target instead.
  const renderer = new WebGLRenderer({ canvas, alpha: true, antialias: cachedRendering, stencil: false, preserveDrawingBuffer: false, powerPreference: 'low-power' })
  load.onCleanup(() => { renderer.dispose(); renderer.forceContextLoss() })
  applyCdDrawingBufferSize(renderer, initialSize)
  renderer.setClearColor(0x000000, 0)
  renderer.outputColorSpace = SRGBColorSpace
  renderer.toneMapping = ACESFilmicToneMapping
  renderer.toneMappingExposure = 0.95
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = PCFShadowMap
  renderer.shadowMap.autoUpdate = false
  renderer.shadowMap.needsUpdate = true

  const resources = new Set()
  load.onCleanup(() => resources.forEach(resource => resource.dispose()))
  const own = (resource) => { resources.add(resource); return resource }
  await load.checkpoint()
  let staticFrame = null
  let playbackFrame = null
  let motionFrame = null
  let softwareFrames = null
  let playbackMotion = null
  let playbackVolume = null
  let gpuVolume = null
  let projectionElement = playbackElement
  let gpuProjectionNode = null
  load.onCleanup(() => {
    softwareFrames?.dispose()
    playbackMotion?.dispose()
    playbackVolume?.dispose()
    gpuVolume?.dispose()
    gpuProjectionNode?.remove()
    playbackElement?.classList.remove('has-crop', 'has-volume', 'is-live-disc')
  })
  let gpuDiscTransform
  let gpuEnvelopeKey = '', gpuEnvelope
  // Use the bounded multisampled presenter on desktop Chromium too. Separate
  // CSS 3D walls can expose unsmoothed seams at grazing angles.
  if (cachedRendering && !softwareRendering && presentation !== 'setup') {
    gpuProjectionNode = document.createElement('span')
    gpuProjectionNode.className = 'cd-deck-gpu-projection'
    canvas.parentElement.append(gpuProjectionNode)
    try {
      gpuVolume = createCdGpuVolume({ parent: canvas.parentElement, motionElement: gpuProjectionNode, frameRate: PLAYBACK_FPS, pixelRatioCap: presentation === 'mobile' ? 2 : 1.5,
        getDiscTransform: () => gpuDiscTransform,
        getMotionTransform: () => playbackMotion?.transform(),
        getMotionEnvelope: () => {
          const lens = parseFloat(playbackElement.style.getPropertyValue('--cd-camera-lens')) || 1100
          const key = [lens, frameWidth, frameHeight, camera.fov, ...camera.position.toArray(), staticCanvas.offsetLeft].join(':')
          if (gpuEnvelopeKey !== key) {
            gpuEnvelopeKey = key
            const skips = [-CD_SKIP_MAX_ANGLE, 0, CD_SKIP_MAX_ANGLE].map(angle => new DOMMatrix(volumeSkipTransform(angle)))
            gpuEnvelope = cdPlaybackMotionKeyframes(lens).flatMap(({ transform }) => skips.map(skip => new DOMMatrix(transform).multiply(skip)))
          }
          return gpuEnvelope
        },
        onFailure: () => {
          projectionElement = playbackElement
          playbackMotion?.setElement(playbackElement)
          gpuProjectionNode?.remove(); gpuProjectionNode = null
          gpuVolume?.dispose(); gpuVolume = null
        },
        onDiscProjection: quad => {
          const projection = squareToQuadTransform(quad, 512)
          const touchTarget = canvas.parentElement.querySelector('.cd-mobile-disc-control')
          if (touchTarget) touchTarget.style.transform = projection
          const control = canvas.parentElement.querySelector('.cd-deck-playback')
          if (!control) return
          const center = new DOMMatrix(projection).transformPoint({ x: 256, y: 256 })
          control.style.setProperty('--cd-playback-x', `${center.x / center.w}px`)
          control.style.setProperty('--cd-playback-y', `${center.y / center.w}px`)
          control.style.setProperty('--cd-playback-z', '2px')
          control.style.setProperty('--cd-disc-projection', projection)
        },
      })
    } catch { gpuVolume = null }
    if (gpuVolume) projectionElement = gpuProjectionNode
    else { gpuProjectionNode.remove(); gpuProjectionNode = null }
  }
  let volumeCaptureVersion = 0
  let appearanceKey = ''
  let motionRegion = null
  let motionPixels = null
  let frameWidth = 0
  let frameHeight = 0
  let framePixelWidth = 0
  let framePixelHeight = 0
  let discCutout = false
  let liveFramePresented = false
  let restingPose = null
  let restingLightingReady = false
  let restingGlassReady = false
  let shadowVersion = 0
  const staticCanvas = document.createElement('canvas')
  load.onCleanup(() => staticCanvas.remove())
  const staticContext = staticCanvas?.getContext('2d', { alpha: true })
  if (staticCanvas) {
    staticCanvas.className = 'cd-deck-canvas cd-deck-frame is-ready'
    staticCanvas.setAttribute('aria-hidden', 'true')
    Object.assign(staticCanvas.style, { position: 'absolute', left: '0', top: '0', pointerEvents: 'none' })
    canvas.before(staticCanvas)
    canvas.style.position = 'absolute'
  }
  const presentationScene = new Scene()
  const presentationCamera = new PerspectiveCamera()
  const presentationMaterial = cachedRendering ? null : own(new ShaderMaterial({
    uniforms: { frameMap: { value: null }, frameRegion: { value: new Vector4() }, frameSize: { value: new Vector2() }, smoothMotion: { value: false } },
    vertexShader: 'varying vec2 frameUv; void main() { frameUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `uniform sampler2D frameMap;
      uniform vec4 frameRegion;
      uniform vec2 frameSize;
      uniform bool smoothMotion;
      varying vec2 frameUv;
      float edgeLuma(vec4 color) {
        return max(dot(color.rgb, vec3(0.299, 0.587, 0.114)), color.a * 0.25);
      }
      vec4 antialiasFrame(vec2 uv) {
        vec2 pixel = 1.0 / frameSize;
        vec4 center = texture2D(frameMap, uv);
        float nw = edgeLuma(texture2D(frameMap, uv + vec2(-1.0, -1.0) * pixel));
        float ne = edgeLuma(texture2D(frameMap, uv + vec2(1.0, -1.0) * pixel));
        float sw = edgeLuma(texture2D(frameMap, uv + vec2(-1.0, 1.0) * pixel));
        float se = edgeLuma(texture2D(frameMap, uv + vec2(1.0, 1.0) * pixel));
        float m = edgeLuma(center);
        float low = min(m, min(min(nw, ne), min(sw, se)));
        float high = max(m, max(max(nw, ne), max(sw, se)));
        if (high - low < max(0.0312, high * 0.125)) return center;
        vec2 direction = vec2(-((nw + ne) - (sw + se)), (nw + sw) - (ne + se));
        float reduce = max((nw + ne + sw + se) * 0.03125, 0.0078125);
        direction = clamp(direction / (min(abs(direction.x), abs(direction.y)) + reduce), -8.0, 8.0) * pixel;
        vec4 a = 0.5 * (texture2D(frameMap, uv - direction / 6.0) + texture2D(frameMap, uv + direction / 6.0));
        vec4 b = a * 0.5 + 0.25 * (texture2D(frameMap, uv - direction * 0.5) + texture2D(frameMap, uv + direction * 0.5));
        float lumaB = edgeLuma(b);
        return lumaB < low || lumaB > high ? a : b;
      }
      void main() {
        vec2 uv = (frameRegion.xy + frameUv * frameRegion.zw) / frameSize;
        gl_FragColor = smoothMotion ? antialiasFrame(uv) : texture2D(frameMap, uv);
      }`,
    depthTest: false, depthWrite: false, toneMapped: false,
  }))
  if (presentationMaterial) {
    const quad = new Mesh(own(new PlaneGeometry(2, 2)), presentationMaterial)
    quad.frustumCulled = false
    presentationScene.add(quad)
  }
  function resizeFrameCache() {
    if (cachedRendering) return
    const width = framePixelWidth
    const height = framePixelHeight
    if (playbackFrame?.width === width && playbackFrame?.height === height) return
    restingPose = null
    motionRegion = null
    for (const target of [playbackFrame, staticFrame, motionFrame]) {
      if (target) { resources.delete(target); target.dispose() }
    }
    const depth = new DepthTexture(width, height, UnsignedInt248Type)
    depth.format = DepthStencilFormat
    const options = { depthTexture: depth, stencilBuffer: true, colorSpace: SRGBColorSpace, internalFormat: 'RGBA8' }
    staticFrame = own(new WebGLRenderTarget(width, height, { ...options, samples: Math.min(4, renderer.capabilities.maxSamples) }))
    playbackFrame = own(new WebGLRenderTarget(width, height, options))
    // Moving frames retain the full 3D geometry and lighting. Smooth their
    // edges during presentation, avoiding an MSAA resolve on every refresh.
    // The resting cache remains at full resolution and four samples.
    motionFrame = own(new WebGLRenderTarget(Math.ceil(Math.min(width, height * 1.1) * MOTION_RENDER_SCALE), Math.ceil(height * MOTION_RENDER_SCALE), {
      colorSpace: SRGBColorSpace, internalFormat: 'RGBA8',
    }))
    // These caches contain final display colors, including tone mapping and
    // glass blending. Three uses its display-target flag to preserve that path.
    staticFrame.isXRRenderTarget = playbackFrame.isXRRenderTarget = true
    motionFrame.isXRRenderTarget = true
    renderer.initRenderTarget(staticFrame)
    renderer.initRenderTarget(playbackFrame)
    renderer.initRenderTarget(motionFrame)
    presentationMaterial.uniforms.frameMap.value = playbackFrame.texture
    presentationMaterial.uniforms.frameSize.value.set(width, height)
  }
  function presentRegion(x, y, width, height, source = { x, y, width, height }) {
    const ratio = renderer.getPixelRatio()
    // Keep one backing store across playback and skips. Reallocating the
    // canvas at both ends of each turn stalls the CPU and GPU processes.
    // Scissor the draw and clip its DOM surface to the same physical pixels.
    renderer.setRenderTarget(null)
    renderer.setViewport(x / ratio, y / ratio, (width + 0.0001) / ratio, (height + 0.0001) / ratio)
    renderer.setScissor(x / ratio, y / ratio, (width + 0.0001) / ratio, (height + 0.0001) / ratio)
    renderer.setScissorTest(true)
    presentationMaterial.uniforms.frameRegion.value.set(source.x, source.y, source.width, source.height)
    renderer.render(presentationScene, presentationCamera)
    renderer.setScissorTest(false)
  }
  function pixelRegion(region) {
    const ratio = renderer.getPixelRatio()
    return {
      x: Math.round(region.x * ratio), y: Math.round(region.y * ratio),
      width: Math.round(region.width * ratio), height: Math.round(region.height * ratio),
    }
  }
  function copyStaticFrame(region = { x: 0, y: 0, width: framePixelWidth, height: framePixelHeight }) {
    // A fullscreen draw copies GPU colors without copyTextureToTexture's five
    // synchronous getParameter calls. Shared depth/stencil stays untouched.
    const ratio = renderer.getPixelRatio()
    presentationMaterial.uniforms.smoothMotion.value = false
    presentationMaterial.uniforms.frameMap.value = staticFrame.texture
    presentationMaterial.uniforms.frameRegion.value.set(region.x, region.y, region.width, region.height)
    presentationMaterial.uniforms.frameSize.value.set(framePixelWidth, framePixelHeight)
    renderer.setRenderTarget(playbackFrame)
    renderer.setViewport(region.x / ratio, region.y / ratio, region.width / ratio, region.height / ratio)
    renderer.setScissor(region.x / ratio, region.y / ratio, region.width / ratio, region.height / ratio)
    renderer.setScissorTest(true)
    renderer.autoClear = false
    try { renderer.render(presentationScene, presentationCamera) }
    finally {
      renderer.autoClear = true
      renderer.setScissorTest(false)
      renderer.setViewport(0, 0, framePixelWidth / ratio, framePixelHeight / ratio)
    }
  }
  function presentFrame(fullFrame, discChanged, moving) {
    if (fullFrame && moving) {
      // Keep moving 3D frames on the GPU. Reading the full canvas back into
      // the static bitmap every frame stalls the renderer and compositor.
      presentationMaterial.uniforms.smoothMotion.value = true
      presentationMaterial.uniforms.frameMap.value = motionFrame.texture
      presentationMaterial.uniforms.frameSize.value.set(motionFrame.width, motionFrame.height)
      presentRegion(motionRegion.x, motionRegion.y, motionRegion.width, motionRegion.height, motionPixels)
      staticCanvas.style.visibility = 'hidden'
      Object.assign(canvas.style, {
        left: '0', top: '0', width: `${frameWidth}px`, height: `${frameHeight}px`, display: 'block',
        clipPath: clipFrameRegion(motionRegion),
      })
      liveFramePresented = true
      return
    }
    presentationMaterial.uniforms.smoothMotion.value = false
    presentationMaterial.uniforms.frameMap.value = playbackFrame.texture
    presentationMaterial.uniforms.frameSize.value.set(framePixelWidth, framePixelHeight)
    motionRegion = null
    staticCanvas.style.visibility = ''
    liveFramePresented = false
    if (fullFrame) {
      presentRegion(0, 0, framePixelWidth, framePixelHeight)
      staticContext.clearRect(0, 0, framePixelWidth, framePixelHeight)
      staticContext.drawImage(canvas, 0, 0)
      discCutout = false
      canvas.style.display = 'none'
      return
    }
    if (!discChanged && !discCutout) return
    const region = pixelRegion(discScissor)
    const top = framePixelHeight - region.y - region.height
    presentRegion(region.x, region.y, region.width, region.height)
    if (!discCutout) {
      // Remove the underlying pixels once so transparent edges and shadows
      // are composited once, including when the player is turned sideways.
      // Keep a small overlap under the tile. Separate canvas layers filter
      // their edges independently, which otherwise leaves a dark hairline.
      const inset = 2
      staticContext.clearRect(region.x + inset, top + inset, Math.max(0, region.width - inset * 2), Math.max(0, region.height - inset * 2))
      discCutout = true
    }
    Object.assign(canvas.style, {
      left: '0', top: '0', width: `${frameWidth}px`, height: `${frameHeight}px`,
      clipPath: clipFrameRegion(region),
      display: 'block',
    })
  }
  function clipFrameRegion(region) {
    return `inset(${(framePixelHeight - region.y - region.height) / framePixelHeight * 100}% ${(framePixelWidth - region.x - region.width) / framePixelWidth * 100}% ${region.y / framePixelHeight * 100}% ${region.x / framePixelWidth * 100}%)`
  }
  const texture = (source, color = false) => {
    const map = own(new CanvasTexture(source))
    if (color) map.colorSpace = SRGBColorSpace
    map.anisotropy = cachedRendering ? 1 : Math.min(4, renderer.capabilities.getMaxAnisotropy())
    return map
  }
  const scene = new Scene()
  await load.checkpoint()
  const serviceStyles = getComputedStyle(canvas)
  let accent = serviceStyles.getPropertyValue('--brand-accent').trim() || '#C4B0F0'
  const activeAccent = serviceStyles.getPropertyValue('--brand-accent-hover').trim() || '#D6C6F5'
  const camera = new PerspectiveCamera(34, 1, 0.1, 60)
  const motionCamera = camera.clone()
  const framingCamera = mobile ? camera.clone() : null
  const framingPose = { theta: 0, phi: 0, roll: 0, zoom: 0, lift: 0 }
  const target = new Vector3(0, DECK_STANDING_Y, 0)
  const playbackView = cachedRendering || presentation === 'setup' ? FRONTAL_VIEW : INITIAL_VIEW
  const initialView = { ...playbackView }
  let initialPlayback = false
  const view = { ...initialView }
  const deck = new Group()
  scene.add(deck)

  // This is the exact half-float output of the original four-panel studio.
  // Loading it avoids rendering and filtering the studio during player startup.
  scene.environment = own(await loadCdStudioEnvironment(signal))
  scene.environmentIntensity = 1
  await load.checkpoint()

  scene.add(new HemisphereLight('#f1f3f5', '#24262a', 0.6))
  // Softer key and rim: the metal highlights were hot spots, not sheen.
  const key = new DirectionalLight('#fffaf2', 1.35)
  key.position.set(-4, 7, 6.5)
  key.target.position.copy(target)
  key.castShadow = true
  key.shadow.mapSize.set(512, 512)
  Object.assign(key.shadow.camera, { left: -4.5, right: 4.5, top: 4.5, bottom: -4.5, near: 0.5, far: 18 })
  key.shadow.normalBias = 0.018
  key.shadow.bias = -0.0003
  key.shadow.radius = 4
  scene.add(key, key.target)
  const fill = new DirectionalLight('#e9eef5', 0.6)
  fill.position.set(4, 3.5, 5)
  fill.target.position.copy(target)
  scene.add(fill, fill.target)
  const rim = new DirectionalLight('#e2e8ef', 0.75)
  rim.position.set(4.5, 5.5, -3)
  rim.target.position.copy(target)
  scene.add(rim, rim.target)

  const grain = texture(brushedSurface())
  await load.checkpoint()
  grain.wrapS = grain.wrapT = RepeatWrapping
  grain.repeat.set(3, 3)
  const material = (options) => own(new MeshPhysicalMaterial(options))
  // Rougher metal spreads each highlight over a wider area instead of a point.
  const metal = material({ color: '#3b444d', metalness: 0.88, roughness: 0.38, bumpMap: grain, bumpScale: 0.0017 })
  const edgeMetal = material({ color: '#a1adb7', metalness: 0.96, roughness: 0.3 })
  const faceMetal = material({ color: '#59636d', metalness: 0.86, roughness: 0.38, bumpMap: grain, bumpScale: 0.0015 })
  const lidMetal = material({ color: '#48525b', metalness: 0.88, roughness: 0.36, bumpMap: grain, bumpScale: 0.0012 })
  const plastic = material({ color: '#12161a', metalness: 0.08, roughness: 0.49 })
  const rubber = material({ color: '#080b0d', roughness: 0.9 })
  const chrome = material({ color: '#cbd5dd', metalness: 1, roughness: 0.19 })
  const blackChrome = material({ color: '#38434b', metalness: 0.85, roughness: 0.32 })
  const controlMetal = material({ color: '#3d454d', metalness: 0.86, roughness: 0.25, bumpMap: grain, bumpScale: 0.0014 })
  const accentMetal = material({ color: accent, metalness: 0.18, roughness: 0.42, emissive: accent, emissiveIntensity: 0.2 })
  const activeAccentMetal = material({ color: activeAccent, metalness: 0.18, roughness: 0.42, emissive: activeAccent, emissiveIntensity: 0.28 })

  const mesh = (geometry, surface, position = [0, 0, 0], parent = deck, shadows = true) => {
    own(geometry)
    const object = new Mesh(geometry, surface)
    object.position.set(...position)
    object.castShadow = object.receiveShadow = shadows
    parent.add(object)
    return object
  }
  const box = (size, position, surface, parent = deck, radius = 0.035) => mesh(
    new RoundedBoxGeometry(...size, cachedRendering && Math.min(...size) < 0.1 ? 1 : 3, Math.min(radius, Math.min(...size) / 3)), surface, position, parent,
  )
  const cylinder = (radius, height, position, surface, parent = deck, segments = 64) => mesh(
    new CylinderGeometry(radius, radius, height, segments), surface, position, parent,
  )
  const ring = (inner, outer, y, surface, parent = deck) => {
    const object = mesh(new RingGeometry(inner, outer, 160), surface, [0, y, 0], parent)
    object.rotation.x = -Math.PI / 2
    return object
  }
  const logoImages = []
  load.onCleanup(() => { for (const image of logoImages) image.onload = null })
  const logoSurface = (url, width, height, { background, padding = 0 } = {}) => {
    const source = makeCanvas(width, height, (ctx) => {
      if (background) {
        ctx.fillStyle = background
        ctx.fillRect(0, 0, width, height)
      }
    })
    const map = texture(source, true)
    const image = new Image()
    logoImages.push(image)
    image.onload = () => {
      if (disposed) return
      source.getContext('2d').drawImage(image, padding, padding, width - padding * 2, height - padding * 2)
      map.needsUpdate = true
      volumeCaptureVersion++
      invalidate()
    }
    image.src = url
    return own(new MeshBasicMaterial({ map, transparent: !background, depthWrite: Boolean(background), toneMapped: false }))
  }
  const heartSurface = logoSurface(logoHeart, 256, 256)
  const wordmarkSurface = logoSurface(boltWordmark, 512, 200)
  const hubSurface = logoSurface(logoHeart, 128, 128, { background: '#242a2e', padding: 16 })
  const logo = (surface, width, height, position, parent = deck) => {
    const object = mesh(new PlaneGeometry(width, height), surface, position, parent, false)
    object.userData.ignoreHit = true
    return object
  }
  const label = (text, width, height, position, { top = false, color = '#c7cdd0', font = '500', size = 30 } = {}, parent = deck) => {
    const source = makeCanvas(512, 128, (ctx) => {
      ctx.font = `${font} ${Math.min(108, Math.max(80, size))}px Arial, sans-serif`
      ctx.fillStyle = color
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(text, 256, 64, 480)
    })
    const surface = own(new MeshBasicMaterial({ map: texture(source, true), transparent: true, depthWrite: false, toneMapped: true, polygonOffset: true, polygonOffsetFactor: -1 }))
    const object = mesh(new PlaneGeometry(width, height), surface, position, parent, false)
    if (top) object.rotation.x = -Math.PI / 2
    object.userData.ignoreHit = true
    return object
  }

  // A machined shell, a separate bevelled fascia, and an actual recessed tray.
  box([4.8, 0.47, 5.25], [0, 0.34, 0], metal, deck, 0.1)
  box([4.75, 0.025, 5.2], [0, 0.113, 0], blackChrome, deck, 0.05)
  // A separate case seam and inset side vents read as assembled hardware.
  for (const side of [-1, 1]) {
    box([0.012, 0.014, 5.04], [side * 2.402, 0.47, 0], blackChrome)
    for (let slot = 0; slot < 15; slot++) {
      box([0.012, 0.165, 0.06], [side * 2.403, 0.325, -1.63 + slot * 0.21], plastic, deck, 0.006)
      box([0.014, 0.006, 0.06], [side * 2.405, 0.408, -1.63 + slot * 0.21], edgeMetal, deck, 0.002)
      await load.checkpoint()
    }
  }
  const topShape = roundedOutline(4.8, 5.25, 0.12)
  const opening = new Path()
  opening.absarc(0, -DISC_CENTER_Z, TRAY_RADIUS + 0.01, 0, TAU, true)
  topShape.holes.push(opening)
  const top = mesh(new ExtrudeGeometry(topShape, { depth: 0.12, steps: 1, bevelEnabled: true, bevelSegments: 3, bevelSize: 0.016, bevelThickness: 0.014, curveSegments: 48 }), faceMetal, [0, 0.575, 0])
  top.rotation.x = -Math.PI / 2
  await load.checkpoint()
  const tray = new Group()
  tray.position.z = DISC_CENTER_Z
  deck.add(tray)
  cylinder(TRAY_RADIUS - 0.012, 0.025, [0, 0.57, 0], plastic, tray)
  ring(TRAY_RADIUS - 0.08, TRAY_RADIUS - 0.01, 0.588, blackChrome, tray)
  ring(TRAY_RADIUS - 0.12, TRAY_RADIUS - 0.075, 0.593, rubber, tray)
  const trayDetailMap = texture(makeCanvas(1024, 1024, ctx => {
    const cx = 512, cy = 512
    ctx.clearRect(0, 0, 1024, 1024)
    for (const radius of [426, 438, 462, 474]) {
      ctx.beginPath(); ctx.arc(cx, cy, radius, 0, TAU)
      ctx.strokeStyle = radius % 4 ? '#0a0c0ebb' : '#63707855'
      ctx.lineWidth = radius === 438 ? 5 : 2; ctx.stroke()
    }
    // Moulded radial ribs and recesses have a dark edge and a lit shoulder.
    for (let i = 0; i < 24; i++) {
      const angle = i * TAU / 24
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(angle)
      ctx.fillStyle = '#090c0f99'; ctx.fillRect(355, -3, 76, 6)
      ctx.fillStyle = '#89959c33'; ctx.fillRect(355, -4, 76, 1)
      ctx.restore()
    }
    for (const angle of [0.55, 2.6, 4.25, 5.5]) {
      const x = cx + Math.cos(angle) * 394, y = cy + Math.sin(angle) * 394
      ctx.beginPath(); ctx.arc(x, y, 12, 0, TAU)
      ctx.fillStyle = '#090b0e'; ctx.fill()
      ctx.beginPath(); ctx.arc(x, y, 7, 0, TAU)
      ctx.fillStyle = '#6f777d'; ctx.fill()
      ctx.strokeStyle = '#171b20'; ctx.lineWidth = 2
      ctx.beginPath(); ctx.moveTo(x - 4, y); ctx.lineTo(x + 4, y)
      ctx.moveTo(x, y - 4); ctx.lineTo(x, y + 4); ctx.stroke()
    }
    ctx.font = '16px Arial'; ctx.fillStyle = '#8c969d99'
    ctx.fillText('OPTICAL DISC SYSTEM', 340, 800)
    ctx.font = '11px Arial'; ctx.fillStyle = '#727c8488'
    ctx.fillText('PRECISION TRANSPORT / DIGITAL AUDIO', 340, 823)
  }), true)
  const trayDetail = mesh(new PlaneGeometry(4.42, 4.42), own(new MeshBasicMaterial({
    map: trayDetailMap, transparent: true, depthWrite: false, toneMapped: true,
  })), [0, 0.588, 0], tray, false)
  trayDetail.rotation.x = -Math.PI / 2
  await load.checkpoint()
  // A recessed optical transport stays visible when the record leaves the
  // tray. Every part sits below the record plane, including its printed marks.
  const transportPlastic = material({ color: '#22262a', metalness: 0.15, roughness: 0.48 })
  const transportEdge = material({ color: '#454b50', metalness: 0.6, roughness: 0.36 })
  const transport = new Group()
  transport.position.set(0.88, 0, -0.38)
  transport.rotation.y = 0.38
  tray.add(transport)
  box([2.08, 0.024, 0.68], [0, 0.593, 0], transportEdge, transport, 0.06)
  box([2.02, 0.019, 0.6], [0, 0.608, 0], transportPlastic, transport, 0.045)
  for (const z of [-0.235, 0.235]) {
    box([1.74, 0.012, 0.018], [0.03, 0.603, z], blackChrome, transport, 0.004)
  }
  cylinder(0.13, 0.012, [0.2, 0.607, 0], blackChrome, transport)
  cylinder(0.086, 0.008, [0.2, 0.612, 0], chrome, transport)
  cylinder(0.061, 0.006, [0.2, 0.617, 0], material({ color: '#283750', metalness: 0.65, roughness: 0.12 }), transport)
  // A laser carriage rides on two polished guide rods beside its flex cable.
  box([0.44, 0.013, 0.3], [0.2, 0.605, 0], blackChrome, transport, 0.025)
  for (const z of [-0.19, 0.19]) {
    const rod = cylinder(0.012, 1.6, [0.02, 0.61, z], chrome, transport, 16)
    rod.rotation.z = Math.PI / 2
    for (const x of [-0.75, 0.79]) box([0.09, 0.028, 0.07], [x, 0.597, z], plastic, transport, 0.012)
  }
  const flexCopper = material({ color: '#775131', metalness: 0.4, roughness: 0.48 })
  box([0.57, 0.005, 0.1], [0.59, 0.613, 0.09], flexCopper, transport, 0.005)
  for (let i = 0; i < 6; i++) {
    box([0.49, 0.002, 0.003], [0.59, 0.617, 0.05 + i * 0.014], edgeMetal, transport, 0.0005)
  }
  for (const x of [-0.89, 0.89]) for (const z of [-0.25, 0.25]) {
    cylinder(0.026, 0.005, [x, 0.618, z], edgeMetal, transport, 16)
    box([0.026, 0.002, 0.005], [x, 0.622, z], rubber, transport, 0.001)
  }
  label('BOLT / OPTICAL TRANSPORT', 0.94, 0.06, [0.04, 0.619, -0.16], { top: true, color: '#969b9f' }, transport)
  label('CLASS 1 LASER', 0.52, 0.045, [0.58, 0.619, 0.16], { top: true, color: '#737b80' }, transport)
  // The spindle clamp is separate from the moving CD.
  cylinder(0.36, 0.034, [0, 0.597, 0], transportPlastic, tray)
  ring(0.27, 0.35, 0.616, blackChrome, tray)
  for (const x of [-1.85, 1.85]) for (const z of [-2.08, 2.08]) {
    cylinder(0.19, 0.105, [x, 0.062, z], rubber)
    cylinder(0.2, 0.035, [x, 0.105, z], blackChrome)
  }

  // The exposed data layer has thin-film iridescence and concentric grooves;
  // printed artwork is a separate coated layer with a real central aperture.
  const disc = new Group()
  await load.checkpoint()
  disc.position.set(0, 0.619, DISC_CENTER_Z)
  disc.userData.action = 'seek'
  deck.add(disc)
  const foil = material({ color: '#dae2e8', metalness: 0.95, roughness: 0.23, iridescence: 0.8, iridescenceIOR: 1.36, iridescenceThicknessRange: [180, 420], anisotropy: 0.75, bumpMap: texture(discSurface()), bumpScale: 0.00025, side: DoubleSide })
  {
    // The opaque print hides most foil. Preserve its exact backing depth with
    // a cheap pass, and shade iridescence only on the exposed hub/rim/wall.
    // This avoids two full-disc physical-material passes during every turn.
    const backing = own(new MeshBasicMaterial({ color: '#c7ced3', colorWrite: cachedRendering, side: DoubleSide }))
    ring(0.24, DISC_RADIUS + 0.002, 0.006, backing, disc)
    const parts = [new CylinderGeometry(DISC_RADIUS, DISC_RADIUS, 0.009, 160, 1, true)]
    for (const [inner, outer, y] of [
      [0.24, DISC_HUB_RADIUS + 0.002, 0.0045],
      [0.24, DISC_HUB_RADIUS + 0.002, 0.006],
      [DISC_ARTWORK_RADIUS - 0.002, DISC_RADIUS + 0.002, 0.006],
    ]) {
      const part = new RingGeometry(inner, outer, 160)
      part.rotateX(-Math.PI / 2).translate(0, y, 0)
      parts.push(part)
    }
    const geometry = mergeGeometries(parts)
    parts.forEach(part => part.dispose())
    mesh(geometry, foil, [0, 0, 0], disc)
  }
  // Keep foil and spindle depth for occlusion. The print records its visible
  // coverage separately, avoiding a second depth comparison against stale
  // MSAA samples of almost coplanar faces at steep viewing angles.
  const artworkMaterial = material({ color: '#f7f7f4', metalness: 0.08, roughness: 0.4, clearcoat: 0.65, clearcoatRoughness: 0.3, side: DoubleSide, depthWrite: false })
  const artworkGeometry = new RingGeometry(DISC_HUB_RADIUS, DISC_ARTWORK_RADIUS, 160)
  const positions = artworkGeometry.attributes.position
  const uv = artworkGeometry.attributes.uv
  const artworkDiameter = DISC_ARTWORK_RADIUS * 2
  for (let i = 0; i < positions.count; i++) uv.setXY(i, positions.getX(i) / artworkDiameter + 0.5, positions.getY(i) / artworkDiameter + 0.5)
  const artwork = mesh(artworkGeometry, artworkMaterial, [0, 0.008, 0], disc)
  artwork.rotation.x = -Math.PI / 2
  // Prints do not write depth. Draw them after all opaque parts so batching
  // cannot let a later bezel/chassis draw overwrite their already shaded pixels.
  artwork.renderOrder = 1
  if (cachedRendering) {
    // The lightweight disc overlays this static frame. Its central aperture
    // exposes the spindle and its outer mask keeps the metal rings visible.
    artwork.visible = false
  }
  ring(0.248, 0.27, 0.011, chrome, disc)
  ring(DISC_ARTWORK_RADIUS - 0.002, DISC_ARTWORK_RADIUS + 0.002, 0.012, chrome, disc)
  // A low-profile clamp rises 0.047 above the 0.627 record plane (about
  // 1.3 mm relative to a 120 mm CD), with a small polished shoulder.
  mesh(new LatheGeometry([
    [0.229, 0.629], [0.241, 0.633], [0.244, 0.637],
    [0.239, 0.648], [0.233, 0.655], [0.229, 0.659],
  ].map(([radius, height]) => new Vector2(radius, height)), 64), blackChrome, [0, 0, 0], tray)
  mesh(new LatheGeometry([
    [0.229, 0.655], [0.235, 0.658], [0.232, 0.662],
    [0.225, 0.666], [0.216, 0.668],
  ].map(([radius, height]) => new Vector2(radius, height)), 64), chrome, [0, 0, 0], tray)
  const spindleCap = cylinder(0.216, 0.012, [0, 0.668, 0], [blackChrome, hubSurface, blackChrome], tray)
  spindleCap.userData.spindleCrown = true
  spindleCap.rotation.y = Math.PI / 2

  // The lid fits over the shell: its skirt overlaps the case on every side,
  // while recessed glass covers the disc and a separate opening exposes controls.
  const lidWidth = 4.92
  const lidLength = 5.37
  const glassWidth = 4.58
  const glassLength = 4.52
  const glassOffsetZ = -0.245
  const lidPivot = new Group()
  await load.checkpoint()
  lidPivot.position.set(0, 0.782, -lidLength / 2)
  lidPivot.rotation.x = LID_CLOSED_ANGLE
  lidPivot.userData.moving = true
  lidPivot.userData.lid = true
  deck.add(lidPivot)
  const lidPlate = (outline, depth, surface, y, offsetZ = 0) => {
    const object = mesh(new ExtrudeGeometry(outline, { depth, steps: 1,
      bevelEnabled: surface === lidMetal, bevelSegments: 2, bevelSize: 0.008,
      bevelThickness: 0.008, curveSegments: 16 }), surface, [0, y, lidLength / 2 + offsetZ], lidPivot)
    object.rotation.x = -Math.PI / 2
    object.castShadow = false
    object.userData.ignoreHit = true
    return object
  }
  const frameOutline = (width, length, radius, inset) => {
    const outline = roundedOutline(width, length, radius)
    outline.holes.push(new Path(roundedOutline(width - inset * 2, length - inset * 2, radius - inset).getPoints(16).reverse()))
    return outline
  }
  const capOutline = roundedOutline(lidWidth, lidLength, 0.18)
  const addOpening = (width, length, radius, offsetZ) => {
    const points = roundedOutline(width, length, radius).getPoints(16)
    // The horizontal plate's rotation maps profile Y to negative deck Z.
    for (const point of points) point.y -= offsetZ
    capOutline.holes.push(new Path(points.reverse()))
  }
  addOpening(glassWidth, glassLength, 0.125, glassOffsetZ)
  addOpening(4.67, 0.505, 0.045, 2.3475)
  lidPlate(capOutline, 0.042, lidMetal, -0.036)
  await load.checkpoint()
  lidPlate(frameOutline(lidWidth, lidLength, 0.18, 0.055), 0.17, lidMetal, -0.164)
  await load.checkpoint()
  // A narrow machined lip catches the light without brightening the shell.
  lidPlate(frameOutline(lidWidth - 0.025, lidLength - 0.025, 0.168, 0.014), 0.003, edgeMetal, 0.013)
  await load.checkpoint()
  for (const x of [-2.375, 2.375]) for (const z of [0.15, lidLength - 0.15]) {
    cylinder(0.029, 0.004, [x, 0.011, z], blackChrome, lidPivot, 16)
    cylinder(0.02, 0.004, [x, 0.014, z], edgeMetal, lidPivot, 16)
    box([0.024, 0.002, 0.004], [x, 0.017, z], rubber, lidPivot, 0.001)
  }
  // Keep the upper edge clean, with one centered bank of ventilation slots.
  for (let slot = 0; slot < 12; slot++) {
    const x = -1.155 + slot * 0.21
    box([0.058, 0.004, 0.13], [x, 0.018, 0.115], plastic, lidPivot, 0.006)
    box([0.006, 0.005, 0.13], [x + 0.035, 0.019, 0.115], edgeMetal, lidPivot, 0.002)
    await load.checkpoint()
  }
  // Alpha glass retains restrained reflections without transmission's extra
  // scene passes, including on the software renderer.
  const glass = material({ color: '#c4cfd8', metalness: 0, roughness: 0.12, clearcoat: 0.7, clearcoatRoughness: 0.12, envMapIntensity: 0.55, transparent: true, opacity: 0.115, depthWrite: false })
  lidPlate(roundedOutline(glassWidth, glassLength, 0.125), 0.028, glass, -0.028, glassOffsetZ)
  await load.checkpoint()
  const glassEdge = own(new MeshBasicMaterial({ color: '#22282e', transparent: true, opacity: 0.55, depthWrite: false }))
  lidPlate(frameOutline(glassWidth + 0.024, glassLength + 0.024, 0.137, 0.012), 0.003, glassEdge, 0.008, glassOffsetZ)
  await load.checkpoint()
  for (const x of [-1.43, 1.43]) {
    const hinge = cylinder(0.044, 0.36, [x, 0.751, -2.635], blackChrome)
    hinge.rotation.z = Math.PI / 2
    box([0.28, 0.018, 0.12], [x, 0.736, -2.625], metal)
  }

  // Build the transport as solid parts, then mount it below the glass on the
  // broad face. Each action stays a direct deck child for hit testing.
  const controlStart = deck.children.length
  box([4.63, 0.445, 0.066], [0, 0.35, 2.244], controlMetal, deck, 0.035)
  logo(wordmarkSurface, 0.86, 0.334, [0, 0.354, 2.319])

  const buttons = {}
  for (const [action, x, y, radius] of [
    ['play', 0.63, 0.361, 0.119], ['previous', 1.025, 0.441, 0.074],
    ['next', 1.32, 0.441, 0.074], ['shuffle', 1.025, 0.252, 0.062], ['repeat', 1.32, 0.252, 0.062],
  ]) {
    const button = new Group()
    button.position.set(x, y, 2.315)
    button.userData.action = action
    deck.add(button)
    const collar = cylinder(radius + 0.012, 0.026, [0, 0, -0.014], rubber, button, 48)
    collar.rotation.x = Math.PI / 2
    const face = cylinder(radius, 0.041, [0, 0, 0], accentMetal, button, 48)
    face.rotation.x = Math.PI / 2
    const iconCanvas = makeCanvas(128, 128, (ctx) => paintIcon(ctx, action, 128))
    const iconMap = texture(iconCanvas, true)
    const icon = mesh(new PlaneGeometry(radius * 1.5, radius * 1.5), own(new MeshBasicMaterial({ map: iconMap, transparent: true, depthWrite: false })), [0, 0, 0.022], button, false)
    buttons[action] = { group: button, face, collar, radius, icon, restPosition: button.position.clone(), iconCanvas, iconMap, selected: false, kind: action }
    await load.checkpoint()
  }
  const volume = new Group()
  volume.position.set(1.851, 0.363, 2.329)
  volume.userData.action = 'volume'
  deck.add(volume)
  const dialBase = cylinder(0.202, 0.056, [0, 0, -0.02], rubber, volume, 80)
  dialBase.rotation.x = Math.PI / 2
  const dial = cylinder(0.188, 0.121, [0, 0, 0.032], blackChrome, volume, 96)
  dial.rotation.x = Math.PI / 2
  const ridges = new InstancedMesh(own(new BoxGeometry(0.007, 0.014, 0.084)), edgeMetal, 72)
  const ridgeTransform = new Object3D()
  for (let i = 0; i < 72; i++) {
    const angle = i / 72 * TAU
    ridgeTransform.position.set(Math.sin(angle) * 0.188, Math.cos(angle) * 0.188, 0.033)
    ridgeTransform.rotation.z = -angle
    ridgeTransform.updateMatrix()
    ridges.setMatrixAt(i, ridgeTransform.matrix)
  }
  ridges.castShadow = true
  volume.add(ridges)
  const dialFace = cylinder(0.172, 0.012, [0, 0, 0.097], faceMetal, volume, 80)
  dialFace.rotation.x = Math.PI / 2
  const volumeMarker = new Group()
  volume.add(volumeMarker)
  box([0.009, 0.041, 0.006], [0, 0.128, 0.108], chrome, volumeMarker, 0.002)


  const controlOrigin = new Vector3(0, 0.35, 2.3)
  const controlPosition = new Vector3(0, 0.72, 2.32)
  const controlAxis = new Vector3(1, 0, 0)
  for (const object of deck.children.slice(controlStart)) {
    object.position.sub(controlOrigin).applyAxisAngle(controlAxis, -Math.PI / 2).add(controlPosition)
    object.rotateOnWorldAxis(controlAxis, -Math.PI / 2)
  }
  for (const button of Object.values(buttons)) button.restPosition.copy(button.group.position)
  // Small ceramic indicators sit on the lower metal fascia.
  const indicatorSurface = material({ color: '#e9ece4', metalness: 0.15, roughness: 0.38 })
  for (let index = 0; index < 4; index++) {
    const x = -1.51 + index * 0.19
    box([0.115, 0.008, 0.06], [x, 0.792, 2.32], blackChrome, deck, 0.01)
    box([0.087, 0.008, 0.034], [x, 0.798, 2.32], indicatorSurface, deck, 0.004)
  }
  label('CD / 01', 0.48, 0.075, [1.28, 0.804, 2.32], { top: true, color: '#899399' })

  // The control faces are live 2D patches, like the disc. Keeping them
  // outside the chassis poses makes volume/play/shuffle/repeat independent of
  // the expensive preparation. The body still uses its original 3D poses.
  const softwareControls = []
  load.onCleanup(() => { for (const { patch } of softwareControls) { patch.width = patch.height = 0; patch.remove() } })

  // The five transports share just three GPU submissions. Keep their original
  // meshes as hit targets; instance matrices retain the physical press motion.
  const transportBatches = []
  load.onCleanup(() => { for (const { batch } of transportBatches) batch.dispose() })
  const transportButtons = Object.values(buttons)
  const transportMatrix = new Matrix4()
  const transportScale = new Vector3()
  let iconBatch = null
  load.onCleanup(() => iconBatch?.dispose())
  let iconAtlas = null
  let iconAtlasTexture = null
  const iconVersions = []
  let transportDirty = true
  if (!cachedRendering) {
    const geometry = own(new CylinderGeometry(1, 1, 1, 48))
    for (const [surface, part] of [[rubber, 'collar'], [accentMetal, 'face'], [activeAccentMetal, 'face']]) {
      const batch = new InstancedMesh(geometry, surface, transportButtons.length)
      batch.castShadow = batch.receiveShadow = true
      batch.frustumCulled = false
      batch.userData.ignoreHit = true
      deck.add(batch)
      transportBatches.push({ batch, part })
    }
    for (const button of transportButtons) {
      for (const part of ['face', 'collar']) {
        const object = button[part]
        object.visible = false
        object.updateMatrix()
      }
    }
    // Share one icon texture and draw. Individual canvases remain the sources
    // for interruptible fades; only changed slots are painted into the atlas.
    iconAtlas = makeCanvas(128 * transportButtons.length, 128)
    iconAtlasTexture = texture(iconAtlas, true)
    const iconGeometry = own(new PlaneGeometry(1, 1))
    iconGeometry.setAttribute('iconSlot', new InstancedBufferAttribute(
      Float32Array.from(transportButtons, (_, index) => index / transportButtons.length), 1,
    ))
    const iconSurface = own(new ShaderMaterial({
      uniforms: { iconMap: { value: iconAtlasTexture }, iconWidth: { value: 1 / transportButtons.length } },
      vertexShader: `attribute float iconSlot;
        uniform float iconWidth;
        varying vec2 iconUv;
        void main() {
          iconUv = vec2(iconSlot + uv.x * iconWidth, uv.y);
          vec3 transformed = vec3(position);
          #include <project_vertex>
        }`,
      fragmentShader: `uniform sampler2D iconMap;
        varying vec2 iconUv;
        void main() {
          gl_FragColor = texture2D(iconMap, iconUv);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false,
    }))
    iconBatch = new InstancedMesh(iconGeometry, iconSurface, transportButtons.length)
    iconBatch.frustumCulled = false
    iconBatch.userData.ignoreHit = true
    deck.add(iconBatch)
    for (const button of transportButtons) button.icon.visible = false
  }
  function updateTransportBatches() {
    if (!transportBatches.length || !transportDirty) return
    transportDirty = false
    for (const button of transportButtons) button.group.updateMatrix()
    for (const { batch, part } of transportBatches) {
      let index = 0
      for (const button of transportButtons) {
        if (button[part].material !== batch.material) continue
        const radius = button.radius + (part === 'collar' ? 0.012 : 0)
        transportMatrix.multiplyMatrices(button.group.matrix, button[part].matrix)
        transportMatrix.scale(transportScale.set(radius, part === 'collar' ? 0.026 : 0.041, radius))
        batch.setMatrixAt(index++, transportMatrix)
      }
      batch.count = index
      batch.instanceMatrix.needsUpdate = true
    }
    const ctx = iconAtlas.getContext('2d')
    let changed = false
    transportButtons.forEach((button, index) => {
      button.icon.updateMatrix()
      transportMatrix.multiplyMatrices(button.group.matrix, button.icon.matrix)
      const size = button.radius * 1.5
      transportMatrix.scale(transportScale.set(size, size, 1))
      iconBatch.setMatrixAt(index, transportMatrix)
      if (iconVersions[index] !== button.iconMap.version) {
        ctx.clearRect(index * 128, 0, 128, 128)
        ctx.drawImage(button.iconCanvas, index * 128, 0)
        iconVersions[index] = button.iconMap.version
        changed = true
      }
    })
    iconBatch.instanceMatrix.needsUpdate = true
    if (changed) iconAtlasTexture.needsUpdate = true
  }

  // Keep transport state objects for playback feedback, but the chassis has
  // no physical controls or raycast targets; interaction stays on the disc.
  for (const button of Object.values(buttons)) deck.remove(button.group)
  deck.remove(volume)
  for (const { batch } of transportBatches) deck.remove(batch)
  if (iconBatch) deck.remove(iconBatch)

  // Rear connections and the underside remain physical when the
  // user inspects the player from another angle.
  for (const x of [-1.78, -1.49, 1.72]) {
    const socket = cylinder(0.065, 0.045, [x, 0.345, -2.652], chrome)
    socket.rotation.x = Math.PI / 2
    const hole = cylinder(0.046, 0.047, [x, 0.345, -2.661], rubber)
    hole.rotation.x = Math.PI / 2
  }
  box([0.23, 0.093, 0.022], [1.35, 0.345, -2.653], rubber)
  const rearLabel = label('BOLT  /  DIGITAL AUDIO  /  12V DC', 1.96, 0.088, [0, 0.365, -2.676], { size: 48, color: '#899399' })
  rearLabel.rotation.y = Math.PI
  const rearHeart = logo(heartSurface, 1.35, 1.35, [0, 0.091, DISC_CENTER_Z])
  rearHeart.rotation.set(-Math.PI / 2, Math.PI, 0)

  const surfaceBatches = []
  const geometryLoader = createCdGeometryLoader(load, signal)
  for (const parent of cachedRendering ? [deck] : [deck, lidPivot, disc, volume]) {
    // Parameter attributes allow different opaque metals/plastics to share
    // draws. Each moving group keeps its own local geometry and hit target.
    deck.updateMatrixWorld(true)
    const inverse = parent.matrixWorld.clone().invert()
    const batches = new Map()
    parent.traverse((object) => {
      if (!object.isMesh || object.isInstancedMesh || Array.isArray(object.material) || object.material.transparent) return
      if (object === artwork || !object.visible) return
      for (let ancestor = object; ancestor && ancestor !== parent; ancestor = ancestor.parent) {
        if (ancestor.userData.action || ancestor.userData.moving || ancestor === volumeMarker) return
      }
      const surfaceKey = !cachedRendering && canBatchCdSurface(object.material)
        ? `surface:${object.material.bumpMap?.uuid || 'plain'}:${object.material.side}` : object.material.uuid
      const key = `${surfaceKey}:${object.castShadow}:${object.receiveShadow}:${Boolean(object.userData.ignoreHit)}`
      if (!batches.has(key)) batches.set(key, [])
      batches.get(key).push(object)
    })
    for (const objects of batches.values()) {
      await load.checkpoint()
      if (objects.length < 2) continue
      const sources = [...new Set(objects.map(object => object.material))]
      const parameterized = sources.length > 1
      const indexedGeometry = own(await geometryLoader.batch(objects, inverse, sources, parameterized))
      await load.checkpoint()
      const first = objects[0]
      let surface = first.material
      if (parameterized) {
        const batch = createCdSurfaceBatch(indexedGeometry, sources)
        surface = own(batch.material)
        surfaceBatches.push(batch)
      }
      const combined = mesh(indexedGeometry, surface, [0, 0, 0], parent, false)
      combined.castShadow = first.castShadow
      combined.receiveShadow = first.receiveShadow
      combined.userData.ignoreHit = first.userData.ignoreHit
      for (const object of objects) {
        object.removeFromParent()
        resources.delete(object.geometry)
        object.geometry.dispose()
      }
    }
  }
  geometryLoader.dispose()

  // The player is built on the XZ plane. Stand the complete chassis upright
  // and lift its front edge just above the floor without changing its parts.
  deck.rotation.x = Math.PI / 2
  deck.position.y = DECK_STANDING_Y
  deck.updateMatrixWorld(true)
  await load.checkpoint()
  const softwareFaceCorners = [[-2.5, -2.7], [2.5, -2.7], [2.5, 2.7], [-2.5, 2.7]]
    .map(([x, z]) => new Vector3(x, 0.7, z).applyMatrix4(deck.matrixWorld))
  const reactionCorners = []
  for (const x of [-2.5, 2.5]) for (const y of [0, 1]) for (const z of [-2.7, 2.7]) {
    reactionCorners.push(new Vector3(x, y, z).applyMatrix4(deck.matrixWorld))
  }
  const reactionPoint = new Vector3()
  const restingPoint = new Vector3()
  const lidCorners = []
  for (const x of [-lidWidth / 2 - 0.1, lidWidth / 2 + 0.1]) for (const y of [-0.2, 0.07]) for (const z of [-0.1, lidLength + 0.1]) {
    lidCorners.push(new Vector3(x, y, z))
  }
  const motionCorners = [...reactionCorners, ...lidCorners.map(() => new Vector3())]
  function renderMotionFrame() {
    lidPivot.updateWorldMatrix(true, false)
    lidCorners.forEach((corner, index) => motionCorners[reactionCorners.length + index].copy(corner).applyMatrix4(lidPivot.matrixWorld))
    motionRegion = growCdMotionRegion(motionRegion,
      cdMotionRegion(motionCorners, camera, framePixelWidth, framePixelHeight), framePixelWidth, framePixelHeight)
    motionPixels = { x: 0, y: 0, width: Math.ceil(motionRegion.width * MOTION_RENDER_SCALE), height: Math.ceil(motionRegion.height * MOTION_RENDER_SCALE) }
    // A conservative buffer covers ordinary skips. Grow only if an inspected
    // view/open lid needs more; no reallocations as the spring returns to rest.
    if (motionPixels.width > motionFrame.width || motionPixels.height > motionFrame.height) {
      motionFrame.setSize(Math.max(motionFrame.width, motionPixels.width), Math.max(motionFrame.height, motionPixels.height))
    }
    motionCamera.copy(camera)
    const view = camera.view
    const top = framePixelHeight - motionRegion.y - motionRegion.height
    motionCamera.setViewOffset(view.fullWidth, view.fullHeight,
      view.offsetX + motionRegion.x / framePixelWidth * view.width,
      view.offsetY + top / framePixelHeight * view.height,
      motionRegion.width / framePixelWidth * view.width,
      motionRegion.height / framePixelHeight * view.height)
    motionFrame.viewport.set(0, 0, motionPixels.width, motionPixels.height)
    motionFrame.scissor.copy(motionFrame.viewport)
    motionFrame.scissorTest = true
    renderer.setRenderTarget(motionFrame)
    renderer.render(scene, motionCamera)
    renderer.setScissorTest(false)
  }

  const discOverlays = new Set()
  if (!cachedRendering) {
    for (const light of scene.children.filter((object) => object.isLight)) {
      light.layers.enable(DISC_PLAYBACK_LAYER)
      light.layers.enable(GLASS_CACHE_LAYER)
    }
    artwork.layers.enable(DISC_PLAYBACK_LAYER)
    artworkMaterial.stencilRef = 1
    artworkMaterial.stencilFunc = AlwaysStencilFunc
    artworkMaterial.stencilZPass = ReplaceStencilOp
    lidPivot.traverse((object) => {
      if (!object.isMesh || !object.material.transparent) return
      object.layers.enable(GLASS_CACHE_LAYER)
      const surface = object.material
      surface.stencilRef = 1
      surface.stencilFunc = EqualStencilFunc
      surface.stencilZPass = KeepStencilOp
      discOverlays.add(surface)
    })
  }
  const renderSize = new Vector2()
  const discCorner = new Vector3()
  let discScissor = null
  let needsFullRender = true
  const spin = createDiscSpin()
  let renderedDiscMap = null
  let renderedDiscAngle = NaN
  let lightingDirty = true
  let whiteLighting = null
  let blackLighting = null
  let midLighting = null
  let visiblePrint = null
  const lightingCamera = camera.clone()
  const shadowPixelOffset = new Vector2()
  const lightingMaterial = cachedRendering ? null : own(artworkMaterial.clone())
  if (lightingMaterial) {
    lightingMaterial.map = null
    lightingMaterial.stencilWrite = false
    lightingMaterial.onBeforeCompile = (shader) => {
      // Three rotates PCF samples using screen coordinates. A cached tile
      // must retain the full frame's noise pattern to preserve the same shade.
      shader.uniforms.shadowPixelOffset = { value: shadowPixelOffset }
      shader.fragmentShader = `uniform vec2 shadowPixelOffset;\n${shader.fragmentShader}`.replace(
        '#include <shadowmap_pars_fragment>',
        ShaderChunk.shadowmap_pars_fragment.replaceAll('interleavedGradientNoise( gl_FragCoord.xy )', 'interleavedGradientNoise( gl_FragCoord.xy + shadowPixelOffset )'),
      )
    }
  }
  const playbackArtwork = cachedRendering ? null : own(new ShaderMaterial({
    uniforms: {
      artworkMap: { value: null }, artworkTransform: { value: null },
      whiteLight: { value: null }, blackLight: { value: null }, midLight: { value: null }, visiblePrint: { value: null }, lightingRegion: { value: new Vector4() },
    },
    vertexShader: `uniform mat3 artworkTransform;
      varying vec2 artworkUv;
      void main() {
        artworkUv = (artworkTransform * vec3(uv, 1.0)).xy;
        vec3 transformed = vec3(position);
        #include <project_vertex>
      }`,
    fragmentShader: `uniform sampler2D artworkMap;
      uniform sampler2D whiteLight;
      uniform sampler2D blackLight;
      uniform sampler2D midLight;
      uniform sampler2D visiblePrint;
      uniform vec4 lightingRegion;
      varying vec2 artworkUv;
      void main() {
        vec2 lightUv = (gl_FragCoord.xy - lightingRegion.xy) / lightingRegion.zw;
        if (texture2D(visiblePrint, lightUv).r < 0.5) discard;
        vec3 artworkColor = texture2D(artworkMap, artworkUv).rgb;
        vec3 black = texture2D(blackLight, lightUv).rgb;
        vec3 white = texture2D(whiteLight, lightUv).rgb;
        vec3 mid = texture2D(midLight, lightUv).rgb;
        vec3 curvature = 4.0 * (mid - 0.5 * (black + white));
        vec3 litColor = mix(black, white, artworkColor) + curvature * artworkColor * (1.0 - artworkColor);
        gl_FragColor = vec4(litColor, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    side: DoubleSide, depthTest: false, depthWrite: false,
    stencilWrite: true, stencilRef: 1,
    stencilFunc: AlwaysStencilFunc, stencilZPass: ReplaceStencilOp,
  }))
  const visibilityScene = new Scene()
  const visibilityMaterial = cachedRendering ? null : own(new ShaderMaterial({
    vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: 'void main() { gl_FragColor = vec4(1.0); }',
    depthTest: false, depthWrite: false, toneMapped: false,
    stencilWrite: true, stencilRef: 1, stencilFunc: EqualStencilFunc, stencilZPass: KeepStencilOp,
  }))
  if (visibilityMaterial) {
    const quad = new Mesh(own(new PlaneGeometry(2, 2)), visibilityMaterial)
    quad.frustumCulled = false
    visibilityScene.add(quad)
  }
  let glassCache = null
  let glassDirty = true
  let lastViewChangeAt = -Infinity
  const glassOrigin = new Vector2()
  const glassSurface = cachedRendering ? null : own(new ShaderMaterial({
    uniforms: { overlayMap: { value: null }, overlayRegion: { value: new Vector4() } },
    vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `uniform sampler2D overlayMap;
      uniform vec4 overlayRegion;
      void main() {
        vec2 uv = (gl_FragCoord.xy - overlayRegion.xy) / overlayRegion.zw;
        gl_FragColor = texture2D(overlayMap, uv);
      }`,
    transparent: true, premultipliedAlpha: true, toneMapped: false,
    depthTest: false, depthWrite: false,
    stencilWrite: true, stencilRef: 1, stencilFunc: EqualStencilFunc, stencilZPass: KeepStencilOp,
  }))
  const glassOverlay = glassSurface ? mesh(new PlaneGeometry(2, 2), glassSurface, [0, 0, 0], scene, false) : null
  if (glassOverlay) {
    glassOverlay.layers.set(DISC_PLAYBACK_LAYER)
    glassOverlay.frustumCulled = false
    glassOverlay.renderOrder = Infinity
    glassOverlay.visible = false
  }
  // Camera poses do not move the chassis meshes. Avoid traversing and
  // recalculating thousands of static local matrices during preparation too.
  freezeCdSceneTransforms(scene, [lidPivot, volumeMarker, ridges,
    ...cachedRendering ? Object.values(buttons).flatMap(button => [button.group, button.icon]) : [],
  ])

  const raycaster = new Raycaster()
  const pointer = new Vector2()
  const discPlane = new Plane(new Vector3(0, 0, 1), -0.63)
  const hitPoint = new Vector3()
  const localHitPoint = new Vector3()
  let state = { currentTime: 0, currentIndex: 0, volume: 1, duration: 0 }
  let busy = false
  let active = true
  let inViewport = true
  let powerSave = false
  let carouselActive = false, carouselCamera = null
  let volumeCarouselActive = false
  let discExchanging = false, discExchangeSliding = false, discSwipeActive = false
  let discExchangeSettling = false, discExchangeSettleTimer = 0
  let draggingDisc = false
  let dragProgress = 0
  let frame = 0
  let animationTimer = 0
  load.onCleanup(cancelRender)
  let lastRenderAt = -Infinity
  const frameCadence = createCdFrameCadence()
  let immediateFrame = false
  let timeAnchor = 0
  let timeChangedAt = performance.now()
  let coverVersion = 0
  let loadedCover = null
  let coverImage = null
  let lastIconKey = ''
  let playbackInitialized = false
  let lidInitialized = false
  let lidTarget = LID_CLOSED_ANGLE
  let lidMotion = null
  let viewMotion = null
  const viewAlignmentWaiters = new Set()
  function releaseViewAlignment() {
    if (viewMotion) return
    for (const resolve of viewAlignmentWaiters) resolve()
    viewAlignmentWaiters.clear()
  }
  let reactionMotion = null
  let seekFocusMotion = null
  const seekFocus = { value: 0, velocity: 0 }
  let seekGestureCamera = null
  let volumeSeeking = false
  const reaction = { theta: 0, phi: 0, roll: 0, zoom: 0, lift: 0 }
  const lidWaiters = new Set()
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
  const controlMotions = new Map()
  let controlMotionEnabled = true
  renderer.shadowMap.enabled = !constrainedDevice

  const progress = () => {
    if (draggingDisc) return dragProgress
    const elapsed = (performance.now() - timeChangedAt) / 1000
    const time = timeAnchor + (state.isPlaying && !powerSave && !reduced.matches ? Math.min(elapsed, 1.5) : 0)
    const duration = state.duration || state.currentTrack?.duration || 0
    return duration > 0 ? clamp(time / duration, 0, 1) : 0
  }
  function canRender() { return !disposed && active && inViewport && !document.hidden }
  function canAnimateControls() { return controlMotionEnabled && canRender() && !cachedRendering && !powerSave && !reduced.matches }
  function stopReaction() {
    if (carouselActive || carouselCamera) restoreCarousel()
    playbackMotion?.cancelActions()
    softwareFrames?.stop()
    reactionMotion = null
    for (const key of Object.keys(reaction)) reaction[key] = 0
    onAction?.(null)
    positionCamera()
    updateDiscOverlay()
  }
  function updateReaction(now = performance.now()) {
    if (!reactionMotion) return
    const at = Math.max(now, reactionMotion.updatedAt)
    const elapsed = (at - reactionMotion.updatedAt) / 1000
    reactionMotion.updatedAt = at
    let settled = true
    for (const key of Object.keys(reaction)) {
      const next = springStep(reaction[key], reactionMotion.velocity[key], 0, elapsed, REACTION_SPRING_OMEGA)
      reaction[key] = next.value
      reactionMotion.velocity[key] = next.velocity
      if (Math.abs(next.value) > 0.0005 || Math.abs(next.velocity) > 0.005) settled = false
    }
    positionCamera()
    // End the invisible tail at the actual projected pixel size. The visible
    // spring keeps its original trajectory and 60 Hz cadence.
    const rest = reactionMotion.rest
    if (rest && now - reactionMotion.startedAt > 180 && !viewMotion &&
      rest.theta === view.theta && rest.phi === view.phi) {
      let displacement = 0
      for (const corner of reactionCorners) {
        reactionPoint.copy(corner).project(camera)
        restingPoint.copy(corner).project(rest.camera)
        displacement = Math.max(displacement, Math.hypot(
          (reactionPoint.x - restingPoint.x) * frameWidth / 2,
          (reactionPoint.y - restingPoint.y) * frameHeight / 2,
        ))
      }
      if (displacement < 0.5) settled = true
    }
    if (settled || now - reactionMotion.startedAt > 650) {
      reactionMotion = null
      for (const key of Object.keys(reaction)) reaction[key] = 0
      positionCamera()
    }
    updateDiscOverlay()
  }
  function reactToAction(action) {
    const impulse = BODY_REACTIONS[action]
    if (!impulse || !controlMotionEnabled || !canRender() || powerSave || reduced.matches || seekFocus.value || seekFocusMotion || presentation === 'setup') return
    // Reuse the original turn at its prepared view. Manual orbit and phone
    // tilt need a physical camera reaction at the current angle instead.
    if (cachedRendering) {
      if (action === 'next' || action === 'previous') {
        onAction?.(null)
        if (playbackVolume?.visible && playbackMotion?.skip(action)) return
        if (canUseSoftwareFrames()) {
          softwareFrames?.warm(softwareFrameKey())
          if (softwareFrames?.play(action, { waitForReady: softwareRendering })) return
        }
        softwareFrames?.stop()
      } else {
        softwareFrames?.stop()
        onAction?.(action)
        return
      }
    }
    const now = performance.now()
    const rest = reactionMotion?.rest || (!reactionMotion && !viewMotion ? {
      camera: camera.clone(), theta: view.theta, phi: view.phi,
    } : null)
    updateReaction(now)
    const velocity = reactionMotion?.velocity || Object.fromEntries(Object.keys(reaction).map(key => [key, 0]))
    // A damped impulse moves the entire view, retaining velocity when another
    // action interrupts it.
    for (const key of Object.keys(reaction)) {
      const kick = (impulse[key] || 0) * Math.E * REACTION_SPRING_OMEGA
      const limit = (key === 'zoom' ? 0.14 : key === 'roll' ? 0.22 : 0.5) * Math.E * REACTION_SPRING_OMEGA
      velocity[key] = clamp(velocity[key] + kick, -limit, limit)
    }
    reactionMotion = { velocity, rest, updatedAt: now, startedAt: now }
    positionCamera()
    updateDiscOverlay()
    invalidate()
  }
  function restoreCarousel() {
    carouselActive = false
    volumeCarouselActive = false
    carouselCamera = null
    playbackMotion?.setCarouselAngle(0, false)
    canvas.style.transform = ''
    canvas.style.transformOrigin = ''
    softwareFrames?.stop()
    if (!playbackVolume?.visible) hideSoftwareControls()
    updateDiscOverlay(true)
    if (canUseSoftwareFrames()) softwareFrames?.warm(softwareFrameKey())
  }
  function presentSoftwarePose(pose) {
    syncPlaybackMotion()
    presentSoftwareControls(pose.controls)
    onDiscOverlayChange?.(pose.disc, true)
  }
  function volumeSkipTransform(angle) {
    if (Math.abs(angle) < 1e-10) return cdCssMatrixTransform(new Matrix4())
    const poseCamera = camera.clone()
    positionCamera(poseCamera, { theta: angle, phi: 0, roll: -angle * 0.065 / 0.28, zoom: 0, lift: 0 })
    const source = cdCssCameraMatrix(camera, target, frameWidth, frameHeight, staticCanvas.offsetLeft)
    const destination = cdCssCameraMatrix(poseCamera, target, frameWidth, frameHeight, staticCanvas.offsetLeft)
    return cdCssMatrixTransform(cdCssCameraDelta(source, destination))
  }
  function setCarouselMotion({ angle, active: moving }) {
    if (cachedRendering && onDiscChange) return
    if (!moving) { if (carouselActive || carouselCamera) restoreCarousel(); syncPlaybackMotion(); return }
    if (!mobile || initialPlayback || !canRender() || powerSave || reduced.matches || draggingDisc || seekFocusMotion || seekFocus.value) return
    if (!carouselActive) {
      stopReaction()
      volumeCarouselActive = Boolean(playbackVolume?.visible)
      carouselActive = true
    }
    syncPlaybackMotion()
    if (volumeCarouselActive && playbackMotion?.setCarouselAngle(angle)) return
    if (volumeCarouselActive) { volumeCarouselActive = false; syncPlaybackMotion() }
    carouselCamera = camera.clone()
    positionCamera(carouselCamera, { theta: angle, phi: 0, roll: -angle * 0.065 / 0.28, zoom: 0, lift: 0 })
    if (canUseSoftwareFrames() && softwareFrames?.present(angle)) {
      carouselCamera = softwareFrames.camera
      canvas.style.transform = ''
      canvas.style.transformOrigin = ''
      return
    }
    softwareFrames?.stop()
    const project = poseCamera => softwareFaceCorners.map(corner => {
      const point = corner.clone().project(poseCamera)
      return { x: (point.x + 1) * frameWidth / 2, y: (1 - point.y) * frameHeight / 2 }
    })
    // A cold cache follows input with the existing face pixels; preparing
    // WebGL frames on a touchmove would stall the capsule's own movement.
    canvas.style.transformOrigin = '0 0'
    canvas.style.transform = cdQuadToQuadTransform(project(camera), project(carouselCamera))
    presentSoftwarePose({ disc: discOverlayGeometry(carouselCamera), controls: softwareControlGeometry(carouselCamera) })
  }
  function updateControls(now = performance.now()) {
    if (controlMotions.size) transportDirty = true
    for (const [key, motion] of controlMotions) {
      const at = Math.max(now, motion.updatedAt ?? motion.startedAt)
      motion.updatedAt = at
      const progress = clamp((at - motion.startedAt) / motion.duration, 0, 1)
      motion.apply(motion.from + (motion.to - motion.from) * (1 - Math.pow(1 - progress, 3)))
      if (progress === 1) controlMotions.delete(key)
    }
  }
  function moveControl(key, from, to, duration, apply, fullScene = true) {
    transportDirty = true
    controlMotions.delete(key)
    if (!canAnimateControls()) { apply(to); return }
    controlMotions.set(key, { from, to, duration, apply, fullScene, startedAt: performance.now() })
    apply(from)
  }
  function finishControls() {
    transportDirty = true
    for (const motion of controlMotions.values()) motion.apply(motion.to)
    controlMotions.clear()
    for (const button of Object.values(buttons)) button.group.position.copy(button.restPosition)
    renderer.shadowMap.needsUpdate = true
    stopReaction()
  }
  function controlsMoveScene() {
    for (const motion of controlMotions.values()) if (motion.fullScene) return true
    return false
  }
  function transitionCanvas(key, surface, map, paint, animated) {
    transportDirty = true
    const ctx = surface.getContext('2d')
    if (!animated || !canAnimateControls()) {
      controlMotions.delete(key)
      paint(ctx)
      map.needsUpdate = true
      return
    }
    // Snapshot the current blended frame so rapid toggles never flash or
    // restart from an obsolete icon.
    const before = makeCanvas(surface.width, surface.height)
    before.getContext('2d').drawImage(surface, 0, 0)
    const after = makeCanvas(surface.width, surface.height, paint)
    moveControl(key, 0, 1, 180, (mix) => {
      ctx.clearRect(0, 0, surface.width, surface.height)
      ctx.globalAlpha = 1 - mix
      ctx.drawImage(before, 0, 0)
      ctx.globalAlpha = mix
      ctx.drawImage(after, 0, 0)
      ctx.globalAlpha = 1
      map.needsUpdate = true
    })
  }
  function resolveLid(closed) {
    for (const resolve of lidWaiters) resolve(closed)
    lidWaiters.clear()
  }
  function snapLid() {
    lidPivot.rotation.x = lidTarget
    lidMotion = null
    renderer.shadowMap.needsUpdate = true
    glassDirty = true
    lightingDirty = true
    resolveLid(lidTarget === 0)
  }
  function updateLid(now = performance.now()) {
    if (!lidMotion) return
    const at = Math.max(now, lidMotion.updatedAt ?? lidMotion.startedAt)
    lidMotion.updatedAt = at
    const t = clamp((at - lidMotion.startedAt) / LID_DURATION_MS, 0, 1)
    const eased = 1 - Math.pow(1 - t, 3)
    lidPivot.rotation.x = lidMotion.from + (lidMotion.to - lidMotion.from) * eased
    renderer.shadowMap.needsUpdate = true
    glassDirty = true
    lightingDirty = true
    if (t === 1) snapLid()
  }
  function moveLid(angle, immediate = false) {
    const settling = immediate || powerSave || reduced.matches || !canRender()
    if (lidTarget === angle && (!lidMotion || !settling)) return
    updateLid()
    lidTarget = angle
    if (settling) snapLid()
    else if (Math.abs(lidPivot.rotation.x - angle) < 0.001) snapLid()
    else if (lidMotion?.to !== angle) lidMotion = { from: lidPivot.rotation.x, to: angle, startedAt: performance.now() }
    invalidate()
  }
  function positionCamera(output = camera, pose = reaction, focus = seekFocus.value, applyFraming = true) {
    if (output === camera) { glassDirty = true; lightingDirty = true }
    // Fit the mobile deck and its floor shadow by adjusting distance while
    // keeping the same lens and resting angle as desktop.
    const mobileFramingScale = 1.02
    const baseRadius = presentation === 'setup'
      ? 0.78 + Math.max(2.82, 2.62 / output.aspect) / Math.tan(output.fov * Math.PI / 360)
      : mobile
      ? 0.78 + mobileFramingScale * Math.max(2.88, 2.64 / output.aspect) / Math.tan(output.fov * Math.PI / 360)
      : Math.max(11.1, 12.2 / output.aspect)
    const radius = baseRadius / ((1 + clamp(pose.zoom, -0.12, 0.16)) * (1 + focus * 0.12))
    const viewTheta = view.theta + pose.theta
    const theta = Math.atan2(Math.sin(viewTheta), Math.cos(viewTheta)) * (1 - focus)
    const phi = Math.PI / 2 + (clamp(view.phi + pose.phi, 0.22, 2.65) - Math.PI / 2) * (1 - focus)
    output.position.set(
      radius * Math.sin(phi) * Math.sin(theta),
      target.y + radius * Math.cos(phi),
      radius * Math.sin(phi) * Math.cos(theta),
    )
    output.up.set(Math.sin(pose.roll * (1 - focus)), Math.cos(pose.roll * (1 - focus)), 0)
    output.lookAt(target.x, target.y - pose.lift * (1 - focus), target.z)
    output.updateMatrixWorld()
    if (mobile && applyFraming) {
      // Anchor the resting view; preserve the desktop trajectory during
      // track skips and button reactions instead of recentering every pose.
      framingCamera.copy(output)
      positionCamera(framingCamera, framingPose, focus, false)
      const bounds = centerCdCamera(reactionCorners, output, frameWidth, frameHeight, framingCamera)
      if (output === camera && !focus && bounds) onFramingChange?.(bounds)
    }
  }
  function snapView() {
    viewMotion = null
    Object.assign(view, initialView)
    positionCamera()
    releaseViewAlignment()
  }
  function springStep(value, velocity, targetValue, elapsed, omega = VIEW_SPRING_OMEGA) {
    const offset = value - targetValue
    const coefficient = velocity + omega * offset
    const decay = Math.exp(-omega * elapsed)
    return {
      value: targetValue + (offset + coefficient * elapsed) * decay,
      velocity: (velocity - omega * coefficient * elapsed) * decay,
    }
  }
  function updateSeekFocus(now = performance.now()) {
    if (!seekFocusMotion) return
    const elapsed = Math.max(0, now - seekFocusMotion.updatedAt) / 1000
    seekFocusMotion.updatedAt = now
    const next = springStep(seekFocus.value, seekFocus.velocity, seekFocusMotion.target, elapsed, 28)
    seekFocus.value = next.value
    seekFocus.velocity = next.velocity
    if (Math.abs(next.value - seekFocusMotion.target) < 0.001 && Math.abs(next.velocity) < 0.01) {
      seekFocus.value = seekFocusMotion.target
      seekFocus.velocity = 0
      seekFocusMotion = null
    }
    positionCamera()
  }
  function focusForSeek(focused, immediate = false) {
    softwareFrames?.suspend()
    updateSeekFocus()
    const target = focused ? 1 : 0
    if (immediate || powerSave || reduced.matches || !canRender()) {
      seekFocus.value = target
      seekFocus.velocity = 0
      seekFocusMotion = null
      positionCamera()
    } else seekFocusMotion = { target, updatedAt: performance.now() }
    if (focused) {
      // Read gestures against the final frontal camera throughout the approach.
      // Camera movement alone must never scrub a stationary pointer.
      seekGestureCamera = camera.clone()
      positionCamera(seekGestureCamera, reaction, 1)
    } else seekGestureCamera = null
    invalidate()
  }
  function updateViewMotion(now = performance.now()) {
    if (!viewMotion) return
    const at = Math.max(now, viewMotion.updatedAt)
    const elapsed = clamp((at - viewMotion.updatedAt) / 1000, 0, 0.05)
    viewMotion.updatedAt = at
    const theta = springStep(view.theta, viewMotion.thetaVelocity, viewMotion.theta, elapsed)
    const phi = springStep(view.phi, viewMotion.phiVelocity, viewMotion.phi, elapsed)
    view.theta = theta.value
    view.phi = phi.value
    viewMotion.thetaVelocity = theta.velocity
    viewMotion.phiVelocity = phi.velocity
    const settled = Math.abs(view.theta - viewMotion.theta) < 0.0005 &&
      Math.abs(view.phi - viewMotion.phi) < 0.0005 &&
      Math.abs(theta.velocity) < 0.005 && Math.abs(phi.velocity) < 0.005
    if (settled) {
      view.theta = viewMotion.theta
      view.phi = viewMotion.phi
      viewMotion = null
    }
    positionCamera()
    releaseViewAlignment()
  }
  function resetView() {
    if (softwareRendering && !mobile) return
    softwareFrames?.suspend()
    if (reactionMotion) stopReaction()
    if (powerSave || reduced.matches || !canRender()) {
      snapView()
      invalidate()
      return
    }
    const now = performance.now()
    updateViewMotion(now)
    const closestTheta = initialView.theta + Math.round((view.theta - initialView.theta) / TAU) * TAU
    viewMotion = {
      theta: closestTheta,
      phi: initialView.phi,
      thetaVelocity: viewMotion?.thetaVelocity || 0,
      phiVelocity: viewMotion?.phiVelocity || 0,
      updatedAt: now,
    }
    invalidate()
  }
  function cancelRender() {
    cancelAnimationFrame(frame)
    clearTimeout(animationTimer)
    frame = animationTimer = 0
  }
  function invalidate(immediate = true, fullScene = immediate) {
    if (initializing || disposed) return
    spin.setEnabled(canRender() && !powerSave && !reduced.matches)
    syncPlaybackMotion()
    if (fullScene) needsFullRender = true
    if (immediate) immediateFrame = true
    if (immediate) { clearTimeout(animationTimer); animationTimer = 0 }
    if (frame || animationTimer || !canRender()) return
    // Hardware frames follow vsync; render() caps actual playback draws.
    // A timer followed by rAF can miss the intended refresh and produce an
    // alternating short/long frame cadence even when the GPU is idle.
    if (seekFocusMotion || viewMotion || !cachedRendering || !softwareRendering && (reactionMotion || performance.now() - lastViewChangeAt < 80)) {
      frame = requestAnimationFrame(render)
      return
    }
    // Software rendering still sleeps between its infrequent updates.
    const fps = immediate || lidMotion ? SOFTWARE_INTERACTION_FPS : SOFTWARE_PLAYBACK_FPS
    const delay = Math.max(0, 1000 / fps - (performance.now() - lastRenderAt))
    if (delay > 0) {
      animationTimer = setTimeout(() => {
        animationTimer = 0
        if (canRender()) frame = requestAnimationFrame(render)
      }, delay)
    } else frame = requestAnimationFrame(render)
  }
  function updateDiscScissor() {
    renderSize.set(frameWidth, frameHeight)
    artwork.updateWorldMatrix(true, false)
    let left = renderSize.x
    let bottom = renderSize.y
    let right = 0
    let top = 0
    for (const x of [-DISC_ARTWORK_RADIUS, DISC_ARTWORK_RADIUS]) for (const y of [-DISC_ARTWORK_RADIUS, DISC_ARTWORK_RADIUS]) {
      discCorner.set(x, y, 0).applyMatrix4(artwork.matrixWorld).project(camera)
      const px = (discCorner.x + 1) * renderSize.x / 2
      const py = (discCorner.y + 1) * renderSize.y / 2
      left = Math.min(left, px)
      right = Math.max(right, px)
      bottom = Math.min(bottom, py)
      top = Math.max(top, py)
    }
    left = clamp(Math.floor(left) - 2, 0, renderSize.x)
    bottom = clamp(Math.floor(bottom) - 2, 0, renderSize.y)
    right = clamp(Math.ceil(right) + 2, 0, renderSize.x)
    top = clamp(Math.ceil(top) + 2, 0, renderSize.y)
    discScissor = right > left && top > bottom
      ? { x: left, y: bottom, width: right - left, height: top - bottom }
      : null
  }
  function renderDisc(angle) {
    // Geometry and reflections stay fixed relative to the light. Rotating UVs
    // preserves cached depth under the spindle on every frame.
    artworkMaterial.map.rotation = -angle
    const layers = camera.layers.mask
    artworkMaterial.stencilWrite = true
    for (const surface of discOverlays) surface.stencilWrite = true
    renderer.autoClear = false
    renderer.setScissor(discScissor.x, discScissor.y, discScissor.width, discScissor.height)
    renderer.setScissorTest(true)
    glassOverlay.visible = !glassDirty && Boolean(glassCache)
    if (!lightingDirty && whiteLighting && blackLighting && visiblePrint) {
      artworkMaterial.map.updateMatrix()
      playbackArtwork.uniforms.artworkMap.value = artworkMaterial.map
      playbackArtwork.uniforms.artworkTransform.value = artworkMaterial.map.matrix
      artwork.material = playbackArtwork
    }
    try {
      renderer.clear(false, false, true)
      camera.layers.set(DISC_PLAYBACK_LAYER)
      if (!glassOverlay.visible) camera.layers.enable(GLASS_CACHE_LAYER)
      renderer.render(scene, camera)
    } finally {
      camera.layers.mask = layers
      renderer.autoClear = true
      renderer.setScissorTest(false)
      glassOverlay.visible = false
      artwork.material = artworkMaterial
      artworkMaterial.stencilWrite = false
      for (const surface of discOverlays) surface.stencilWrite = false
    }
  }
  function cacheDiscVisibility() {
    // Full MSAA rendering determines which printed pixels are visible under
    // the case and spindle. Preserve that coverage instead of comparing a
    // second shader's depth against nearly coplanar foil at steep angles.
    const region = pixelRegion(discScissor)
    if (region.width < 1 || region.height < 1) return
    if (visiblePrint?.image.width !== region.width || visiblePrint?.image.height !== region.height) {
      if (visiblePrint) { resources.delete(visiblePrint); visiblePrint.dispose() }
      visiblePrint = own(new FramebufferTexture(region.width, region.height))
      playbackArtwork.uniforms.visiblePrint.value = visiblePrint
    }
    renderer.autoClear = false
    renderer.setScissor(discScissor.x, discScissor.y, discScissor.width, discScissor.height)
    renderer.setScissorTest(true)
    try {
      renderer.clear(true, false, false)
      renderer.render(visibilityScene, presentationCamera)
      glassOrigin.set(region.x, region.y)
      renderer.copyFramebufferToTexture(visiblePrint, glassOrigin)
      copyStaticFrame()
    } finally {
      renderer.autoClear = true
      renderer.setScissorTest(false)
    }
  }
  function cacheDiscLighting() {
    // UV rotation does not move the coated surface, lights or reflections.
    // Cache its black/mid/white responses in linear color, including the slight
    // curvature from metal reflections. Playback only
    // samples the sharp print and applies the fixed illumination and highlights.
    const region = pixelRegion(discScissor)
    if (region.width < 1 || region.height < 1) return
    if (whiteLighting?.width !== region.width || whiteLighting?.height !== region.height) {
      for (const target of [whiteLighting, blackLighting, midLighting]) {
        if (target) { resources.delete(target); target.dispose() }
      }
      const options = { type: HalfFloatType, depthBuffer: false }
      whiteLighting = own(new WebGLRenderTarget(region.width, region.height, options))
      blackLighting = own(new WebGLRenderTarget(region.width, region.height, options))
      midLighting = own(new WebGLRenderTarget(region.width, region.height, options))
      playbackArtwork.uniforms.whiteLight.value = whiteLighting.texture
      playbackArtwork.uniforms.blackLight.value = blackLighting.texture
      playbackArtwork.uniforms.midLight.value = midLighting.texture
    }
    lightingCamera.copy(camera)
    // Shift the viewport into the small target without changing projection.
    // Shadow samples then share the exact raster positions of the full frame.
    for (const target of [whiteLighting, blackLighting, midLighting]) {
      target.viewport.set(-region.x, -region.y, framePixelWidth, framePixelHeight)
    }
    shadowPixelOffset.set(region.x, region.y)
    lightingCamera.layers.set(DISC_PLAYBACK_LAYER)
    playbackArtwork.uniforms.lightingRegion.value.set(region.x, region.y, region.width, region.height)
    artwork.material = lightingMaterial
    renderer.setScissorTest(false)
    try {
      lightingMaterial.color.copy(artworkMaterial.color)
      renderer.setRenderTarget(whiteLighting)
      renderer.render(scene, lightingCamera)
      lightingMaterial.color.multiplyScalar(0.5)
      renderer.setRenderTarget(midLighting)
      renderer.render(scene, lightingCamera)
      lightingMaterial.color.setRGB(0, 0, 0)
      renderer.setRenderTarget(blackLighting)
      renderer.render(scene, lightingCamera)
      lightingDirty = false
    } finally {
      artwork.material = artworkMaterial
      renderer.setRenderTarget(playbackFrame)
    }
  }
  function cacheGlass() {
    // Glass is independent of the rotating print. Capture its
    // premultiplied colors against the current depth, then restore the patch.
    const region = pixelRegion(discScissor)
    const { width, height } = region
    if (width < 1 || height < 1) return
    if (!glassCache || glassCache.image.width !== width || glassCache.image.height !== height) {
      if (glassCache) { resources.delete(glassCache); glassCache.dispose() }
      glassCache = own(new FramebufferTexture(width, height))
      glassSurface.uniforms.overlayMap.value = glassCache
    }
    glassOrigin.set(region.x, region.y)
    glassSurface.uniforms.overlayRegion.value.set(glassOrigin.x, glassOrigin.y, width, height)
    const layers = camera.layers.mask
    renderer.setScissor(discScissor.x, discScissor.y, discScissor.width, discScissor.height)
    renderer.setScissorTest(true)
    renderer.autoClear = false
    try {
      renderer.clear(true, false, false)
      camera.layers.set(GLASS_CACHE_LAYER)
      renderer.render(scene, camera)
      renderer.copyFramebufferToTexture(glassCache, glassOrigin)
      camera.layers.mask = layers
      renderer.autoClear = true
      renderer.setRenderTarget(staticFrame)
      renderer.setScissor(discScissor.x, discScissor.y, discScissor.width, discScissor.height)
      renderer.setScissorTest(true)
      renderer.render(scene, camera)
      // Restore only the glass patch. The rest of the playback frame may
      // already contain a newer timer than the last full chassis render.
      copyStaticFrame(region)
      renderer.setRenderTarget(playbackFrame)
      glassDirty = false
    } finally {
      camera.layers.mask = layers
      renderer.autoClear = true
      renderer.setScissorTest(false)
    }
  }
  function captureRestingPose() {
    // Covers can be repainted independently. Everything else
    // must match before restoring the cached chassis after a physical turn.
    return [
      ...camera.matrixWorld.elements, ...camera.projectionMatrix.elements,
      lidPivot.rotation.x, volumeMarker.rotation.z, ridges.rotation.z,
      appearanceKey, renderer.shadowMap.enabled, shadowVersion, Boolean(artworkMaterial.map),
      ...Object.values(buttons).flatMap(button => [
        ...button.group.position.toArray(), button.icon.position.x, button.icon.scale.x,
        button.kind, button.selected,
      ]),
    ]
  }
  function canUseSoftwareFrames() {
    const thetaOffset = view.theta - initialView.theta
    return !initialPlayback && !seekFocus.value && !seekFocusMotion && !lidMotion && !viewMotion && !reactionMotion &&
      Math.abs(Math.atan2(Math.sin(thetaOffset), Math.cos(thetaOffset))) < 1e-7 &&
      Math.abs(view.phi - initialView.phi) < 1e-7
  }
  // When a seek falls back to the frontal camera focus (the chassis volume is
  // not on screen yet), the scene is already rendered live. Show its textured
  // record instead of stacking the flat 2D overlay on top of the real spindle,
  // foil and lid glass. Software rendering keeps the cheap overlay.
  function isLiveDiscFocused() {
    return cachedRendering && !softwareRendering && presentation !== 'setup' && !mobile &&
      Boolean(artworkMaterial.map) && (seekFocus.value > 0.001 || Boolean(seekFocusMotion))
  }
  function syncPlaybackMotion() {
    if (playbackElement && cachedRendering && presentation !== 'setup') {
      let volumeMapping = null
      const status = softwareFrames?.status()
      const cropped = frameWidth > 0 && canUseSoftwareFrames() && (!carouselActive || volumeCarouselActive) &&
        !softwareFrames?.camera && !status?.playing && !status?.pending
      if (cropped) {
        volumeMapping = playbackVolume ? cdCssCameraMatrix(camera, target, frameWidth, frameHeight, staticCanvas.offsetLeft) : null
        const bounds = cdMotionRegion(reactionCorners, camera, frameWidth, frameHeight, 12)
        const top = frameHeight - bounds.y - bounds.height
        const left = staticCanvas.offsetLeft + bounds.x
        const properties = {
          '--cd-crop-x': left, '--cd-crop-y': top,
          '--cd-crop-width': bounds.width, '--cd-crop-height': bounds.height,
          '--cd-stage-width': stageElement.clientWidth, '--cd-stage-height': stageElement.clientHeight,
          '--cd-motion-origin-x': volumeMapping?.centerX ?? left + bounds.width / 2,
          '--cd-motion-origin-y': volumeMapping?.centerY ?? top + bounds.height / 2,
          '--cd-camera-lens': volumeMapping?.lens ?? 1100,
        }
        for (const [property, value] of Object.entries(properties)) {
          const pixels = `${value}px`
          if (playbackElement.style.getPropertyValue(property) !== pixels) playbackElement.style.setProperty(property, pixels)
          if (gpuProjectionNode) gpuProjectionNode.style.setProperty(property, pixels)
        }
      }
      // Clip only the resting chassis. Keep the same pivot when a gesture or
      // a prepared skip needs the full scene, so pausing cannot move the body.
      playbackElement.classList.toggle('has-crop', cropped)
      if (playbackVolume) {
        const wasVisible = playbackVolume.visible
        if (cropped) {
          playbackVolume.setView(volumeMapping.viewMatrix, volumeMapping.scale)
          playbackVolume.refresh(`${volumeCaptureVersion}|${appearanceKey}|${renderer.shadowMap.enabled}`)
        }
        const visible = playbackVolume.setVisible(cropped && canRender())
        playbackElement.classList.toggle('has-volume', visible)
        if (visible) staticCanvas.style.visibility = 'hidden'
        else if (cropped && canRender()) staticCanvas.style.visibility = ''
        if (visible !== wasVisible) {
          updateDiscOverlay(true)
          if (visible) presentSoftwareControls(softwareControlGeometry())
          else if (!softwareFrames?.camera && !carouselCamera) hideSoftwareControls()
        }
      }
    }
    playbackMotion?.sync()
    if (gpuVolume) {
      // The camera/volume mapping changes here, not on every playback tick.
      // Keep projection work and DOM layout reads off the GPU refresh clock.
      gpuDiscTransform = discOverlayGeometry(camera)?.transform
      gpuVolume.refresh()
      const motion = playbackMotion?.status()
      const showGpu = playbackVolume?.visible && canRender() && !discExchangeSliding && !discSwipeActive &&
        !discExchangeSettling
      // The visible CSS shell must inherit the same paused animation as the
      // GPU projection. Leaving it on the hidden marker snaps the body flat.
      projectionElement = showGpu ? gpuProjectionNode : playbackElement
      playbackMotion?.setElement(projectionElement)
      const audioReady = state.audibleTrackId === state.currentTrack?.id || state.currentTime > 0
      gpuVolume.sync(showGpu, Boolean(motion?.running || motion?.skipping || motion?.aligning || motion?.seating || motion?.carousel || audioReady && spin.isAnimating()))
    }
  }
  function softwareFrameKey() {
    return [
      mobile ? 'machined-graphite-mobile-v28' : 'machined-graphite-v30', camera.fov, camera.position.distanceTo(target).toFixed(6),
      initialView.theta, initialView.phi, 0, 0,
      lidPivot.rotation.x, appearanceKey, renderer.shadowMap.enabled,
    ].join('|')
  }
  function render(frameAt = performance.now()) {
    frame = 0
    if (!canRender()) return
    const immediate = immediateFrame || needsFullRender
    const movingBeforeFrame = Boolean(seekFocusMotion || lidMotion || viewMotion || reactionMotion || controlsMoveScene())
    // A moving chassis uses every vsync, including on low-core devices.
    // Resting disc playback retains its existing frame budget.
    if (!cachedRendering && !frameCadence.shouldRender(frameAt, constrainedDevice ? 24 : PLAYBACK_FPS, immediate, movingBeforeFrame)) {
      invalidate(false, false)
      return
    }
    immediateFrame = false
    lastRenderAt = performance.now()
    if (renderer.shadowMap.needsUpdate) { glassDirty = true; lightingDirty = true }
    // Pose samples use the display clock, independent of how late other
    // callbacks/main-thread work let this rAF callback start.
    updateLid(frameAt)
    updateViewMotion(frameAt)
    updateReaction(frameAt)
    updateSeekFocus(frameAt)
    updateControls(frameAt)
    const moving = Boolean(seekFocusMotion || lidMotion || viewMotion || reactionMotion || controlsMoveScene())
    let restored = false
    if (!cachedRendering && liveFramePresented && !moving && !needsFullRender &&
      !renderer.shadowMap.needsUpdate && restingPose) {
      const pose = captureRestingPose()
      restored = pose.length === restingPose.length && pose.every((value, index) => value === restingPose[index])
      if (restored) {
        lightingDirty = !restingLightingReady
        glassDirty = !restingGlassReady
      }
    }
    const value = spin.angle()
    const liveDisc = isLiveDiscFocused()
    if (cachedRendering && artwork.visible !== liveDisc) artwork.visible = liveDisc
    playbackElement?.classList.toggle('is-live-disc', liveDisc)
    const partialFrame = !cachedRendering && (!liveFramePresented || restored) && !needsFullRender && !moving && !renderer.shadowMap.needsUpdate && discScissor && artworkMaterial.map
    const discChanged = restored || !partialFrame || artworkMaterial.map !== renderedDiscMap || value !== renderedDiscAngle || lightingDirty || glassDirty
    if (partialFrame) {
      renderer.setRenderTarget(playbackFrame)
      if (lightingDirty && lastRenderAt - lastViewChangeAt > 100) cacheDiscLighting()
      if (glassDirty && lastRenderAt - lastViewChangeAt > 100) {
        artworkMaterial.map.rotation = -value
        cacheGlass()
      } else if (discChanged) renderDisc(value)
    } else {
      updateTransportBatches()
      if (!cachedRendering) {
        if (artworkMaterial.map) artworkMaterial.map.rotation = -value
        artworkMaterial.stencilWrite = true
      } else if (liveDisc && artworkMaterial.map) {
        // The resting cache keeps the print still; the focused live frame must
        // turn it exactly like the prepared disc overlay does at rest.
        artworkMaterial.map.rotation = -value
      }
      if (renderer.shadowMap.needsUpdate) shadowVersion++
      if (!cachedRendering && moving) renderMotionFrame()
      else {
        if (!cachedRendering) renderer.setRenderTarget(staticFrame)
        renderer.render(scene, camera)
      }
      if (cachedRendering) {
        if (canUseSoftwareFrames()) {
          // Resolve MSAA and supersampling once. Moving a visible WebGL canvas
          // forces expensive presentation even without another scene render.
          staticContext.clearRect(0, 0, staticCanvas.width, staticCanvas.height)
          staticContext.imageSmoothingQuality = 'high'
          staticContext.drawImage(canvas, 0, 0, staticCanvas.width, staticCanvas.height)
          canvas.style.display = 'none'
          if (!softwareFrames?.camera && !carouselCamera) staticCanvas.style.visibility = ''
        } else {
          staticCanvas.style.visibility = 'hidden'
          canvas.style.display = 'block'
        }
        // Control patches are only shown over a prepared turn. Copying the
        // WebGL canvas during orbit stalls each visible front-facing frame.
        if (canUseSoftwareFrames()) updateSoftwareControls()
        else hideSoftwareControls()
        if (!liveDisc && !softwareFrames?.camera && !carouselCamera) updateDiscOverlay()
        // Preserve the prepared default view throughout manual motion. A
        // transient camera zoom must not invalidate and rebuild all poses.
        if (canUseSoftwareFrames()) softwareFrames?.warm(softwareFrameKey())
      }
      if (!cachedRendering) {
        artworkMaterial.stencilWrite = false
        if (!moving) {
          copyStaticFrame()
          renderer.setRenderTarget(playbackFrame)
        }
      }
      needsFullRender = false
      if (!cachedRendering && !moving) {
        updateDiscScissor()
        if (artworkMaterial.map && discScissor) cacheDiscVisibility()
        if (lightingDirty && artworkMaterial.map && discScissor && !lidMotion && !viewMotion && !reactionMotion && lastRenderAt - lastViewChangeAt > 100) cacheDiscLighting()
        if (glassDirty && discScissor && !lidMotion && !viewMotion && !reactionMotion && lastRenderAt - lastViewChangeAt > 100) cacheGlass()
        restingPose = captureRestingPose()
      }
    }
    if (!cachedRendering && !moving) {
      restingLightingReady = !lightingDirty
      restingGlassReady = !glassDirty
    }
    if (discChanged) { renderedDiscMap = artworkMaterial.map; renderedDiscAngle = value }
    if (!cachedRendering) presentFrame(!partialFrame, discChanged, moving)
    syncPlaybackMotion()
    if (seekFocusMotion || lidMotion || viewMotion || reactionMotion || controlMotions.size || (!cachedRendering && artworkMaterial.map && spin.isAnimating())) invalidate(false, false)
  }
  function discOverlayGeometry(poseCamera = camera) {
    // Hardware playback presents the chassis on the full-size 2D cache;
    // the WebGL canvas may be hidden or cropped down to a disc tile.
    const surface = staticCanvas || canvas
    // The touch target shares the compositor transform with the chassis.
    // Use layout dimensions so an action's scale is not applied twice.
    const width = surface.clientWidth
    const height = surface.clientHeight
    if (width < 1 || height < 1) return
    disc.updateWorldMatrix(true, false)
    poseCamera.updateMatrixWorld(true)
    const center = disc.localToWorld(new Vector3(0, 0.02, 0))
    const normal = new Vector3(0, 1, 0).transformDirection(disc.matrixWorld)
    const facing = normal.dot(poseCamera.position.clone().sub(center)) > 0
    const radius = DISC_ARTWORK_RADIUS
    const worldPoints = [
      [-radius, -radius], [radius, -radius],
      [radius, radius], [-radius, radius],
    ].map(([x, z]) => {
      const point = new Vector3(x, 0.02, z)
      disc.localToWorld(point)
      return point
    })
    const points = worldPoints.map(point => {
      const projected = point.clone().project(poseCamera)
      return { x: surface.offsetLeft + (projected.x + 1) * width / 2, y: (1 - projected.y) * height / 2 }
    })
    const transform = playbackVolume?.visible && poseCamera === camera
      ? cdCssMatrixTransform(cdCssPlaneMatrix(playbackVolume.matrix, worldPoints.map(point => point.clone().setZ(PLAYBACK_SURFACE_Z)), 512, 512)) : undefined
    return { quad: points, transform, hubRadiusRatio: DISC_HUB_RADIUS / DISC_ARTWORK_RADIUS, facing }
  }
  function updateDiscOverlay(immediate = false) {
    if (!onDiscOverlayChange) return
    const geometry = discOverlayGeometry(carouselCamera || softwareFrames?.camera || camera)
    // A hidden canvas has no layout dimensions. Keep the last valid pose
    // until a visible render can project it again after activation/resize.
    if (geometry) onDiscOverlayChange(geometry, immediate || Boolean(softwareFrames?.camera))
  }
  function softwareControlGeometry(poseCamera = camera) {
    return softwareControls.map(({ object, radius, depth }) => {
      object.updateWorldMatrix(true, false)
      const center = object.getWorldPosition(new Vector3())
      const normal = new Vector3(0, 0, 1).transformDirection(object.matrixWorld)
      const worldPoints = [[-radius, radius], [radius, radius], [radius, -radius], [-radius, -radius]]
        .map(([x, y]) => object.localToWorld(new Vector3(x, y, depth)))
      return {
        facing: normal.dot(poseCamera.position.clone().sub(center)) > 0,
        transform: playbackVolume?.visible && poseCamera === camera
          ? cdCssMatrixTransform(cdCssPlaneMatrix(playbackVolume.matrix, worldPoints.map(point => point.clone().setZ(PLAYBACK_SURFACE_Z)), 1, 1)) : undefined,
        quad: worldPoints.map(worldPoint => {
          const point = worldPoint.clone().project(poseCamera)
          return { x: (point.x + 1) * frameWidth / 2, y: (1 - point.y) * frameHeight / 2 }
        }),
      }
    })
  }
  function presentSoftwareControls(geometry) {
    softwareControls.forEach((item, index) => {
      const pose = geometry[index]
      if (!item.sourceInverse || !pose.facing) { item.patch.style.display = 'none'; return }
      const target = new DOMMatrix(pose.transform || squareToQuadTransform(pose.quad, 1, 1))
      item.patch.style.left = playbackVolume?.visible ? '0' : canvas.style.marginLeft
      item.patch.style.transform = target.multiply(item.sourceInverse).toString()
      item.patch.style.display = active ? 'block' : 'none'
    })
  }
  function hideSoftwareControls() {
    for (const { patch } of softwareControls) patch.style.display = 'none'
  }
  function updateSoftwareControls() {
    const ratio = canvas.width / frameWidth
    softwareControlGeometry().forEach((pose, index) => {
      const item = softwareControls[index]
      const left = Math.max(0, Math.floor(Math.min(...pose.quad.map(point => point.x)) * ratio))
      const top = Math.max(0, Math.floor(Math.min(...pose.quad.map(point => point.y)) * ratio))
      const right = Math.min(canvas.width, Math.ceil(Math.max(...pose.quad.map(point => point.x)) * ratio))
      const bottom = Math.min(canvas.height, Math.ceil(Math.max(...pose.quad.map(point => point.y)) * ratio))
      if (!pose.facing || right <= left || bottom <= top) { item.sourceInverse = null; return }
      item.patch.width = right - left
      item.patch.height = bottom - top
      item.patch.getContext('2d').drawImage(canvas, left, top, right - left, bottom - top, 0, 0, right - left, bottom - top)
      item.patch.dataset.cdTextureVersion = String(Number(item.patch.dataset.cdTextureVersion || 0) + 1)
      const sourceQuad = pose.quad.map(point => ({ x: point.x * ratio - left, y: point.y * ratio - top }))
      item.patch.style.clipPath = `polygon(${sourceQuad.map(point => `${point.x}px ${point.y}px`).join(',')})`
      item.sourceInverse = new DOMMatrix(squareToQuadTransform(sourceQuad, 1, 1)).inverse()
    })
    if (playbackVolume?.visible || carouselCamera || softwareFrames?.camera) presentSoftwareControls(softwareControlGeometry(carouselCamera || softwareFrames?.camera || camera))
    else hideSoftwareControls()
  }
  function updateCamera() {
    positionCamera()
    // Cached artwork is projected after the matching chassis frame. Pointer
    // events can arrive faster than rendering and must not move it ahead.
    if (!cachedRendering) updateDiscOverlay()
    invalidate()
  }
  let resizeKey = ''
  function resize() {
    // Layout dimensions do not shrink during the entrance transform. Using
    // its animated bounds would leave the canvas permanently undersized.
    const size = measureCanvas(powerSave)
    if (!size || resizeKey === size.key) return
    const { stageWidth, width, height, pixelRatio } = size
    resizeKey = size.key
    canvas.style.width = `${width}px`
    canvas.style.marginLeft = `${(stageWidth - width) / 2}px`
    for (const { patch } of softwareControls) patch.style.left = canvas.style.marginLeft
    applyCdDrawingBufferSize(renderer, size)
    frameWidth = width
    frameHeight = height
    framePixelWidth = canvas.width
    framePixelHeight = canvas.height
    if (staticCanvas) {
      const staticRatio = cachedRendering ? Math.min(window.devicePixelRatio || 1, pixelRatio) : pixelRatio
      staticCanvas.width = Math.round(width * staticRatio)
      staticCanvas.height = Math.round(height * staticRatio)
      Object.assign(staticCanvas.style, { width: `${width}px`, height: `${height}px`, marginLeft: canvas.style.marginLeft })
      Object.assign(canvas.style, { left: '0', top: '0', height: `${height}px`, display: 'none' })
      discCutout = false
    }
    resizeFrameCache()
    camera.aspect = stageWidth / height
    camera.setViewOffset(stageWidth, height, (stageWidth - width) / 2, 0, width, height)
    camera.updateProjectionMatrix()
    updateCamera()
  }
  const observer = new ResizeObserver(resize)
  load.onCleanup(() => observer.disconnect())
  const intersection = new IntersectionObserver(([entry]) => {
    inViewport = entry.isIntersecting
    spin.setEnabled(canRender() && !powerSave && !reduced.matches)
    if (inViewport) invalidate()
    else { softwareFrames?.suspend(); finishControls(); snapLid(); if (viewMotion) snapView(); cancelRender() }
    syncPlaybackMotion()
  })
  load.onCleanup(() => intersection.disconnect())
  intersection.observe(staticCanvas || canvas)
  const onVisibility = () => {
    spin.setEnabled(canRender() && !powerSave && !reduced.matches)
    if (document.hidden) { softwareFrames?.suspend(); finishControls(); snapLid(); if (viewMotion) snapView(); cancelRender() }
    else invalidate()
    syncPlaybackMotion()
  }
  const onContextLost = (event) => { event.preventDefault(); onError?.() }
  const onReducedMotion = () => {
    spin.setEnabled(canRender() && !powerSave && !reduced.matches)
    finishControls()
    if (reduced.matches) {
      if (seekFocusMotion) {
        seekFocus.value = seekFocusMotion.target
        seekFocus.velocity = 0
        seekFocusMotion = null
        positionCamera()
      }
    }
    snapLid()
    if (reduced.matches && viewMotion) snapView()
    cancelRender()
    invalidate()
    syncPlaybackMotion()
  }
  document.addEventListener('visibilitychange', onVisibility)
  reduced.addEventListener('change', onReducedMotion)
  canvas.addEventListener('webglcontextlost', onContextLost)
  load.onCleanup(() => {
    document.removeEventListener('visibilitychange', onVisibility)
    reduced.removeEventListener('change', onReducedMotion)
    canvas.removeEventListener('webglcontextlost', onContextLost)
    onDiscOverlayChange?.(null)
  })
  if (cachedRendering && presentation !== 'setup') {
    const restingButtons = Object.values(buttons).map(button => ({ button, position: new Vector3(), material: null, iconVisible: true }))
    let markerVisible, ridgeAngle, capturedDiscVisible
    const beforeCapture = () => {
      // Capture the actual tray behind the moving record, not its foil.
      capturedDiscVisible = disc.visible
      disc.visible = false
      for (const item of restingButtons) {
        item.position.copy(item.button.group.position)
        item.button.group.position.copy(item.button.restPosition)
        item.material = item.button.face.material
        item.iconVisible = item.button.icon.visible
        item.button.face.material = accentMetal
        item.button.icon.visible = false
      }
      markerVisible = volumeMarker.visible
      ridgeAngle = ridges.rotation.z
      volumeMarker.visible = false
      ridges.rotation.z = 0
    }
    const afterCapture = () => {
      disc.visible = capturedDiscVisible
      for (const item of restingButtons) {
        item.button.group.position.copy(item.position)
        item.button.face.material = item.material
        item.button.icon.visible = item.iconVisible
      }
      volumeMarker.visible = markerVisible
      ridges.rotation.z = ridgeAngle
    }
    const panelCorners = [new Vector3(-2.335, 0.635, PLAYBACK_SURFACE_Z), new Vector3(2.335, 0.635, PLAYBACK_SURFACE_Z),
      new Vector3(2.335, 0.13, PLAYBACK_SURFACE_Z), new Vector3(-2.335, 0.13, PLAYBACK_SURFACE_Z)]
    playbackVolume = createCdPlaybackVolume({
      parent: canvas.parentElement, renderer, scene,
      faces: [...cdPlaybackVolumeFaces([-2.46, DECK_STANDING_Y - 2.685, 0.01], [2.46, DECK_STANDING_Y + 2.685, PLAYBACK_SURFACE_Z], 0.18),
        { name: 'panel', corners: panelCorners }],
      enabled: () => canRender() && canUseSoftwareFrames(),
      beforeCapture, afterCapture,
      captureCamera: face => {
        if (face.name !== 'front' && face.name !== 'panel') return null
        // Use the resting lens for the front's material reflections. The
        // frontal plane projects to an axis-aligned crop without a warp.
        const points = face.corners.map(point => point.clone().project(camera))
        const xs = points.map(point => (point.x + 1) * frameWidth / 2)
        const ys = points.map(point => (1 - point.y) * frameHeight / 2)
        const left = Math.min(...xs), top = Math.min(...ys)
        const view = camera.view, captured = camera.clone()
        captured.setViewOffset(view?.fullWidth || frameWidth, view?.fullHeight || frameHeight,
          (view?.offsetX || 0) + left, (view?.offsetY || 0) + top,
          Math.max(...xs) - left, Math.max(...ys) - top)
        return captured
      },
      paintFace: (face, context, width, height) => {
        // Each face capture can see neighbouring parts beyond a rounded
        // corner. Remove those islands rather than projecting them as fins.
        if (face.name !== 'panel') {
          const sx = width / face.corners[0].distanceTo(face.corners[1])
          const sy = height / face.corners[0].distanceTo(face.corners[3])
          const radius = 0.18
          context.save()
          if (face.name === 'front' || face.name === 'back') {
            context.globalCompositeOperation = 'destination-in'
            context.beginPath(); context.roundRect(0, 0, width, height, radius * Math.min(sx, sy)); context.fill()
          } else {
            // Orthographic wall captures include stepped silhouettes of feet,
            // lid lips and neighbouring parts. They are not surface detail:
            // flattening them into a wall makes its seam break during turns.
            // Shade the actual perimeter continuously across its depth instead.
            const right = face.corners[1].clone().sub(face.corners[0])
            const down = face.corners[3].clone().sub(face.corners[0])
            const normal = down.cross(right).normalize()
            const light = 0.08 + Math.max(0, normal.y) * 0.07
            const gradient = context.createLinearGradient(0, 0, 0, height)
            const shade = amount => blackChrome.color.clone().multiplyScalar(Math.max(0.18, amount / 0.08)).getStyle()
            // Two continuous machined grooves follow the entire perimeter,
            // including corners. Broad, soft shoulders stay filtered when the
            // wall narrows during a turn; nothing changes along its length.
            const band = (depth, center, spread) => Math.exp(-0.5 * ((depth - center) / spread) ** 2)
            for (let step = 0; step <= 64; step++) {
              const depth = step / 64
              const base = light * (0.55 + 0.45 * Math.sin(depth * Math.PI))
              const grooves = -0.035 * (band(depth, 0.22, 0.035) + band(depth, 0.74, 0.035))
              const shoulders = 0.025 * (band(depth, 0.28, 0.04) + band(depth, 0.8, 0.04))
              gradient.addColorStop(depth, shade(Math.max(0, base + grooves + shoulders)))
            }
            context.globalCompositeOperation = 'copy'
            context.fillStyle = gradient
            context.fillRect(0, 0, width, height)
          }
          context.restore()
        }
        if (face.name !== 'front' && face.name !== 'panel') {
          return
        }
        const origin = face.corners[0]
        const sx = width / face.corners[0].distanceTo(face.corners[1])
        const sy = height / face.corners[0].distanceTo(face.corners[3])
        // Retain a subpixel underlap behind separately filtered live layers.
        const overlap = gpuVolume ? 0.75 : 0
        const polygon = points => {
          const cx = points.reduce((sum, point) => sum + (point.x - origin.x) * sx, 0) / points.length
          const cy = points.reduce((sum, point) => sum + (origin.y - point.y) * sy, 0) / points.length
          context.beginPath()
          points.forEach((point, index) => {
            let x = (point.x - origin.x) * sx, y = (origin.y - point.y) * sy
            x += Math.sign(cx - x) * overlap; y += Math.sign(cy - y) * overlap
            if (index) context.lineTo(x, y)
            else context.moveTo(x, y)
          })
          context.closePath(); context.fill()
        }
        context.save()
        context.globalCompositeOperation = 'destination-out'
        if (face.name === 'front') {
          // Keep the chassis opaque beneath the record during exchanges.
          if (!gpuVolume) polygon(panelCorners)
        } else {
          for (const { object, radius, depth } of softwareControls) {
            const center = object.localToWorld(new Vector3(0, 0, depth))
            context.beginPath()
            context.ellipse((center.x - origin.x) * sx, (origin.y - center.y) * sy, Math.max(0.01, radius * sx - overlap), Math.max(0.01, radius * sy - overlap), 0, 0, TAU)
            context.fill()
          }
        }
        context.restore()
      },
      onReady: () => { gpuVolume?.refresh(true); syncPlaybackMotion() },
    })
    playbackMotion = createCdPlaybackMotion({
      element: projectionElement,
      perspective: () => parseFloat(playbackElement?.style.getPropertyValue('--cd-camera-lens')) || 1100,
      // Bound native composition to 60 fps and share the live disc's update
      // boundaries. The hidden GPU projection is sampled by its capped renderer.
      frameRate: gpuVolume ? 0 : softwareRendering ? SOFTWARE_DISC_FPS : PLAYBACK_FPS,
      cadenceAnimation: () => canvas.parentElement.querySelector('.cd-deck-software-disc canvas')?.getAnimations()
        .find(animation => animation.id === 'cd-software-disc-spin'),
      canAlign: () => canRender() && !powerSave && !reduced.matches,
      canSkip: () => playbackVolume?.visible && canUseSoftwareFrames(),
      skipTransform: volumeSkipTransform,
      onSeatEnd: syncPlaybackMotion,
      canRun: () => {
        if (!playbackVolume?.visible || !canRender() || powerSave || reduced.matches || busy || !state.isPlaying || !state.currentTrack ||
          !(state.audibleTrackId === state.currentTrack.id || state.currentTime > 0) ||
          !spin.isAnimating() || carouselActive || discExchanging || !canUseSoftwareFrames()) return false
        const status = softwareFrames?.status()
        return !status?.playing && !status?.pending && !softwareFrames?.camera
      },
      remaining: () => spin.remainingMs(),
    })
    softwareFrames = createCdSoftwareFrames({
      surface: staticCanvas, renderer, scene,
      motionClock: cdAnimationClock,
      // Keep hardware motion at the screen refresh rate. Software composition
      // must not rebuild all projected surfaces 144/240 times per second.
      frameRate: softwareRendering ? 60 : 0,
      enabled: () => canRender() && !powerSave && !reduced.matches && canUseSoftwareFrames(),
      points: () => {
        lidPivot.updateWorldMatrix(true, false)
        lidCorners.forEach((corner, index) => motionCorners[reactionCorners.length + index].copy(corner).applyMatrix4(lidPivot.matrixWorld))
        return motionCorners
      },
      captureCamera: theta => {
        const poseCamera = camera.clone()
        positionCamera(poseCamera, { theta, phi: 0, roll: -theta * 0.065 / 0.28, zoom: 0, lift: 0 })
        return poseCamera
      },
      captureFrameQuad: poseCamera => {
        // Anchor the cached face to the exact spring pose between bitmaps.
        return softwareFaceCorners.map(corner => {
          const point = corner.clone().project(poseCamera)
          return { x: (point.x + 1) * frameWidth / 2, y: (1 - point.y) * frameHeight / 2 }
        })
      },
      beforeCapture,
      afterCapture,
      captureOverlays: poseCamera => ({ disc: discOverlayGeometry(poseCamera), controls: softwareControlGeometry(poseCamera) }),
      onPose: presentSoftwarePose,
      onRest: () => {
        if (disposed) return
        if (!playbackVolume?.visible) hideSoftwareControls()
        // Restore every overlay in the same frame as the resting chassis.
        // A queued React update would leave the print at the last turned pose.
        updateDiscOverlay(true)
        syncPlaybackMotion()
      },
    })
  }
  resize()
  const unsubscribeCarousel = mobile ? trackCarouselMotion.subscribe(setCarouselMotion) : null
  load.onCleanup(() => unsubscribeCarousel?.())

  function setState(next, loading = busy) {
    updateControls()
    spin.sync(next)
    const trackChanged = next.currentTrack?.id !== state.currentTrack?.id
    const initialized = playbackInitialized
    if (next.currentTrack !== undefined) playbackInitialized = true
    const hadTrack = Boolean(state.currentTrack)
    const previousState = state
    const previousShuffle = state.isShuffle
    const playbackChanged = next.isPlaying !== state.isPlaying
    const modeChanged = next.isShuffle !== state.isShuffle || next.isRepeatOne !== state.isRepeatOne
    const volumeChanged = next.volume !== state.volume
    const direction = trackChanged ? Math.sign((next.isShuffle ? next.currentShuffleIndex : next.currentIndex) -
      (state.isShuffle ? state.currentShuffleIndex : state.currentIndex)) : 0
    const controlsChanged = trackChanged || loading !== busy ||
      ['currentIndex', 'duration', 'volume', 'isPlaying', 'isShuffle', 'isRepeatOne', 'source'].some((key) => next[key] !== state[key])
    if (trackChanged || next.currentTime !== state.currentTime || next.isPlaying !== state.isPlaying) {
      timeAnchor = next.currentTime || 0
      timeChangedAt = performance.now()
      if (trackChanged) draggingDisc = false
    }
    state = next
    busy = loading
    const volumeAngle = (135 - state.volume * 270) * Math.PI / 180
    if (!initialized) volumeMarker.rotation.z = ridges.rotation.z = volumeAngle
    else if (volumeChanged) moveControl('volume', volumeMarker.rotation.z, volumeAngle, 140,
      (angle) => { volumeMarker.rotation.z = angle; ridges.rotation.z = angle })
    const playbackSelected = Boolean(state.currentTrack)
    const playbackPlaying = playbackSelected && state.isPlaying
    if (!lidInitialized) {
      lidInitialized = true
      moveLid(LID_CLOSED_ANGLE, true)
    }
    const iconKey = [playbackSelected, playbackPlaying, state.isShuffle, state.isRepeatOne].join(':')
    const iconChanged = iconKey !== lastIconKey
    if (iconChanged) {
      lastIconKey = iconKey
      for (const action of ['play', 'shuffle', 'repeat']) {
        const button = buttons[action]
        const selected = action === 'play' ? playbackSelected : action === 'shuffle' ? state.isShuffle : state.isRepeatOne
        const kind = action === 'play' && playbackPlaying ? 'pause' : action
        if (selected === button.selected && kind === button.kind) continue
        button.face.material = selected ? activeAccentMetal : accentMetal
        transitionCanvas(`icon:${action}`, button.iconCanvas, button.iconMap, (ctx) => {
          ctx.clearRect(0, 0, 128, 128)
          paintIcon(ctx, kind, 128)
        }, initialized)
        button.selected = selected
        button.kind = kind
        if (initialized) moveControl(`feedback:${action}`, Math.min(button.icon.scale.x, 0.94), 1, 200, (scale) => button.icon.scale.setScalar(scale))
      }
    }
    if (initialized && trackChanged && direction && !cachedRendering) {
      const icon = buttons[direction > 0 ? 'next' : 'previous'].icon
      moveControl(`skip:${direction}`, icon.position.x - direction * 0.018, 0, 180,
        (offset) => { icon.position.x = offset })
    }
    if (initialized) {
      if (trackChanged && hadTrack) {
        if (cachedRendering && onDiscChange) onDiscChange(direction || 1, previousState, next)
        else if (!(mobile && trackCarouselMotion.isConnected())) reactToAction(direction < 0 ? 'previous' : 'next')
      }
      else if (!playbackChanged && modeChanged) reactToAction(next.isShuffle !== previousShuffle ? 'shuffle' : 'repeat')
    }
    // Only control or appearance changes need a WebGL frame in cached mode.
    // Ordinary audio ticks keep the prepared chassis idle.
    if (!cachedRendering) invalidate(controlsChanged, iconChanged || volumeChanged)
    else if (iconChanged || volumeChanged) invalidate()
    syncPlaybackMotion()
  }
  function aim(clientX, clientY, poseCamera = carouselCamera || softwareFrames?.camera || camera) {
    const surface = carouselCamera ? canvas.parentElement : staticCanvas || canvas
    if (mapPointer) {
      const point = mapPointer(clientX, clientY, poseCamera === seekGestureCamera)
      if (!point || !surface.clientWidth || !surface.clientHeight) return false
      const parent = canvas.parentElement
      if (playbackVolume?.visible && poseCamera === camera) {
        // The GPU presenter keeps perspective even when reduced motion clears
        // the hidden projection node's CSS animation. Cast through its view.
        const pose = gpuVolume && playbackMotion.transform() || getComputedStyle(projectionElement).transform
        const transform = new DOMMatrix(pose && pose !== 'none' ? pose : undefined)
        const x = parseFloat(playbackElement.style.getPropertyValue('--cd-motion-origin-x')) || parent.clientWidth / 2
        const y = parseFloat(playbackElement.style.getPropertyValue('--cd-motion-origin-y')) || parent.clientHeight / 2
        const outer = new Matrix4().makeTranslation(x, y, 0)
          .multiply(new Matrix4().fromArray(transform.toFloat64Array()))
          .multiply(new Matrix4().makeTranslation(-x, -y, 0))
        return cdRayFromCssVolume(raycaster.ray, playbackVolume.matrix, outer,
          { x: point.x * parent.clientWidth, y: point.y * parent.clientHeight }, Boolean(gpuVolume))
      }
      const left = surface === parent ? 0 : surface.offsetLeft
      const top = surface === parent ? 0 : surface.offsetTop
      pointer.set((point.x * parent.clientWidth - left) / surface.clientWidth * 2 - 1,
        -(point.y * parent.clientHeight - top) / surface.clientHeight * 2 + 1)
    } else {
      const rect = surface.getBoundingClientRect()
      if (!rect.width || !rect.height) return false
      pointer.set((clientX - rect.left) / rect.width * 2 - 1, -(clientY - rect.top) / rect.height * 2 + 1)
    }
    raycaster.setFromCamera(pointer, poseCamera)
    return true
  }

  // Update shared materials in place: the chassis and playback caches remain
  // allocated, and neither the view nor the disc's rotation is reset.
  const bodySurfaces = [metal, faceMetal, blackChrome, controlMetal, lidMetal]
  const originalBodySurfaces = bodySurfaces.map((surface) => ({
    color: surface.color.clone(), metalness: surface.metalness,
    roughness: surface.roughness, bumpScale: surface.bumpScale,
    clearcoat: surface.clearcoat, clearcoatRoughness: surface.clearcoatRoughness,
  }))
  const originalEdgeColor = edgeMetal.color.clone()
  function setAppearance(value) {
    if (disposed) return
    const appearance = normalizeCdAppearance(value)
    const nextKey = JSON.stringify(appearance)
    if (appearanceKey === nextKey) return
    appearanceKey = nextKey
    const body = new Color(appearance.bodyColor)
    bodySurfaces.forEach((surface, index) => {
      const original = originalBodySurfaces[index]
      if (appearance.bodyColor === DEFAULT_CD_APPEARANCE.bodyColor) surface.color.copy(original.color)
      else {
        surface.color.copy(body)
        if (index === 1) surface.color.lerp(new Color('#ffffff'), 0.035)
        if (index === 2) surface.color.multiplyScalar(0.72)
        if (index === 3) surface.color.lerp(new Color('#ffffff'), 0.045)
      }
      if (appearance.finish === 'brushed') {
        Object.assign(surface, { metalness: original.metalness, roughness: original.roughness, bumpScale: original.bumpScale, clearcoat: original.clearcoat, clearcoatRoughness: original.clearcoatRoughness })
      } else {
        Object.assign(surface, appearance.finish === 'matte'
          ? { metalness: 0.08, roughness: 0.68, bumpScale: 0.0004, clearcoat: 0, clearcoatRoughness: 0.4 }
          : { metalness: 0.3, roughness: 0.16, bumpScale: 0, clearcoat: 1, clearcoatRoughness: 0.1 })
      }
      surface.needsUpdate = true
    })
    edgeMetal.color.copy(appearance.bodyColor === DEFAULT_CD_APPEARANCE.bodyColor
      ? originalEdgeColor : body.clone().lerp(new Color('#ffffff'), 0.28))
    accent = appearance.accentColor
    const selectedAccent = accent === DEFAULT_CD_APPEARANCE.accentColor
      ? new Color(activeAccent) : new Color(accent).lerp(new Color('#ffffff'), 0.18)
    accentMetal.color.set(accent)
    accentMetal.emissive.set(accent)
    activeAccentMetal.color.copy(selectedAccent)
    activeAccentMetal.emissive.copy(selectedAccent)
    glass.color.set(appearance.lid === 'smoked' ? '#667386' : '#c4cfd8')
    glass.opacity = appearance.lid === 'smoked' ? 0.32 : 0.115
    glassEdge.color.set(appearance.lid === 'smoked' ? '#7f8c9e' : '#adb5bb')
    for (const batch of surfaceBatches) updateCdSurfaceBatch(batch)
    glassDirty = lightingDirty = true
    setState(state)
    invalidate()
  }

  const performanceHost = canvas.parentElement
  load.onCleanup(() => { delete performanceHost.cdPerformance })
  performanceHost.cdPerformance = async () => {
    const began = performance.now(), before = gpuVolume?.status(), rendered = renderer.info.render.frame
    await new Promise(resolve => setTimeout(resolve, 2000))
    const after = gpuVolume?.status(), seconds = (performance.now() - began) / 1000
    return {
      gpu: after,
      fps: before && after ? Math.round((after.draws - before.draws) / seconds) : null,
      uploadsPerSecond: before && after ? (after.uploads - before.uploads) / seconds : null,
      uploadMBPerSecond: before && after ? (after.uploadedBytes - before.uploadedBytes) / seconds / 1e6 : null,
      sceneFramesPerSecond: (renderer.info.render.frame - rendered) / seconds,
      volume: playbackVolume?.status(), motion: playbackMotion?.status(),
    }
  }

  // Compile the actual finish before exposing the scene. The first render
  // otherwise waits synchronously for every physical material to link.
  setAppearance(appearance)
  await load.checkpoint(true)
  const compileTarget = renderer.getRenderTarget()
  try {
    if (!cachedRendering) renderer.setRenderTarget(staticFrame)
    await renderer.compileAsync(scene, camera)
    load.check()
    // compileAsync(scene) prepares visible materials but omits the depth
    // programs that the shadow pass first requests during rendering.
    const shadowWarmup = new Scene()
    const shadowMaterials = new Map()
    scene.traverse(object => {
      if (!object.isMesh || !object.castShadow) return
      const side = object.material.shadowSide ?? ({ 0: 1, 1: 0, 2: 2 })[object.material.side]
      if (!shadowMaterials.has(side)) shadowMaterials.set(side, own(new MeshDepthMaterial({ side })))
      const clone = object.clone(false)
      clone.material = shadowMaterials.get(side)
      shadowWarmup.add(clone)
    })
    await renderer.compileAsync(shadowWarmup, key.shadow.camera)
    load.check()
    if (!cachedRendering) {
      const warmup = new Scene()
      warmup.add(new Mesh(artwork.geometry, playbackArtwork), new Mesh(glassOverlay.geometry, glassSurface))
      renderer.setRenderTarget(playbackFrame)
      await renderer.compileAsync(warmup, camera, scene)
      load.check()
      await renderer.compileAsync(presentationScene, presentationCamera)
    }
  } finally { renderer.setRenderTarget(compileTarget) }
  await load.waitForGpu(renderer)
  await load.checkpoint(true)
  initializing = false
  if (presentation === 'setup' && !document.hidden) {
    // Shader readiness is not first-frame readiness. Paint the player behind
    // the sealed box before its onReady callback can start opening the lids.
    // Otherwise the first texture uploads/readback and lid composition compete
    // for the GPU immediately after the user finishes pulling the tape.
    render()
    await load.waitForGpu(renderer)
    await load.waitForPaint()
    await load.checkpoint(true)
  }
  observer.observe(stageElement)
  invalidate()

  return {
    setState,
    // Upload changed overlay pixels even when playback is paused.
    refreshDiscArtwork: syncPlaybackMotion,
    beginDiscExchange() {
      discExchanging = true
      clearTimeout(discExchangeSettleTimer)
      discExchangeSettleTimer = 0
      discExchangeSettling = false
      stopReaction()
      let viewAligned = Promise.resolve()
      if (!mobile) {
        // Pausing holds the current tilt. Return both the compositor and any
        // manually rotated camera to frontal before the incoming disc moves.
        if (carouselActive || carouselCamera) restoreCarousel()
        else softwareFrames?.stop()
        playbackMotion?.reset(powerSave || reduced.matches || !canRender(), 220)
        const thetaOffset = view.theta - initialView.theta
        if (viewMotion || Math.abs(Math.atan2(Math.sin(thetaOffset), Math.cos(thetaOffset))) > 1e-7 ||
            Math.abs(view.phi - initialView.phi) > 1e-7) {
          if (softwareRendering) { snapView(); updateDiscOverlay(); invalidate() }
          else resetView()
          if (viewMotion) viewAligned = new Promise(resolve => viewAlignmentWaiters.add(resolve))
        }
      }
      syncPlaybackMotion()
      return Promise.all([viewAligned, playbackMotion?.whenAligned()])
    },
    expediteDiscExchange() { playbackMotion?.expediteAlignment() },
    seatDisc() { playbackMotion?.seat(); syncPlaybackMotion() },
    setDiscExchangeSliding(value) {
      discExchangeSliding = Boolean(value)
      playbackElement?.classList.toggle('is-disc-exchanging', discExchangeSliding || discSwipeActive)
      clearTimeout(discExchangeSettleTimer)
      discExchangeSettleTimer = 0
      if (value) {
        discExchangeSettling = false
      } else {
        discExchanging = false
        // Keep the live CSS record on screen through the queue handoff and
        // its seat animation. Switching to the GPU layer on the same frame
        // briefly drops the disc while its texture uploads on phones.
        discExchangeSettling = true
        discExchangeSettleTimer = setTimeout(() => {
          discExchangeSettleTimer = 0
          discExchangeSettling = false
          syncPlaybackMotion()
        }, 240)
      }
      syncPlaybackMotion()
    },
    setDiscSwipeActive(value) {
      if (discSwipeActive === Boolean(value)) return
      discSwipeActive = Boolean(value)
      if (discSwipeActive) {
        clearTimeout(discExchangeSettleTimer)
        discExchangeSettleTimer = 0
        discExchangeSettling = false
      }
      playbackElement?.classList.toggle('is-disc-exchanging', discExchangeSliding || discSwipeActive)
      syncPlaybackMotion()
    },
    setPlaybackMotionEnabled(value) { playbackMotion?.setEnabled(value); syncPlaybackMotion() },
    playbackMotionStatus() { return playbackMotion?.status() },
    playbackVolumeStatus() { return playbackVolume?.status() },
    gpuVolumeStatus() { return gpuVolume?.status() },
    setInitialPlayback(value) {
      if (presentation === 'setup' || initialPlayback === value) return
      initialPlayback = value
      softwareFrames?.suspend()
      onAction?.(null)
      stopReaction()
      Object.assign(initialView, value ? FRONTAL_VIEW : playbackView)
      if (value || softwareRendering || powerSave || reduced.matches || !canRender()) {
        snapView()
        updateDiscOverlay()
        invalidate()
      } else resetView()
    },
    reactToAction,
    setAppearance,
    closeLid() {
      if (disposed) return Promise.resolve(false)
      moveLid(LID_CLOSED_ANGLE)
      if (!lidMotion) return Promise.resolve(true)
      return new Promise((resolve) => { lidWaiters.add(resolve) })
    },
    setActive(value) {
      active = value
      if (staticCanvas) staticCanvas.style.display = active ? 'block' : 'none'
      if (!active) canvas.style.display = 'none'
      else if (cachedRendering) canvas.style.display = canUseSoftwareFrames() ? 'none' : 'block'
      if (!active) hideSoftwareControls()
      spin.setEnabled(canRender() && !powerSave && !reduced.matches)
      if (active) invalidate()
      else { softwareFrames?.suspend(); finishControls(); snapLid(); if (viewMotion) snapView(); cancelRender() }
      syncPlaybackMotion()
    },
    setPowerSave(value) {
      if (value === powerSave) return
      powerSave = value
      spin.setEnabled(canRender() && !powerSave && !reduced.matches)
      if (powerSave) { softwareFrames?.suspend(); finishControls(); snapLid(); if (viewMotion) snapView() }
      // Cached chassis lighting stays identical when motion or power saving changes.
      renderer.shadowMap.enabled = !constrainedDevice && (!powerSave || cachedRendering)
      renderer.shadowMap.needsUpdate = renderer.shadowMap.enabled
      cancelRender()
      resize()
      syncPlaybackMotion()
    },
    rotateBy(x, y) {
      if (discExchanging) return
      if (mobile || softwareRendering) return
      softwareFrames?.suspend()
      if (reactionMotion) stopReaction()
      lastViewChangeAt = performance.now()
      if (viewMotion) updateViewMotion()
      viewMotion = null
      view.theta += x * 0.008
      view.phi = clamp(view.phi + y * 0.008, 0.22, 2.65)
      updateCamera()
    },
    reset: resetView,
    setControlMotionEnabled(value) {
      controlMotionEnabled = value
      if (!value) { finishControls(); invalidate() }
    },
    press(action, pressed) {
      const button = buttons[action]
      if (button) {
        updateControls()
        const destination = button.restPosition.y - (pressed ? 0.026 : 0)
        moveControl(`press:${action}`, button.group.position.y, destination,
          pressed ? 90 : 160, (position) => {
            button.group.position.y = position
            // The press is only 0.026 units deep. Rebuild its shadow at the
            // settled position, rather than every interpolated button frame.
            if (position === destination && !reactionMotion) renderer.shadowMap.needsUpdate = true
          })
        invalidate()
      }
    },
    hitTest(clientX, clientY) {
      if (!aim(clientX, clientY)) return null
      const hits = raycaster.intersectObject(deck, true)
      for (const hit of hits) {
        if (hit.object.userData.ignoreHit) continue
        let object = hit.object
        while (object && object !== deck) {
          if (object.userData.action) {
            return object.userData.action
          }
          object = object.parent
        }
        return mobile || softwareRendering ? null : 'rotate'
      }
      return null
    },
    discAngleAt(clientX, clientY) {
      if (!aim(clientX, clientY, seekGestureCamera || softwareFrames?.camera || camera)) return null
      discPlane.constant = -(playbackVolume?.visible ? PLAYBACK_SURFACE_Z : 0.63)
      if (!raycaster.ray.intersectPlane(discPlane, hitPoint)) return null
      localHitPoint.copy(hitPoint)
      disc.worldToLocal(localHitPoint)
      return Math.atan2(localHitPoint.z, localHitPoint.x)
    },
    progress,
    turnDisc(value) {
      if (!draggingDisc) {
        spin.hold(progress())
        volumeSeeking = Boolean(playbackVolume?.visible)
        playbackMotion?.reset(powerSave || reduced.matches || !canRender())
        if (!volumeSeeking) focusForSeek(true)
      }
      draggingDisc = true
      dragProgress = clamp(value, 0, 1)
      // The focused live frame turns the real print. Keep the prepared overlay
      // path free of extra WebGL frames when it owns the gesture instead.
      if (cachedRendering && !isLiveDiscFocused()) { syncPlaybackMotion(); return }
      spin.turn(dragProgress)
      invalidate(true, false)
    },
    releaseDisc(immediate = false) {
      draggingDisc = false
      spin.release()
      if (!volumeSeeking) focusForSeek(false, immediate)
      volumeSeeking = false
      syncPlaybackMotion()
    },
    setCover(url) {
      // Cached playback keeps the resting print hidden, but the live disc
      // shown while a seek focuses the camera still needs the same texture.
      if (url === loadedCover) return
      loadedCover = url
      const version = ++coverVersion
      if (coverImage) { coverImage.onload = null; coverImage.onerror = null }
      if (!url) {
        const previous = artworkMaterial.map
        artworkMaterial.map = null
        if (previous) { resources.delete(previous); previous.dispose() }
        artworkMaterial.needsUpdate = true
        invalidate()
        return
      }
      coverImage = new Image()
      coverImage.crossOrigin = 'anonymous'
      coverImage.decoding = 'async'
      coverImage.onload = () => {
        if (disposed || version !== coverVersion) return
        const image = coverImage
        const side = Math.min(image.naturalWidth, image.naturalHeight)
        const size = Math.min(MAX_ARTWORK_SIZE, side)
        const source = makeCanvas(size, size, (ctx) => paintCdDiscPrint(ctx, size, image))
        const previous = artworkMaterial.map
        artworkMaterial.map = texture(source, true)
        artworkMaterial.map.center.set(0.5, 0.5)
        if (!previous) artworkMaterial.needsUpdate = true
        if (previous) { resources.delete(previous); previous.dispose() }
        // Changing the print does not change its geometry or illumination.
        // Upload the new texture and repaint the disc tile using those caches.
        invalidate(true, !previous)
      }
      coverImage.onerror = () => {
        if (disposed || version !== coverVersion) return
        const previous = artworkMaterial.map
        artworkMaterial.map = null
        if (previous) { resources.delete(previous); previous.dispose() }
        artworkMaterial.needsUpdate = true
        invalidate()
      }
      coverImage.src = url
    },
    dispose() {
      delete performanceHost.cdPerformance
      clearTimeout(discExchangeSettleTimer)
      discExchangeSettleTimer = 0
      playbackMotion?.dispose()
      gpuVolume?.dispose()
      gpuProjectionNode?.remove()
      playbackVolume?.dispose()
      playbackElement?.classList.remove('has-crop', 'has-volume', 'is-live-disc')
      unsubscribeCarousel?.()
      finishControls()
      disposed = true
      viewMotion = null
      releaseViewAlignment()
      softwareFrames?.dispose()
      lidMotion = null
      resolveLid(false)
      coverVersion++
      for (const image of logoImages) image.onload = null
      if (coverImage) { coverImage.onload = null; coverImage.onerror = null }
      cancelRender()
      observer.disconnect()
      intersection.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      reduced.removeEventListener('change', onReducedMotion)
      canvas.removeEventListener('webglcontextlost', onContextLost)
      onDiscOverlayChange?.(null)
      key.shadow.map?.dispose()
      resources.forEach((resource) => resource.dispose())
      for (const { batch } of transportBatches) batch.dispose()
      iconBatch?.dispose()
      staticCanvas?.remove()
      for (const { patch } of softwareControls) { patch.width = patch.height = 0; patch.remove() }
      Object.assign(canvas.style, { display: '' })
      if (staticCanvas) Object.assign(canvas.style, { position: '', left: '', top: '', width: '', height: '', marginLeft: '' })
      renderer.dispose()
      renderer.forceContextLoss()
    },
  }
}



