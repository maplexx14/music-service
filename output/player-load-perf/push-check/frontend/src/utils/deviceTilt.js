const RAD = Math.PI / 180
const clamp = (value, limit) => Math.min(limit, Math.max(-limit, value))

// DeviceOrientation uses intrinsic Z-X-Y rotations. Comparing quaternions
// avoids jumps at the heading wrap and when a phone crosses the upright pose.
function orientation({ alpha, beta, gamma }) {
  const z = (Number.isFinite(alpha) ? alpha : 0) * RAD / 2
  const x = beta * RAD / 2
  const y = gamma * RAD / 2
  const cx = Math.cos(x), sx = Math.sin(x)
  const cy = Math.cos(y), sy = Math.sin(y)
  const cz = Math.cos(z), sz = Math.sin(z)
  return {
    x: sx * cy * cz - cx * sy * sz,
    y: cx * sy * cz + sx * cy * sz,
    z: cx * cy * sz + sx * sy * cz,
    w: cx * cy * cz - sx * sy * sz,
  }
}

export function createDeviceTilt() {
  let reference = null
  let referenceAngle = null
  return {
    reset() { reference = null; referenceAngle = null },
    sample(event, screenAngle = 0) {
      if (!Number.isFinite(event.beta) || !Number.isFinite(event.gamma)) return null
      const current = orientation(event)
      const angle = Number.isFinite(screenAngle) ? ((screenAngle % 360) + 360) % 360 : 0
      if (!reference || angle !== referenceAngle) {
        reference = current
        referenceAngle = angle
        return { theta: 0, phi: 0 }
      }
      // Inverse(reference) * current, expressed in the phone's initial axes.
      const x = reference.w * current.x - reference.x * current.w - reference.y * current.z + reference.z * current.y
      const y = reference.w * current.y + reference.x * current.z - reference.y * current.w - reference.z * current.x
      const z = reference.w * current.z - reference.x * current.y + reference.y * current.x - reference.z * current.w
      const w = reference.w * current.w + reference.x * current.x + reference.y * current.y + reference.z * current.z
      const roll = Math.atan2(2 * (w * y - x * z), 1 - 2 * (x * x + y * y))
      const pitch = Math.asin(clamp(2 * (w * x + y * z), 1))
      const cosine = Math.cos(angle * RAD)
      const sine = Math.sin(angle * RAD)
      return {
        theta: clamp(-(roll * cosine + pitch * sine) * 0.55, 12 * RAD),
        phi: clamp((pitch * cosine - roll * sine) * 0.4, 8 * RAD),
      }
    },
  }
}

let permission = null
let permissionRequest = null

export function deviceTiltPermission() {
  if (typeof window === 'undefined' || !window.isSecureContext || !window.DeviceOrientationEvent) return 'unavailable'
  return typeof window.DeviceOrientationEvent.requestPermission === 'function' ? permission || 'prompt' : 'granted'
}

export function requestDeviceTiltPermission() {
  if (deviceTiltPermission() !== 'prompt') return Promise.resolve(deviceTiltPermission())
  if (!permissionRequest) {
    // Invoke synchronously in the button's click handler: iOS requires a
    // trusted user gesture, including before the first promise continuation.
    try {
      permissionRequest = window.DeviceOrientationEvent.requestPermission()
        .then(result => { permission = result === 'granted' ? 'granted' : 'denied'; return permission })
        .catch(() => 'prompt')
        .finally(() => { permissionRequest = null })
    } catch { return Promise.resolve('prompt') }
  }
  return permissionRequest
}
