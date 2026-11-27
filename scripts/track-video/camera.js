/* The perspective camera, touch indicators, and background applied to the captured Bolt interface. */
const canvas = document.getElementById('film')
const ctx = canvas.getContext('2d', { alpha: false })
const W = 1080,
  H = 1920
const edition = window.BOLT_EDITION
const FPS = edition.fps
const homeIntro = window.BOLT_INTRO
const INTRO_DURATION = edition.introDuration - edition.openingLead,
  DURATION = edition.filmDuration
canvas.width = W
canvas.height = H
const meta = window.BOLT_CAPTURE

const clamp = (x) => Math.max(0, Math.min(1, x))
const mix = (a, b, p) => a + (b - a) * p
const out = (x) => 1 - Math.pow(1 - clamp(x), 4)
const smootherstep = (x) => {
  const p = clamp(x)
  return p * p * p * (10 + p * (-15 + 6 * p))
}
function asset(name) {
  const i = new Image()
  i.src = 'assets/' + name
  return i
}
const beforeSwitch = asset('live/00068.jpg')
const intro = asset('live/00000.jpg')
const pointerImage = new Image()
pointerImage.src =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 48 48"><circle cx="24" cy="24" r="21" fill="white" fill-opacity=".08" stroke="white" stroke-opacity=".28" stroke-width="1"/><circle cx="24" cy="24" r="12" fill="white" fill-opacity=".23"/></svg>',
  )

