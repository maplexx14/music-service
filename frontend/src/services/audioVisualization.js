import { getActive } from './audioEngine'

// Capture a copy of the sound. Routing the player's media elements through
// Web Audio would make background playback depend on a running AudioContext.
export function createWaveformReader(count = 128) {
  const values = new Float32Array(count)
  const targets = new Float32Array(count)
  let context = null
  let capture = null
  let level = 0
  let disposed = false
  let unavailable = false
  let resuming = false
  let wanted = false

  function releaseCapture() {
    if (!capture) return
    capture.source?.disconnect()
    capture.analyser?.disconnect()
    for (const track of capture.stream.getTracks()) track.stop()
    capture = null
  }

  function resume() {
    if (!context || disposed || !wanted || resuming || context.state === 'running') return
    resuming = true
    context.resume().then(() => {
      if (!wanted && !disposed) context.suspend().catch(() => {})
    }, () => {}).finally(() => { resuming = false })
  }

  function connect(element) {
    const captureStream = element.captureStream || element.mozCaptureStream
    const AudioContext = window.AudioContext || window.webkitAudioContext
    if (!captureStream || !AudioContext) {
      unavailable = true
      return
    }
    try {
      if (!context) context = new AudioContext()
      const stream = captureStream.call(element)
      capture = { element, url: element.currentSrc || element.src, stream }
      resume()
    } catch {
      // Unsupported capture/CORS must never interfere with the actual player.
      unavailable = true
    }
  }

  function read(delta = 1 / 30, playing = true) {
    let samples = null
    const element = getActive()
    const audible = playing && element && !element.paused && !element.ended &&
      element.readyState >= 2 && !element.muted && element.volume > 0
    wanted = Boolean(audible) && !disposed

    if (capture && (element !== capture.element ||
      (element.currentSrc || element.src) !== capture.url)) {
      releaseCapture()
      values.fill(0)
      level = 0
    }

    if (!disposed && !unavailable && audible) {
      // Firefox ends captured tracks when the media source ends.
      if (capture?.source && !capture.stream.getAudioTracks().some((track) => track.readyState === 'live')) {
        releaseCapture()
      }
      if (!capture) connect(element)
      resume()
      if (capture && !capture.source) {
        const tracks = capture.stream.getAudioTracks()
        if (tracks.some((track) => track.readyState === 'live')) {
          try {
            capture.source = context.createMediaStreamSource(capture.stream)
            capture.analyser = context.createAnalyser()
            capture.analyser.fftSize = 2048
            capture.samples = new Float32Array(capture.analyser.fftSize)
            capture.source.connect(capture.analyser)
          } catch {
            releaseCapture()
            unavailable = true
          }
        }
      }
      if (capture?.analyser && context.state === 'running') {
        capture.analyser.getFloatTimeDomainData(capture.samples)
        samples = capture.samples
      }
    }

    const dt = Math.min(Math.max(delta, 0), 0.1)
    let energy = 0
    for (let i = 0; i < count; i += 1) {
      let sum = 0
      if (samples) {
        const start = Math.floor(i * samples.length / count)
        const end = Math.floor((i + 1) * samples.length / count)
        for (let j = start; j < end; j += 1) sum += samples[j] * samples[j]
        sum /= Math.max(1, end - start)
      }
      energy += sum
      targets[i] = Math.min(1, Math.sqrt(sum) * 4)
    }
    for (let i = 0; i < count; i += 1) {
      // Blend neighbouring samples into a continuous envelope.
      const target = (targets[Math.max(0, i - 2)] + targets[Math.max(0, i - 1)] * 2 +
        targets[i] * 3 + targets[Math.min(count - 1, i + 1)] * 2 + targets[Math.min(count - 1, i + 2)]) / 9
      // A gentle rise (~600 ms) and longer release (~1.5 s), independent of FPS.
      const rate = target > values[i] ? 5 : 2
      values[i] += (target - values[i]) * (1 - Math.exp(-dt * rate))
    }
    const targetLevel = Math.min(1, Math.sqrt(energy / count) * 4)
    level += (targetLevel - level) * (1 - Math.exp(-dt * (targetLevel > level ? 5 : 2)))
    return { values, level }
  }

  function pause() {
    wanted = false
    releaseCapture()
    values.fill(0)
    level = 0
    if (context?.state === 'running') context.suspend().catch(() => {})
  }

  const gestures = ['pointerdown', 'touchstart', 'keydown']
  for (const type of gestures) document.addEventListener(type, resume, { capture: true, passive: true })

  return {
    get supported() { return !unavailable },
    read,
    pause,
    dispose() {
      disposed = true
      pause()
      for (const type of gestures) document.removeEventListener(type, resume, { capture: true })
      context?.close().catch(() => {})
    },
  }
}
