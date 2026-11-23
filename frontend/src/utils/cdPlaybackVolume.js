import { Matrix4, OrthographicCamera, SRGBColorSpace, Vector3, Vector4, WebGLRenderTarget } from 'three'
import { cdSoftwareFramePixels, cdSoftwareFrameEdges } from './cdSoftwareFrames.js'

const MAX_FACE_SIZE = 1024
const MAX_CAPTURE_PIXELS = 1_500_000

export function cdPlaybackVolumeFaces(min, max, cornerRadius = 0) {
  const [x0, y0, z0] = min, [x1, y1, z1] = max
  const faces = [
    ['front', [[x0, y1, z1], [x1, y1, z1], [x1, y0, z1], [x0, y0, z1]]],
    ['back', [[x1, y1, z0], [x0, y1, z0], [x0, y0, z0], [x1, y0, z0]]],
    ['left', [[x0, y1, z0], [x0, y1, z1], [x0, y0, z1], [x0, y0, z0]]],
    ['right', [[x1, y1, z1], [x1, y1, z0], [x1, y0, z0], [x1, y0, z1]]],
    ['top', [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]]],
    ['bottom', [[x0, y0, z1], [x1, y0, z1], [x1, y0, z0], [x0, y0, z0]]],
  ]
  const radius = Math.min(cornerRadius, (x1 - x0) / 2, (y1 - y0) / 2)
  if (radius > 0) {
    // The lid has a rounded outline. A rectangular side plane protrudes
    // behind its transparent corners; follow that outline with real walls.
    faces.splice(2)
    const arcs = [
      [x1 - radius, y1 - radius, 90, 'right'],
      [x1 - radius, y0 + radius, 0, 'bottom'],
      [x0 + radius, y0 + radius, -90, 'left'],
      [x0 + radius, y1 - radius, -180, 'top'],
    ]
    const perimeter = arcs.flatMap(([cx, cy, start, name], corner) =>
      Array.from({ length: 9 }, (_, step) => {
        const angle = (start - step * 90 / 8) * Math.PI / 180
        return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle), name: step === 8 ? name : `corner-${corner}-${step}` }
      }))
    perimeter.forEach((point, index) => {
      const next = perimeter[(index + 1) % perimeter.length]
      faces.push([point.name, [[point.x, point.y, z0], [next.x, next.y, z0], [next.x, next.y, z1], [point.x, point.y, z1]]])
    })
  }
  return faces.map(([name, corners]) => ({ name, corners: corners.map(point => new Vector3(...point)) }))
}

// Preserve view-space depth in CSS, rather than flattening projected corners
// onto z=0. The same camera then places the chassis, recessed disc and controls.
export function cdCssCameraMatrix(camera, target, width, height, left = 0) {
  camera.updateMatrixWorld(true)
  const radius = camera.position.distanceTo(target)
  const lens = height / (2 * Math.tan(camera.fov * Math.PI / 360))
  const scale = lens / radius
  const center = target.clone().project(camera)
  const perspective = new Matrix4()
  perspective.elements[11] = -1 / lens
  const centerX = left + (center.x + 1) * width / 2, centerY = (1 - center.y) * height / 2
  const viewMatrix = new Matrix4().makeTranslation(centerX, centerY, 0)
    .multiply(new Matrix4().makeScale(scale, -scale, scale))
    .multiply(new Matrix4().makeTranslation(0, 0, radius))
    .multiply(camera.matrixWorldInverse)
  const matrix = new Matrix4().makeTranslation(centerX, centerY, 0).multiply(perspective)
    .multiply(new Matrix4().makeTranslation(-centerX, -centerY, 0)).multiply(viewMatrix)
  return { matrix, viewMatrix, scale, lens, centerX, centerY }
}

export function cdCssPlaneMatrix(cameraMatrix, corners, width, height) {
  const right = corners[1].clone().sub(corners[0]).divideScalar(width)
  const down = corners[3].clone().sub(corners[0]).divideScalar(height)
  const normal = down.clone().cross(right).normalize()
  const origin = corners[0]
  return cameraMatrix.clone().multiply(new Matrix4().set(
    right.x, down.x, normal.x, origin.x,
    right.y, down.y, normal.y, origin.y,
    right.z, down.z, normal.z, origin.z,
    0, 0, 0, 1,
  ))
}