// Perspective-correct textured plane. Coordinates stay in the app's CSS pixels.
const plane = document.createElement('canvas')
plane.width = W
plane.height = H
const gl = plane.getContext('webgl', {
  alpha: true,
  antialias: true,
  preserveDrawingBuffer: true,
  premultipliedAlpha: true,
})
if (!gl) throw new Error('WebGL is needed for the perspective camera.')
function shader(type, source) {
  const s = gl.createShader(type)
  gl.shaderSource(s, source)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s))
  return s
}
const program = gl.createProgram()
gl.attachShader(
  program,
  shader(
    gl.VERTEX_SHADER,
    `
  precision highp float;
  attribute vec2 aUv;
  uniform vec2 uSource, uFocus, uScreen, uOutput;
  uniform vec3 uRotation;
  uniform float uScale;
  varying vec2 vUv;
  void main() {
    vUv = aUv;
    vec3 p = vec3((aUv * uSource - uFocus) * uScale, 0.0);
    float cy = cos(uRotation.y), sy = sin(uRotation.y);
    p = vec3(cy*p.x + sy*p.z, p.y, -sy*p.x + cy*p.z);
    float cx = cos(uRotation.x), sx = sin(uRotation.x);
    p = vec3(p.x, cx*p.y - sx*p.z, sx*p.y + cx*p.z);
    float cr = cos(uRotation.z), sr = sin(uRotation.z);
    p.xy = vec2(cr*p.x - sr*p.y, sr*p.x + cr*p.y);
    float depth = 1.0 + p.z / 2200.0;
    vec2 screen = p.xy + (uScreen - uOutput * 0.5) * depth;
    gl_Position = vec4(screen.x * 2.0 / uOutput.x, -screen.y * 2.0 / uOutput.y, 0.0, depth);
  }
`,
  ),
)
gl.attachShader(
  program,
  shader(
    gl.FRAGMENT_SHADER,
    `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uImage;
  uniform sampler2D uOldImage;
  uniform sampler2D uPointerImage;
  uniform vec2 uSource;
  uniform vec4 uCrop;
  uniform vec4 uPointer;
  uniform float uRadius, uShadow, uSwitch;
  uniform vec2 uUiBlur;
  vec3 soften(sampler2D image, vec2 uv, float blur) {
    vec2 delta = vec2(blur) / uSource;
    return texture2D(image,uv).rgb*0.4 +
      (texture2D(image,uv+vec2(delta.x,0.0)).rgb + texture2D(image,uv-vec2(delta.x,0.0)).rgb +
       texture2D(image,uv+vec2(0.0,delta.y)).rgb + texture2D(image,uv-vec2(0.0,delta.y)).rgb)*0.15;
  }
  float roundedBox(vec2 p, vec2 halfSize, float radius) {
    vec2 q = abs(p) - halfSize + radius;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
  }
  void main() {
    vec2 px = vUv * uSource;
    vec2 center = vec2((uCrop.x + uCrop.z)*0.5, (uCrop.y + uCrop.w)*0.5);
    vec2 halfSize = vec2(uCrop.z-uCrop.x, uCrop.w-uCrop.y)*0.5;
    if (uShadow > 0.5) {
      float d = roundedBox(px - center - vec2(0.0, 17.0), halfSize, uRadius);
      float alpha = exp(-pow(max(d, 0.0)/22.0, 2.0))*0.55;
      gl_FragColor = vec4(0.0, 0.0, 0.0, alpha);
    } else {
      float d = roundedBox(px - center, halfSize, uRadius);
      float alpha = 1.0 - smoothstep(-0.75, 0.75, d);
      vec3 color = texture2D(uImage, clamp(vUv, 0.0, 1.0)).rgb;
      if(uUiBlur.x>0.0&&px.y<uUiBlur.y){
        vec2 delta=vec2(uUiBlur.x/uSource.x,0.0);
        color=texture2D(uImage,vUv).rgb*0.20;
        color+=(texture2D(uImage,vUv+delta).rgb+texture2D(uImage,vUv-delta).rgb)*0.17;
        color+=(texture2D(uImage,vUv+2.0*delta).rgb+texture2D(uImage,vUv-2.0*delta).rgb)*0.12;
        color+=(texture2D(uImage,vUv+3.0*delta).rgb+texture2D(uImage,vUv-3.0*delta).rgb)*0.075;
        color+=(texture2D(uImage,vUv+4.0*delta).rgb+texture2D(uImage,vUv-4.0*delta).rgb)*0.035;
      }
      if (uSwitch < 1.0 && px.y > 128.0) {
        float blur = sin(uSwitch * 3.14159265)*2.0;
        vec2 nextUv = vUv - vec2((1.0-uSwitch)*18.0/uSource.x,0.0);
        vec2 oldUv = vUv + vec2(uSwitch*14.0/uSource.x,0.0);
        color = mix(soften(uOldImage,oldUv,blur),soften(uImage,nextUv,blur),uSwitch);
      }
      color = pow(color,vec3(1.13));
      if (uPointer.z > 0.0) {
        vec2 pointerUv = (px-uPointer.xy)/(vec2(48.0,48.0)*uPointer.w);
        if (pointerUv.x>=0.0 && pointerUv.x<=1.0 && pointerUv.y>=0.0 && pointerUv.y<=1.0) {
          vec4 pointer = texture2D(uPointerImage,pointerUv);
          color = mix(color,pointer.rgb,pointer.a*uPointer.z);
        }
      }
      float border = smoothstep(-1.8, -0.45, d)*0.065;
      color = mix(color, vec3(0.73, 0.66, 0.84), border);
      gl_FragColor = vec4(color*alpha, alpha);
    }
  }
`,
  ),
)
gl.linkProgram(program)
if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program))
gl.useProgram(program)
const locations = Object.fromEntries(
  [
    'uSource',
    'uFocus',
    'uScreen',
    'uOutput',
    'uRotation',
    'uScale',
    'uImage',
    'uOldImage',
    'uPointerImage',
    'uPointer',
    'uCrop',
    'uRadius',
    'uShadow',
    'uSwitch',
    'uUiBlur',
  ].map((name) => [name, gl.getUniformLocation(program, name)]),
)
const buffer = gl.createBuffer()
gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
gl.bufferData(
  gl.ARRAY_BUFFER,
  new Float32Array([-0.07, -0.07, 1.07, -0.07, -0.07, 1.07, -0.07, 1.07, 1.07, -0.07, 1.07, 1.07]),
  gl.STATIC_DRAW,
)
const position = gl.getAttribLocation(program, 'aUv')
gl.enableVertexAttribArray(position)
gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
const texture = gl.createTexture()
gl.bindTexture(gl.TEXTURE_2D, texture)
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
const textureCanvas = document.createElement('canvas')
textureCanvas.width = 2048
textureCanvas.height = 2048
const textureCtx = textureCanvas.getContext('2d', { alpha: false })
textureCtx.imageSmoothingQuality = 'high'
const swipeCanvas = document.createElement('canvas')
swipeCanvas.width = meta.width * meta.pixelRatio
swipeCanvas.height = meta.height * meta.pixelRatio
const swipeCtx = swipeCanvas.getContext('2d', { alpha: false })
function uploadUi(image) {
  textureCtx.drawImage(image, 0, 0, textureCanvas.width, textureCanvas.height)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, textureCanvas)
  gl.generateMipmap(gl.TEXTURE_2D)
}
gl.activeTexture(gl.TEXTURE1)
const oldTexture = gl.createTexture()
gl.bindTexture(gl.TEXTURE_2D, oldTexture)
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
const oldReady = beforeSwitch.decode().then(() => {
  gl.activeTexture(gl.TEXTURE1)
  gl.bindTexture(gl.TEXTURE_2D, oldTexture)
  uploadUi(beforeSwitch)
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, texture)
})
gl.activeTexture(gl.TEXTURE2)
const pointerTexture = gl.createTexture()
gl.bindTexture(gl.TEXTURE_2D, pointerTexture)
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
const pointerReady = pointerImage.decode().then(() => {
  gl.activeTexture(gl.TEXTURE2)
  gl.bindTexture(gl.TEXTURE_2D, pointerTexture)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, pointerImage)
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, texture)
})
gl.activeTexture(gl.TEXTURE0)
gl.bindTexture(gl.TEXTURE_2D, texture)
gl.uniform1i(locations.uImage, 0)
gl.uniform1i(locations.uOldImage, 1)
gl.uniform1i(locations.uPointerImage, 2)
gl.uniform1f(locations.uSwitch, 1)
gl.uniform2f(locations.uSource, meta.width, meta.height)
gl.uniform2f(locations.uOutput, W, H)
gl.viewport(0, 0, W, H)
gl.enable(gl.BLEND)
gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)

