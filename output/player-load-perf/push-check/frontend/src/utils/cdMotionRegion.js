import { Vector3 } from 'three'

const projected = new Vector3()
const clamp = (value, max) => Math.min(max, Math.max(0, value))

// Center the visible chassis, including perspective, without changing its
// angle. A resting reference keeps action springs on their original path.
// Cached crops and pointer projections share the same camera view.
export function centerCdCamera(points, camera, width, height, reference = camera) {
  if (!points.length || width <= 0 || height <= 0) return
  reference.clearViewOffset()
  let left = Infinity, right = -Infinity, bottom = Infinity, top = -Infinity
  for (const point of points) {
    projected.copy(point).project(reference)
    if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y)) return
    left = Math.min(left, projected.x); right = Math.max(right, projected.x)
    bottom = Math.min(bottom, projected.y); top = Math.max(top, projected.y)
  }
  camera.setViewOffset(width, height, (left + right) * width / 4,
    -(bottom + top) * height / 4, width, height)
  return {
    x: width / 2 - (right - left) * width / 4,
    y: height / 2 - (top - bottom) * height / 4,
    width: (right - left) * width / 2,
    height: (top - bottom) * height / 2,
  }
}

// Bounds in physical framebuffer pixels, with WebGL's bottom-left origin.
export function cdMotionRegion(points, camera, width, height, padding = 10) {
  let left = width, bottom = height, right = 0, top = 0
  for (const point of points) {
    projected.copy(point).project(camera)
    if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y)) return { x: 0, y: 0, width, height }
    const x = (projected.x + 1) * width / 2
    const y = (projected.y + 1) * height / 2
    left = Math.min(left, x); right = Math.max(right, x)
    bottom = Math.min(bottom, y); top = Math.max(top, y)
  }
  left = clamp(Math.floor(left - padding), width)
  bottom = clamp(Math.floor(bottom - padding), height)
  right = clamp(Math.ceil(right + padding), width)
  top = clamp(Math.ceil(top + padding), height)
  return right > left && top > bottom
    ? { x: left, y: bottom, width: right - left, height: top - bottom }
    : { x: 0, y: 0, width, height }
}

// Keep the viewport/sampling grid stable through a spring. A little headroom
// covers ordinary skips; inspecting the lid can expand it without clipping.
export function growCdMotionRegion(previous, next, width, height, padding = 32) {
  if (previous && next.x >= previous.x && next.y >= previous.y &&
    next.x + next.width <= previous.x + previous.width && next.y + next.height <= previous.y + previous.height) return previous
  const left = clamp(Math.min(previous?.x ?? width, next.x - padding), width)
  const bottom = clamp(Math.min(previous?.y ?? height, next.y - padding), height)
  const right = clamp(Math.max(previous ? previous.x + previous.width : 0, next.x + next.width + padding), width)
  const top = clamp(Math.max(previous ? previous.y + previous.height : 0, next.y + next.height + padding), height)
  return { x: left, y: bottom, width: right - left, height: top - bottom }
}