export function cdCssCameraDelta(source, destination) {
  const inverseLens = new Matrix4()
  inverseLens.elements[11] = 1 / source.lens
  const inverseProjection = new Matrix4().makeTranslation(source.centerX, source.centerY, 0)
    .multiply(inverseLens)
    .multiply(new Matrix4().makeTranslation(-source.centerX, -source.centerY, 0))
  const relative = inverseProjection.multiply(destination.matrix).multiply(source.viewMatrix.clone().invert())
  return new Matrix4().makeTranslation(-source.centerX, -source.centerY, 0)
    .multiply(relative).multiply(new Matrix4().makeTranslation(source.centerX, source.centerY, 0))
}

export function cdCssMatrixTransform(matrix) {
  return `matrix3d(${matrix.elements.map(value => Math.abs(value) < 1e-12 ? 0 : value).join(',')})`
}

// Pointer markers undo the outer animation on its z=0 plane. Reconstruct
// that screen point and cast through the complete volumetric projection.
// This runs only on input; playback has no matrix readback or JS frame loop.
export function cdRayFromCssVolume(ray, cameraMatrix, outerMatrix, flatPoint, isScreenPoint = false) {
  const screen = new Vector4(flatPoint.x, flatPoint.y, 0, 1)
  if (!isScreenPoint) screen.applyMatrix4(outerMatrix)
  if (Math.abs(screen.w) < 1e-10) return false
  const inverse = outerMatrix.clone().multiply(cameraMatrix).invert()
  const eye = new Vector4(0, 0, 1, 0).applyMatrix4(inverse)
  const point = new Vector4(screen.x / screen.w, screen.y / screen.w, 0, 1).applyMatrix4(inverse)
  if (Math.abs(eye.w) < 1e-10 || Math.abs(point.w) < 1e-10) return false
  ray.origin.set(eye.x / eye.w, eye.y / eye.w, eye.z / eye.w)
  ray.direction.set(point.x / point.w, point.y / point.w, point.z / point.w).sub(ray.origin).normalize()
  return [...ray.origin.toArray(), ...ray.direction.toArray()].every(Number.isFinite)
}