// Average shutter samples entirely on the GPU. Running averages preserve identical
// pixel values and avoid the brightness steps of additive 8-bit canvas blending.
const presentProgram = gl.createProgram()
gl.attachShader(
  presentProgram,
  shader(
    gl.VERTEX_SHADER,
    'attribute vec2 aPosition;varying vec2 vUv;void main(){vUv=aPosition*0.5+0.5;gl_Position=vec4(aPosition,0.0,1.0);}',
  ),
)
gl.attachShader(
  presentProgram,
  shader(
    gl.FRAGMENT_SHADER,
    'precision highp float;uniform sampler2D uFrame;varying vec2 vUv;void main(){gl_FragColor=texture2D(uFrame,vUv);}',
  ),
)
gl.linkProgram(presentProgram)
if (!gl.getProgramParameter(presentProgram, gl.LINK_STATUS))
  throw new Error(gl.getProgramInfoLog(presentProgram))
const fullPosition = gl.getAttribLocation(presentProgram, 'aPosition'),
  frameSampler = gl.getUniformLocation(presentProgram, 'uFrame')
const fullBuffer = gl.createBuffer()
gl.bindBuffer(gl.ARRAY_BUFFER, fullBuffer)
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
function target() {
  gl.activeTexture(gl.TEXTURE3)
  const image = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, image)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
  const framebuffer = gl.createFramebuffer()
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, image, 0)
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
    throw new Error('Motion framebuffer is incomplete.')
  return { image, framebuffer }
}
const sampleTarget = target(),
  motionTarget = target()
