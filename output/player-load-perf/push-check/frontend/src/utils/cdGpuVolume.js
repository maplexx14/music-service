import { discSpinAnimationDegrees } from './discSpin.js'

// Present the prepared shell with one small WebGL pass. Firefox otherwise
// composites every overlapping CSS 3D surface as a separate render task.
export function cdGpuVolumeSources(parent) {
  return [...parent.querySelectorAll('.cd-deck-volume-face,.cd-deck-software-disc canvas,.cd-deck-software-control')]
    .filter(source => {
      const disc = source.closest('.cd-deck-software-disc')
      if (!disc || source.classList.contains('cd-deck-disc-reflection')) return true
      // A completed belt may retain the old disc until React places its queue
      // slot. It must never be projected back onto the active disc plane.
      return source.parentElement?.dataset.cdDiscSlot === 'current' && source.parentElement.parentElement === disc
    })
}

export function createCdGpuVolume({ parent, motionElement, frameRate = 60, pixelRatioCap = 1.5, getDiscTransform, getMotionTransform, getMotionEnvelope, onDiscProjection, onFailure }) {
  const canvas = document.createElement('canvas')
  canvas.className = 'cd-deck-gpu-volume'
  // Perspective transforms need multisampling as well as filtered textures
  // to keep the projected shell's silhouette smooth.
  const gl = canvas.getContext('webgl', { alpha: true, antialias: true, premultipliedAlpha: true, powerPreference: 'low-power' })
  if (!gl) return null
  const still = document.createElement('canvas')
  still.className = 'cd-deck-gpu-volume cd-deck-gpu-still'
  still.style.display = 'none'
  const stillContext = still.getContext('2d')
  const shader = (kind, source) => {
    const result = gl.createShader(kind)
    gl.shaderSource(result, source); gl.compileShader(result)
    if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(result))
    return result
  }
  const vertex = shader(gl.VERTEX_SHADER, `attribute vec4 point; attribute vec2 uv; attribute float faceBias; uniform mat4 projection; uniform mat4 layerTransform; uniform vec2 size; uniform vec2 cropOrigin; uniform float depthBias; varying highp vec2 texUv;
    void main(){vec4 p=projection*layerTransform*point;gl_Position=vec4(2.0*(p.x-cropOrigin.x*p.w)/size.x-p.w,p.w-2.0*(p.y-cropOrigin.y*p.w)/size.y,-p.z/2048.0-(depthBias+faceBias)*p.w,p.w);texUv=uv;}`)
  // Atlas UVs must retain subtexel precision. mediump quantizes long, narrow
  // seams into visible steps as the wall turns, regardless of MSAA coverage.
  const fragment = shader(gl.FRAGMENT_SHADER, `precision highp float;uniform sampler2D surface;uniform sampler2D discReflection;uniform float combineDisc;uniform float discSeatLight;uniform vec2 discRotation;varying highp vec2 texUv;
    void main(){
      vec4 color;
      if(combineDisc>0.5){
        vec2 p=texUv-0.5;
        vec2 artworkUv=vec2(discRotation.x*p.x-discRotation.y*p.y,discRotation.y*p.x+discRotation.x*p.y)+0.5;
        vec4 artwork=texture2D(surface,artworkUv);
        // Rotating a texture can leave its square. CLAMP_TO_EDGE then extends
        // partially opaque rim texels into diagonal bands outside the disc.
        // Preserve the transparent outside area of the original rotated quad.
        vec2 inside=step(vec2(0.0),artworkUv)*step(artworkUv,vec2(1.0));
        artwork*=inside.x*inside.y;
        vec4 reflection=texture2D(discReflection,texUv);
        color=reflection+artwork*(1.0-reflection.a);
        float glow=(1.0-smoothstep(0.15,0.75,(texUv.x+texUv.y)*0.5))*discSeatLight;
        color.rgb+=vec3(glow)*color.a;
      }else color=texture2D(surface,texUv);
      if(color.a<0.001)discard;gl_FragColor=color;
    }`)
  const program = gl.createProgram()
  gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program))
  gl.useProgram(program)
  const buffer = gl.createBuffer(), point = gl.getAttribLocation(program, 'point'), uv = gl.getAttribLocation(program, 'uv')
  const faceBias = gl.getAttribLocation(program, 'faceBias'), shellBuffer = gl.createBuffer()
  const shellAtlas = document.createElement('canvas'), shellTexture = gl.createTexture()
  const identity = new DOMMatrix().toFloat32Array()
  let shellKey = null, shellVertices = 0
  const bindVertices = (vertices, stride, biased = false) => {
    gl.bindBuffer(gl.ARRAY_BUFFER, vertices)
    gl.vertexAttribPointer(point, 4, gl.FLOAT, false, stride, 0)
    gl.vertexAttribPointer(uv, 2, gl.FLOAT, false, stride, 16)
    if (biased) { gl.enableVertexAttribArray(faceBias); gl.vertexAttribPointer(faceBias, 1, gl.FLOAT, false, stride, 24) }
    else { gl.disableVertexAttribArray(faceBias); gl.vertexAttrib1f(faceBias, 0) }
  }
  const projectionLocation = gl.getUniformLocation(program, 'projection'), layerLocation = gl.getUniformLocation(program, 'layerTransform'), sizeLocation = gl.getUniformLocation(program, 'size')
  const depthBiasLocation = gl.getUniformLocation(program, 'depthBias')
  const cropOriginLocation = gl.getUniformLocation(program, 'cropOrigin')
  const combineDiscLocation = gl.getUniformLocation(program, 'combineDisc')
  const discRotationLocation = gl.getUniformLocation(program, 'discRotation')
  const discSeatLightLocation = gl.getUniformLocation(program, 'discSeatLight')
  gl.uniform1i(gl.getUniformLocation(program, 'surface'), 0)
  gl.uniform1i(gl.getUniformLocation(program, 'discReflection'), 1)
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    0,0,0,1,0,1, 1,0,0,1,1,1, 1,1,0,1,1,0,
    0,0,0,1,0,1, 1,1,0,1,1,0, 0,1,0,1,0,0,
  ]), gl.STATIC_DRAW)
  gl.enableVertexAttribArray(point); gl.enableVertexAttribArray(uv)
  gl.vertexAttribPointer(point, 4, gl.FLOAT, false, 24, 0); gl.vertexAttribPointer(uv, 2, gl.FLOAT, false, 24, 16)
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
  parent.append(canvas)
  parent.append(still)
  let layers = [], visible = false, running = false, frame = 0, lastAt = -Infinity, draws = 0, disposed = false, failed = false
  let uploads = 0, uploadedBytes = 0
  let layoutKey = '', projectionKey = '', projection, lastDiscProjection = ''
  let envelopeKey = '', envelopeMatrices, envelopeBounds
  const fail = error => {
    if (disposed || failed) return
    failed = true; visible = running = false
    if (frame) { cancelAnimationFrame(frame); frame = 0 }
    parent.classList.remove('has-gpu-volume'); canvas.style.display = still.style.display = 'none'
    delete parent.dataset.cdGpuVolume
    onFailure?.(error)
  }
  canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); fail(new Error('CD compositor context lost')) })
  const textureKey = source => `${source.width}:${source.height}:${source.dataset.cdTextureVersion || 0}`
  const upload = layer => {
    let source = layer.source
    if (source.style.clipPath?.startsWith('polygon(')) {
      const masked = document.createElement('canvas')
      masked.width = source.width; masked.height = source.height
      const ctx = masked.getContext('2d'), points = source.style.clipPath.slice(8, -1).split(',').map(p => p.trim().split(/\s+/).map(parseFloat))
      ctx.beginPath(); points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath(); ctx.clip(); ctx.drawImage(source, 0, 0)
      source = masked
    }
    gl.bindTexture(gl.TEXTURE_2D, layer.texture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
    // Prefilter the disc once rather than supersampling every presentation.
    // WebGL 1 mipmaps require power-of-two textures; other decals stay linear.
    const disc = layer.source.closest('.cd-deck-software-disc')
    if (disc && (source.width & (source.width - 1)) === 0 && (source.height & (source.height - 1)) === 0) {
      gl.generateMipmap(gl.TEXTURE_2D)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
    } else gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    uploads++; uploadedBytes += source.width * source.height * 4
    layer.revision = textureKey(layer.source)
  }
  function refresh(full = false) {
    if (full) shellKey = null
    const sources = cdGpuVolumeSources(parent)
      .sort((a, b) => Number(b.classList.contains('cd-deck-volume-face')) - Number(a.classList.contains('cd-deck-volume-face')))
    const previous = new Map(layers.map(layer => [layer.source, layer]))
    layers = sources.map(source => {
      const old = previous.get(source)
      if (old) { previous.delete(source); if (full) old.revision = null; return old }
      if (source.classList.contains('cd-deck-volume-face')) return { source, texture: null, revision: -1 }
      const texture = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      return { source, texture, revision: -1 }
    })
    for (const layer of previous.values()) if (layer.texture) gl.deleteTexture(layer.texture)
  }
  function drawShell() {
    const sources = layers.map(layer => layer.source).filter(source => source.classList.contains('cd-deck-volume-face') &&
      source.width > 1 && source.height > 1 && source.style.display !== 'none' && source.style.visibility !== 'hidden')
    if (!sources.length) return
    const key = sources.map(source => `${textureKey(source)}:${source.style.transform}`).join('|')
    if (shellKey !== key) {
      const limit = gl.getParameter(gl.MAX_TEXTURE_SIZE)
      const maxSize = Number.isFinite(limit) ? limit : 4096
      const packed = []
      let x = 2, y = 2, rowHeight = 0, atlasWidth = 1
      for (const source of sources) {
        if (x + source.width + 2 > maxSize) { x = 2; y += rowHeight + 4; rowHeight = 0 }
        packed.push({ source, x, y })
        x += source.width + 4; rowHeight = Math.max(rowHeight, source.height)
        atlasWidth = Math.max(atlasWidth, x - 2)
      }
      shellAtlas.width = atlasWidth; shellAtlas.height = y + rowHeight + 2
      const ctx = shellAtlas.getContext('2d'), vertices = []
      for (const { source, x, y } of packed) {
        ctx.drawImage(source, x, y)
        // Replicate texture borders so atlas filtering matches CLAMP_TO_EDGE
        // without shrinking a face's pixels or leaking a neighbouring wall.
        ctx.drawImage(source, 0, 0, 1, source.height, x - 2, y, 2, source.height)
        ctx.drawImage(source, source.width - 1, 0, 1, source.height, x + source.width, y, 2, source.height)
        ctx.drawImage(source, 0, 0, source.width, 1, x, y - 2, source.width, 2)
        ctx.drawImage(source, 0, source.height - 1, source.width, 1, x, y + source.height, source.width, 2)
        for (const [u, v] of [[0,0],[1,0],[0,1],[1,1]]) {
          ctx.drawImage(source, u * (source.width - 1), v * (source.height - 1), 1, 1,
            x + (u ? source.width : -2), y + (v ? source.height : -2), 2, 2)
        }
        const matrix = new DOMMatrix(source.style.transform === 'none' ? undefined : source.style.transform)
        for (const [u, v] of [[0,0],[1,0],[1,1],[0,0],[1,1],[0,1]]) {
          const p = matrix.transformPoint({ x: u * source.width, y: v * source.height, z: 0, w: 1 })
          vertices.push(p.x, p.y, p.z, p.w,
            (x + u * source.width) / shellAtlas.width,
            1 - (y + v * source.height) / shellAtlas.height,
            source.classList.contains('is-panel') ? 0.00005 : 0)
        }
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, shellBuffer)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW)
      gl.bindTexture(gl.TEXTURE_2D, shellTexture)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, shellAtlas)
      uploads++; uploadedBytes += shellAtlas.width * shellAtlas.height * 4
      shellVertices = vertices.length / 7; shellKey = key
    }
    bindVertices(shellBuffer, 28, true)
    gl.uniformMatrix4fv(layerLocation, false, identity); gl.uniform1f(depthBiasLocation, 0)
    gl.uniform1f(combineDiscLocation, 0)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, shellTexture)
    gl.enable(gl.DEPTH_TEST); gl.depthMask(true)
    gl.enable(gl.CULL_FACE); gl.frontFace(gl.CW); gl.cullFace(gl.BACK)
    gl.drawArrays(gl.TRIANGLES, 0, shellVertices)
    bindVertices(buffer, 24)
  }
  function paint(at = performance.now()) {
    if (!visible || disposed || gl.isContextLost()) return
    const width = parent.clientWidth, height = parent.clientHeight
    if (!width || !height) return
    const originX = parseFloat(motionElement.style.getPropertyValue('--cd-motion-origin-x')) || width / 2
    const originY = parseFloat(motionElement.style.getPropertyValue('--cd-motion-origin-y')) || height / 2
    // Reserve a fixed envelope for the full tilt and track-skip motion.
    // Transparent hero margins do not need a multisampled drawing buffer.
    let cropWidth = Math.min(width, (parseFloat(motionElement.style.getPropertyValue('--cd-crop-width')) || width) * 1.3)
    let cropHeight = Math.min(height, (parseFloat(motionElement.style.getPropertyValue('--cd-crop-height')) || height) * 1.3)
    let cropX = Math.max(0, Math.min(width - cropWidth, originX - cropWidth / 2))
    let cropY = Math.max(0, Math.min(height - cropHeight, originY - cropHeight / 2))
    const envelope = getMotionEnvelope?.()
    if (envelope?.length) {
      const sources = layers.map(layer => layer.source).filter(source => source.classList.contains('cd-deck-volume-face'))
      const key = `${width}:${height}:${originX}:${originY}:` + sources.map(source => `${textureKey(source)}:${source.style.transform}`).join('|')
      if (envelopeKey !== key || envelopeMatrices !== envelope) {
        envelopeKey = key; envelopeMatrices = envelope
        const points = sources.flatMap(source => {
          const matrix = new DOMMatrix(source.style.transform === 'none' ? undefined : source.style.transform)
          return [[0,0],[source.width,0],[source.width,source.height],[0,source.height]].map(([x,y]) => matrix.transformPoint({x,y}))
        })
        let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity
        for (const matrix of envelope) {
          const pose = new DOMMatrix().translate(originX,originY).multiply(matrix).translate(-originX,-originY)
          for (const point of points) {
            const p = pose.transformPoint(point)
            if (p.w <= 0 || !Number.isFinite(p.x / p.w + p.y / p.w)) continue
            left = Math.min(left,p.x/p.w); top = Math.min(top,p.y/p.w)
            right = Math.max(right,p.x/p.w); bottom = Math.max(bottom,p.y/p.w)
          }
        }
        // Fixed across a complete playback cycle and extreme skips. Preserve
        // antialiasing while avoiding a large transparent MSAA buffer.
        const x = Math.max(0,Math.floor(left-12)), y = Math.max(0,Math.floor(top-12))
        envelopeBounds = right > left && bottom > top ? {x,y,width:Math.min(width,Math.ceil(right+12))-x,height:Math.min(height,Math.ceil(bottom+12))-y} : null
      }
      if (envelopeBounds?.width > 0 && envelopeBounds?.height > 0) {
        cropX = envelopeBounds.x; cropY = envelopeBounds.y; cropWidth = envelopeBounds.width; cropHeight = envelopeBounds.height
      }
    }
    // A modest density boost smooths the rounded shell's projected edges.
    const ratio = Math.min(pixelRatioCap, Math.max(1.5, window.devicePixelRatio || 1), Math.sqrt(1_500_000 / (cropWidth * cropHeight)))
    const pixelsX = Math.max(1, Math.round(cropWidth * ratio)), pixelsY = Math.max(1, Math.round(cropHeight * ratio))
    if (canvas.width !== pixelsX || canvas.height !== pixelsY) { canvas.width = pixelsX; canvas.height = pixelsY }
    const nextLayoutKey = `${cropX}:${cropY}:${cropWidth}:${cropHeight}`
    if (layoutKey !== nextLayoutKey) {
      layoutKey = nextLayoutKey
      Object.assign(canvas.style, { left: `${cropX}px`, top: `${cropY}px`, width: `${cropWidth}px`, height: `${cropHeight}px`, right: 'auto', bottom: 'auto' })
    }
    gl.viewport(0, 0, pixelsX, pixelsY); gl.useProgram(program)
    gl.uniform2f(sizeLocation, cropWidth, cropHeight)
    gl.uniform2f(cropOriginLocation, cropX, cropY)
    const transform = getMotionTransform?.() || getComputedStyle(motionElement).transform
    const nextProjectionKey = `${originX}:${originY}:${transform}`
    if (projectionKey !== nextProjectionKey) {
      projectionKey = nextProjectionKey
      projection = new DOMMatrix().translate(originX, originY).multiply(new DOMMatrix(transform === 'none' ? undefined : transform)).translate(-originX, -originY)
    }
    gl.uniformMatrix4fv(projectionLocation, false, projection.toFloat32Array())
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    try { drawShell() } catch (error) { fail(error); return }
    let discQuad
    const preparedDiscTransform = getDiscTransform?.()
    const reflectionLayer = layers.find(layer => layer.source.classList.contains('cd-deck-disc-reflection'))
    const reflectionOwner = reflectionLayer?.source.closest('.cd-deck-software-disc')
    const artworkLayer = reflectionOwner && layers.find(layer => !layer.source.classList.contains('cd-deck-disc-reflection') && layer.source.closest('.cd-deck-software-disc') === reflectionOwner)
    const pairReady = artworkLayer && reflectionLayer.source.width > 1 && reflectionLayer.source.height > 1 &&
      reflectionLayer.source.style.display !== 'none' && reflectionLayer.source.style.visibility !== 'hidden' &&
      artworkLayer.source.width > 1 && artworkLayer.source.height > 1 && artworkLayer.source.style.display !== 'none' && artworkLayer.source.style.visibility !== 'hidden'
    for (const layer of layers) {
      const source = layer.source, disc = source.closest('.cd-deck-software-disc')
      if (source.classList.contains('cd-deck-volume-face')) continue
      if (source.width < 2 || source.height < 2 || source.style.display === 'none' || source.style.visibility === 'hidden' || disc?.style.visibility === 'hidden') continue
      if (pairReady && layer === reflectionLayer) continue
      const combined = Boolean(pairReady && layer === artworkLayer && disc)
      const owner = disc || source
      const layerTransform = disc && preparedDiscTransform || owner.style.transform
      const cssWidth = disc ? 512 : source.width, cssHeight = disc ? 512 : source.height
      const baseKey = `${layerTransform}:${cssWidth}:${cssHeight}`
      if (baseKey !== layer.baseKey) {
        layer.baseKey = baseKey
        layer.base = new DOMMatrix(layerTransform === 'none' ? undefined : layerTransform)
        layer.scaled = layer.base.scale(cssWidth, cssHeight).toFloat32Array()
      }
      let matrix = layer.base, uniform = layer.scaled
      if (disc) {
        const seating = source.parentElement?.getAnimations?.().find(a => a.id === 'cd-disc-seat' && a.playState === 'running')
        const progress = seating?.effect?.getComputedTiming().progress
        if (Number.isFinite(progress)) {
          const scale = progress <= 0.55 ? 1.012 - 0.014 * progress / 0.55 : 0.998 + 0.002 * (progress - 0.55) / 0.45
          matrix = matrix.translate(cssWidth / 2, cssHeight / 2).scale(scale).translate(-cssWidth / 2, -cssHeight / 2)
          uniform = matrix.scale(cssWidth, cssHeight).toFloat32Array()
        }
        const light = disc.querySelector?.('.cd-deck-disc-seat-light')?.getAnimations?.().find(a => a.id === 'cd-disc-seat-light' && a.playState === 'running')
        const lightProgress = light?.effect?.getComputedTiming().progress
        gl.uniform1f(discSeatLightLocation, Number.isFinite(lightProgress) ? (lightProgress <= 0.35 ? lightProgress / 0.35 : (1 - lightProgress) / 0.65) * 0.24 : 0)
      } else gl.uniform1f(discSeatLightLocation, 0)
      if (disc && !source.classList.contains('cd-deck-disc-reflection')) {
        if (!layer.spin || layer.spin.playState === 'idle') layer.spin = source.getAnimations().find(a => a.id === 'cd-software-disc-spin')
        const ramp = source.getAnimations().find(a => a.id === 'cd-disc-spin-up' && a.playState === 'running')
        const angle = discSpinAnimationDegrees(ramp || layer.spin)
        if (combined) gl.uniform2f(discRotationLocation, Math.cos(angle * Math.PI / 180), Math.sin(angle * Math.PI / 180))
        else {
          matrix = matrix.translate(cssWidth / 2, cssHeight / 2).rotate(angle).translate(-cssWidth / 2, -cssHeight / 2)
          uniform = matrix.scale(cssWidth, cssHeight).toFloat32Array()
        }
      }
      if (disc && (combined || source.classList.contains('cd-deck-disc-reflection'))) discQuad = [[0,0],[cssWidth,0],[cssWidth,cssHeight],[0,cssHeight]].map(([x,y]) => { const q = projection.transformPoint(matrix.transformPoint({x,y})); return { x:q.x/q.w,y:q.y/q.w } })
      gl.uniformMatrix4fv(layerLocation, false, uniform)
      gl.uniform1f(combineDiscLocation, combined ? 1 : 0)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, layer.texture)
      if (layer.revision !== textureKey(source)) {
        try { upload(layer) } catch (error) { fail(error); return }
      }
      if (combined) {
        gl.activeTexture(gl.TEXTURE1)
        gl.bindTexture(gl.TEXTURE_2D, reflectionLayer.texture)
        if (reflectionLayer.revision !== textureKey(reflectionLayer.source)) {
          try { upload(reflectionLayer) } catch (error) { fail(error); return }
        }
        gl.activeTexture(gl.TEXTURE0)
      }
      const reflection = source.classList.contains('cd-deck-disc-reflection')
      const shell = source.classList.contains('cd-deck-volume-face')
      // Live pixels share the captured front plane. Bias their depth by a
      // fraction of a CSS pixel so rounding cannot expose the old bitmap.
      gl.uniform1f(depthBiasLocation, source.classList.contains('cd-deck-volume-face') ? (source.classList.contains('is-panel') ? 0.00005 : 0) : reflection ? 0.0002 : 0.0001)
      // The shell owns physical depth. Live front decals follow its plane
      // and must not compete with the shell's separately captured pixels.
      if (shell) {
        gl.enable(gl.DEPTH_TEST)
        gl.enable(gl.CULL_FACE); gl.frontFace(gl.CW); gl.cullFace(gl.BACK)
      } else {
        gl.disable(gl.DEPTH_TEST)
        gl.disable(gl.CULL_FACE)
      }
      gl.depthMask(shell)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
    }
    gl.depthMask(true)
    gl.enable(gl.DEPTH_TEST)
    if (discQuad && onDiscProjection) {
      const key = discQuad.map(p => `${p.x}:${p.y}`).join('|')
      if (lastDiscProjection !== key) { lastDiscProjection = key; onDiscProjection(discQuad) }
    }
    // Resolve the WebGL surface once when paused. Repeated page composition
    // then uses an ordinary bitmap without presenting the MSAA buffer again.
    if (!running && stillContext && visible) {
      if (still.width !== pixelsX || still.height !== pixelsY) { still.width = pixelsX; still.height = pixelsY }
      Object.assign(still.style, { left: `${cropX}px`, top: `${cropY}px`, width: `${cropWidth}px`, height: `${cropHeight}px`, right: 'auto', bottom: 'auto', display: 'block' })
      stillContext.clearRect(0, 0, pixelsX, pixelsY)
      stillContext.drawImage(canvas, 0, 0)
      canvas.style.display = 'none'
    }
    draws++; lastAt = at
  }
  function tick(at) {
    frame = 0
    if (!running || !visible || disposed) return
    const interval = frameRate > 0 ? 1000 / frameRate : 0
    const cadenceAt = interval ? Math.floor((at + 0.001) / interval) * interval : at
    if (!interval || cadenceAt > lastAt + 0.5) {
      paint(at)
      // Match the absolute timeline used by capped native progress animations.
      // Both surfaces update on the same display refresh, even on 144Hz panels.
      lastAt = cadenceAt
    }
    if (running && visible) frame = requestAnimationFrame(tick)
  }
  return {
    refresh,
    sync(show, animate) {
      if (failed || disposed) return
      const changed = visible !== Boolean(show)
      visible = Boolean(show); running = Boolean(animate)
      parent.classList.toggle('has-gpu-volume', visible)
      // React owns the scene's className and rewrites it during pointer
      // state changes. Keep presentation ownership in an independent attribute.
      if (visible) parent.dataset.cdGpuVolume = 'true'
      else delete parent.dataset.cdGpuVolume
      canvas.style.display = visible ? 'block' : 'none'
      still.style.display = 'none'
      if (visible && (changed || !running)) paint()
      if (visible && running && !frame) frame = requestAnimationFrame(tick)
      if ((!visible || !running) && frame) { cancelAnimationFrame(frame); frame = 0 }
    },
    status: () => ({ visible, running, failed, draws, uploads, uploadedBytes, width: canvas.width, height: canvas.height }),
    dispose() {
      disposed = true; if (frame) cancelAnimationFrame(frame)
      for (const layer of layers) if (layer.texture) gl.deleteTexture(layer.texture)
      shellAtlas.width = shellAtlas.height = 0
      gl.deleteTexture(shellTexture); gl.deleteBuffer(shellBuffer)
      gl.deleteBuffer(buffer); gl.deleteProgram(program); gl.deleteShader(vertex); gl.deleteShader(fragment)
      still.width = still.height = 0; still.remove()
      parent.classList.remove('has-gpu-volume'); canvas.remove(); gl.getExtension('WEBGL_lose_context')?.loseContext()
      delete parent.dataset.cdGpuVolume
    },
  }
}