// Small antialiased wall textures form a rounded 3D shell. Capture only after
// a model/detail change, install all faces together, then let CSS composite
// their real depth. No pose atlas, crossfade, or per-frame WebGL presentation.
export function createCdPlaybackVolume({ parent, renderer, scene, faces, enabled, captureCamera, paintFace, onReady, beforeCapture, afterCapture }) {
  const element = document.createElement('div')
  element.className = 'cd-deck-volume'
  element.setAttribute('aria-hidden', 'true')
  element.style.display = 'none'
  parent.append(element)
  const surfaces = faces.map(face => {
    const canvas = document.createElement('canvas')
    canvas.className = `cd-deck-volume-face is-${face.name}`
    canvas.width = canvas.height = 1
    element.append(canvas)
    return { ...face, canvas }
  })
  let cameraMatrix = null, scale = 0, visible = false, disposed = false
  let desired = null, readyKey = null, generation = 0, preparing = false, timer = 0, idle = 0, failure = null

  function place() {
    if (!cameraMatrix) return
    for (const face of surfaces) {
      face.canvas.style.transform = cdCssMatrixTransform(cdCssPlaneMatrix(cameraMatrix, face.corners, face.canvas.width, face.canvas.height))
    }
  }
  function schedule() {
    if (disposed || preparing || timer || idle || !desired || desired.key === readyKey || !enabled()) return
    timer = setTimeout(() => {
      timer = 0
      if (!enabled()) return
      if (typeof window.requestIdleCallback === 'function') {
        idle = window.requestIdleCallback(() => { idle = 0; bake() })
      } else bake()
    }, 60)
  }
  async function bake() {
    if (disposed || preparing || !enabled() || !desired || desired.key === readyKey) return
    preparing = true
    const epoch = generation, request = desired, captured = []
    let captureTarget = null
    try {
      for (const face of surfaces) {
        if (disposed || epoch !== generation || !enabled()) return
        const right = face.corners[1].clone().sub(face.corners[0])
        const down = face.corners[3].clone().sub(face.corners[0])
        const width = right.length(), height = down.length()
        // Playback stays in front of the deck. Its closed back needs only a
        // small texture; reserve the sharp pixels for the visible surfaces.
        const faceSize = face.name === 'back' ? 256 : MAX_FACE_SIZE
        const density = Math.min(request.scale * Math.max(1.5, Math.min(window.devicePixelRatio || 1, 2)), faceSize / Math.max(width, height))
        const image = document.createElement('canvas')
        // These walls are viewed at a grazing angle. Prefilter their thin
        // depth axis once so CSS minification cannot sparkle on metal seams.
        const along = face.name === 'top' || face.name === 'bottom' || face.name === 'left' || face.name === 'right' || face.name.startsWith('corner-') ? 0.75 : 1
        image.width = Math.max(1, Math.ceil(width * density))
        image.height = Math.max(1, Math.ceil(height * density * along))
        const ratio = Math.min(1.5, Math.sqrt(MAX_CAPTURE_PIXELS / (image.width * image.height)))
        const pixelWidth = Math.ceil(image.width * ratio), pixelHeight = Math.ceil(image.height * ratio)
        captureTarget = new WebGLRenderTarget(pixelWidth, pixelHeight, {
          samples: Math.min(4, renderer.capabilities.maxSamples), colorSpace: SRGBColorSpace, internalFormat: 'RGBA8',
        })
        captureTarget.isXRRenderTarget = true
        const camera = new OrthographicCamera(-width / 2, width / 2, height / 2, -height / 2, 0.1, 40)
        const center = face.corners[0].clone().add(face.corners[2]).multiplyScalar(0.5)
        const normal = down.clone().cross(right).normalize()
        camera.position.copy(center).addScaledVector(normal, 15)
        camera.up.copy(down).multiplyScalar(-1).normalize()
        camera.lookAt(center)
        camera.updateMatrixWorld(true)
        const previous = renderer.getRenderTarget()
        let readback
        const pixels = new Uint8Array(pixelWidth * pixelHeight * 4)
        beforeCapture?.()
        try {
          renderer.setRenderTarget(captureTarget)
          renderer.render(scene, captureCamera?.(face) || camera)
          readback = renderer.readRenderTargetPixelsAsync(captureTarget, 0, 0, pixelWidth, pixelHeight, pixels)
        } finally { renderer.setRenderTarget(previous); afterCapture?.() }
        await readback
        captureTarget.dispose()
        captureTarget = null
        if (disposed || epoch !== generation || !enabled()) return
        const data = new ImageData(pixelWidth, pixelHeight)
        cdSoftwareFramePixels(pixels, data.data, pixelWidth, pixelHeight)
        const resolved = document.createElement('canvas')
        resolved.width = pixelWidth; resolved.height = pixelHeight
        resolved.getContext('2d').putImageData(data, 0, 0)
        const context = image.getContext('2d')
        context.imageSmoothingQuality = 'high'
        context.drawImage(resolved, 0, 0, image.width, image.height)
        resolved.width = resolved.height = 0
        paintFace?.(face, context, image.width, image.height)
        // These textures also drive the GPU presenter. Smooth their cutout
        // after trimming neighbouring geometry, once rather than per frame.
        const facePixels = context.getImageData(0, 0, image.width, image.height)
        cdSoftwareFrameEdges(facePixels.data, image.width, image.height, 0.5)
        context.putImageData(facePixels, 0, 0)
        captured.push(image)
      }
      if (disposed || epoch !== generation) return
      surfaces.forEach((face, index) => {
        face.canvas.width = captured[index].width; face.canvas.height = captured[index].height
        face.canvas.getContext('2d').drawImage(captured[index], 0, 0)
      })
      readyKey = request.key
      failure = null
      place()
      onReady?.()
    } catch (error) {
      // Context loss can reject an outstanding readback without an Error.
      // A cancelled capture must not invalidate a newer or disposed chassis.
      if (disposed || epoch !== generation || !enabled()) return
      failure = error?.message || String(error ?? 'CD surface capture failed')
      readyKey = request.key
    } finally {
      captureTarget?.dispose()
      captured.forEach(image => { image.width = image.height = 0 })
      preparing = false
      schedule()
    }
  }
  return {
    setView(matrix, pixelsPerUnit) {
      if (scale === pixelsPerUnit && cameraMatrix?.equals(matrix)) return
      cameraMatrix = matrix; scale = pixelsPerUnit; place()
    },
    refresh(key) {
      const nextKey = `${key}|${scale.toFixed(4)}|${window.devicePixelRatio || 1}`
      if (desired?.key !== nextKey) { desired = { key: nextKey, scale }; generation++ }
      schedule()
    },
    setVisible(value) {
      visible = Boolean(value && readyKey && !failure)
      element.style.display = visible ? 'block' : 'none'
      return visible
    },
    get visible() { return visible },
    get matrix() { return cameraMatrix },
    status() { return { ready: Boolean(readyKey && !failure), visible, preparing, pending: desired?.key !== readyKey, failure,
      faces: surfaces.length, bytes: surfaces.reduce((sum, face) => sum + face.canvas.width * face.canvas.height * 4, 0) } },
    dispose() {
      disposed = true
      visible = false
      generation++
      clearTimeout(timer)
      if (idle) window.cancelIdleCallback?.(idle)
      for (const { canvas } of surfaces) canvas.width = canvas.height = 0
      element.remove()
    },
  }
}