gl.bindFramebuffer(gl.FRAMEBUFFER, null)
gl.activeTexture(gl.TEXTURE0)
gl.bindTexture(gl.TEXTURE_2D, texture)
function present(image, framebuffer, index) {
  gl.useProgram(presentProgram)
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
  gl.bindBuffer(gl.ARRAY_BUFFER, fullBuffer)
  gl.enableVertexAttribArray(fullPosition)
  gl.vertexAttribPointer(fullPosition, 2, gl.FLOAT, false, 0, 0)
  gl.activeTexture(gl.TEXTURE3)
  gl.bindTexture(gl.TEXTURE_2D, image)
  gl.uniform1i(frameSampler, 3)
  if (index > 0) {
    gl.enable(gl.BLEND)
    gl.blendColor(0, 0, 0, 1 / (index + 1))
    gl.blendFunc(gl.CONSTANT_ALPHA, gl.ONE_MINUS_CONSTANT_ALPHA)
  } else gl.disable(gl.BLEND)
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, texture)
}
const cache = new Map()
const returnStart = meta.returnPositions[0].frame
const returnEnd = meta.returnPositions.find((position) => position.active).frame
const pinnedFrames = new Set([returnStart - 1, returnEnd])
async function liveFrame(t) {
  const frame = Math.max(0, Math.min(meta.count - 1, Math.round(t * meta.fps)))
  if (!cache.has(frame)) {
    const i = new Image()
    i.src = `assets/live/${String(frame).padStart(5, '0')}.jpg`
    cache.set(frame, { image: i, ready: i.decode() })
  }
  const entry = cache.get(frame)
  await entry.ready
  for (const key of cache.keys()) if (!pinnedFrames.has(key) && Math.abs(key - frame) > 3) cache.delete(key)
  return entry.image
}
const returnProgress = (t) => smootherstep((t * FPS - returnStart) / (returnEnd - returnStart))

async function returnFrame(t) {
  const frame = Math.round(t * FPS)
  if (frame < returnStart || frame >= returnEnd) return liveFrame(t)
  const progress = returnProgress(t)
  const width = swipeCanvas.width,
    height = swipeCanvas.height
  const shift = progress * width
  const bottom = Math.round(680 * meta.pixelRatio)
  const homeLeft = (progress - 1) * meta.width
  const barFrame = meta.returnPositions.reduce(
    (closest, position) => {
      if (position.homeLeft === null || position.frame > returnEnd) return closest
      return Math.abs(position.homeLeft - homeLeft) < Math.abs(closest.homeLeft - homeLeft)
        ? position
        : closest
    },
    { frame: returnStart - 1, homeLeft: -meta.width },
  ).frame
  const [home, search, bar] = await Promise.all([
    liveFrame(returnEnd / FPS),
    liveFrame((returnStart - 1) / FPS),
    liveFrame(barFrame / FPS),
  ])
  swipeCtx.drawImage(home, 0, 0, width, bottom, shift - width, 0, width, bottom)
  swipeCtx.drawImage(search, 0, 0, width, bottom, shift, 0, width, bottom)
  swipeCtx.drawImage(bar, 0, bottom, width, height - bottom, 0, bottom, width, height - bottom)
  return swipeCanvas
}
const introCache = new Map()
async function homeFrame(t) {
  const frame = Math.max(0, Math.min(homeIntro.count - 1, Math.round(t * homeIntro.fps)))
  if (!introCache.has(frame)) {
    const image = new Image()
    image.src = `assets/intro/${String(frame).padStart(5, '0')}.jpg`
    introCache.set(frame, { image, ready: image.decode() })
  }
  const entry = introCache.get(frame)
  await entry.ready
  for (const key of introCache.keys()) if (Math.abs(key - frame) > 3) introCache.delete(key)
  return entry.image
}

const rowY = meta.selectedRow.y
const keys = [
  { t: 0, x: 195, y: 410, s: 2.16, rx: 3.5, ry: -7, rz: -1, ox: 566, oy: 980 },
  { t: 0.95, x: 195, y: 415, s: 2.03, rx: 2, ry: -3, rz: -0.3, ox: 540, oy: 950 },
  { t: 1.6, x: 195, y: 420, s: 2.04, rx: 1, ry: -2, rz: 0, ox: 540, oy: 950 },
  { t: 2.18, x: 195, y: Math.max(rowY, 470), s: 2.12, rx: 1, ry: 2, rz: 0, ox: 540, oy: 900 },
  { t: 2.6, x: 195, y: meta.miniCover.y - 15, s: 2.5, rx: 1, ry: 3, rz: 0, ox: 540, oy: 940 },
  { t: 3.2, x: 195, y: 422, s: 2.04, rx: 0, ry: -1, rz: 0, ox: 540, oy: 950 },
  { t: edition.returnSwipeStart, x: 195, y: 422, s: 2.04, rx: 0, ry: -1, rz: 0, ox: 540, oy: 950 },
]
const cameraChannels = ['x', 'y', 's', 'rx', 'ry', 'rz', 'ox', 'oy']
const tangents = Object.fromEntries(
  cameraChannels.map((channel) => {
    const delta = keys.slice(1).map((key, i) => (key[channel] - keys[i][channel]) / (key.t - keys[i].t))
    const slopes = keys.map((key, i) => {
      if (i === 0 || i === keys.length - 1) return 0
      if (delta[i - 1] * delta[i] <= 0) return 0
      const h0 = key.t - keys[i - 1].t,
        h1 = keys[i + 1].t - key.t,
        w0 = 2 * h1 + h0,
        w1 = h1 + 2 * h0
      return (w0 + w1) / (w0 / delta[i - 1] + w1 / delta[i])
    })
    return [channel, slopes]
  }),
)
function camera(t) {
  if (t <= 0) return keys[0]
  if (t >= returnStart / FPS) {
    const progress = returnProgress(t)
    const from = keys.at(-1),
      to = keys[0]
    return Object.fromEntries(
      cameraChannels.map((channel) => [channel, mix(from[channel], to[channel], progress)]),
    )
  }
  let i = keys.findIndex((k) => k.t >= t)
  if (i < 0) return keys.at(-1)
  const b = keys[i],
    a = keys[Math.max(0, i - 1)]
  const span = b.t - a.t,
    p = clamp((t - a.t) / span),
    p2 = p * p,
    p3 = p2 * p
  const result = {}
  for (const channel of cameraChannels)
    result[channel] =
      (2 * p3 - 3 * p2 + 1) * a[channel] +
      (p3 - 2 * p2 + p) * span * tangents[channel][i - 1] +
      (-2 * p3 + 3 * p2) * b[channel] +
      (p3 - p2) * span * tangents[channel][i]
  return result
}
function pointerAt(t, isIntro = false) {
  const gesture = isIntro ? homeIntro.gesture : meta.returnSwipe
  const end = isIntro ? gesture.release : returnEnd / FPS
  const progress = (t - gesture.start) / (end - gesture.start)
  if (progress >= 0 && progress <= 1.1) {
    const eased = isIntro
      ? smootherstep((t - gesture.start) / (end - gesture.start - 1 / FPS))
      : returnProgress(t)
    return {
      x: mix(gesture.from.x, gesture.to.x, eased),
      y: gesture.from.y,
      alpha: Math.min(1, clamp(progress / 0.12), clamp((1.1 - progress) / 0.12)) * 0.9,
      scale: 0.8,
    }
  }
  if (isIntro) return { x: 0, y: 0, alpha: 0, scale: 1 }
  const taps = [
    { at: 70 / FPS, point: meta.best },
    { at: edition.openAt, point: meta.miniCover },
    { at: edition.closeAt, point: meta.closePoint },
  ]
  for (const tap of taps) {
    const p = (t - tap.at) / 0.3
    if (p >= 0 && p <= 1)
      return { ...tap.point, alpha: Math.sin(Math.PI * p) * 0.82, scale: 0.55 + 0.55 * out(p) }
  }
  return { x: 0, y: 0, alpha: 0, scale: 1 }
}
function drawPlane(cam, t, isIntro = false) {
  gl.useProgram(program)
  gl.bindFramebuffer(gl.FRAMEBUFFER, sampleTarget.framebuffer)
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.enableVertexAttribArray(position)
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
  gl.enable(gl.BLEND)
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  gl.clearColor(0, 0, 0, 0)
  gl.clear(gl.COLOR_BUFFER_BIT)
  const pointer = pointerAt(t, isIntro)
  gl.uniform4f(
    locations.uPointer,
    pointer.x - 24 * pointer.scale,
    pointer.y - 24 * pointer.scale,
    pointer.alpha,
    pointer.scale,
  )
  // Samples taken just before the click must still show the previous results,
  // even when this output frame already contains the new captured bitmap.
  const switchedAt = 70 / meta.fps
  const mixingSearch = !isIntro && t >= switchedAt - 1 / FPS
  gl.uniform1f(locations.uSwitch, mixingSearch ? out((t - switchedAt) / 0.28) : 1)
  const gesture = isIntro ? homeIntro.gesture : meta.returnSwipe
  const duration = (isIntro ? gesture.release : returnEnd / FPS) - gesture.start
  const p = clamp((t - gesture.start) / duration)
  const velocity =
    ((isIntro ? Math.abs(gesture.to.x - gesture.from.x) : meta.width) / duration) *
    30 *
    p *
    p *
    (1 - p) *
    (1 - p)
  gl.uniform2f(locations.uUiBlur, Math.min(1.25, (velocity * 0.6) / FPS / 12), meta.miniCover.y - 36)
  gl.uniform2f(locations.uFocus, cam.x, cam.y)
  gl.uniform2f(locations.uScreen, cam.ox, cam.oy)
  gl.uniform1f(locations.uScale, cam.s)
  gl.uniform3f(
    locations.uRotation,
    (cam.rx * Math.PI) / 180,
    (cam.ry * Math.PI) / 180,
    (cam.rz * Math.PI) / 180,
  )
  gl.uniform4f(locations.uCrop, 0, 0, meta.width, meta.height)
  gl.uniform1f(locations.uRadius, 17)
  gl.uniform1f(locations.uShadow, 1)
  gl.drawArrays(gl.TRIANGLES, 0, 6)
  gl.uniform1f(locations.uShadow, 0)
  gl.drawArrays(gl.TRIANGLES, 0, 6)
}
function background(t) {
  ctx.fillStyle = '#070609'
  ctx.fillRect(0, 0, W, H)
  let g = ctx.createRadialGradient(40 + Math.sin(t * 0.24) * 45, -70, 0, 40, -70, 1500)
  g.addColorStop(0, '#7338a842')
  g.addColorStop(0.47, '#3820491a')
  g.addColorStop(1, '#10091300')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, W, H)
  g = ctx.createRadialGradient(1050, 1600, 0, 1050, 1600, 1050)
  g.addColorStop(0, '#53348022')
  g.addColorStop(1, '#0000')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, W, H)
  g = ctx.createRadialGradient(540, 1250, 30, 540, 1250, 850)
  g.addColorStop(0, '#41344c10')
  g.addColorStop(1, '#0000')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, W, H)
}
async function paintScreen(image, t, isIntro) {
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, texture)
  uploadUi(image)
  const samples = 8
  for (let j = 0; j < samples; j++) {
    const at = Math.max(0, t - ((1 - j / (samples - 1)) * 0.6) / FPS)
    drawPlane(isIntro ? camera(0) : camera(at), at, isIntro)
    present(sampleTarget.image, motionTarget.framebuffer, j)
  }
  present(motionTarget.image, null, 0)
  ctx.drawImage(plane, 0, 0)
}

window.renderFrame = async (t) => {
  t = Math.max(0, Math.min(DURATION - 1 / FPS, t))
  await oldReady
  await pointerReady
  if (t < INTRO_DURATION) {
    const openingTime = t + edition.openingLead
    background(0)
    await paintScreen(await homeFrame(openingTime), openingTime, true)
    return
  }
  const liveTime = t - INTRO_DURATION
  const phase = clamp((liveTime - (edition.sourceDuration - 0.95)) / 0.45)
  const settle = phase * phase * (3 - 2 * phase)
  background(liveTime * (1 - settle))
  await paintScreen(await returnFrame(liveTime), liveTime, false)
}
window.ready = Promise.all([intro.decode(), oldReady, pointerReady]).then(() => window.renderFrame(0))
