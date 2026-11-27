import assert from 'node:assert/strict'
import test from 'node:test'
import { createCdGpuVolume, cdGpuVolumeSources } from '../src/utils/cdGpuVolume.js'

test('the returning GPU presenter excludes the old cover retained inside the completed belt', () => {
  const disc = {}
  const currentSlot = { dataset: { cdDiscSlot: 'current' }, parentElement: disc }
  const belt = { dataset: {}, parentElement: disc }
  const departingSlot = { dataset: { cdDiscSlot: 'current' }, parentElement: belt }
  const source = (parent, owner, reflection = false) => ({ parentElement: parent,
    closest: () => owner, classList: { contains: name => reflection && name === 'cd-deck-disc-reflection' } })
  const current = source(currentSlot, disc)
  const old = source(departingSlot, disc)
  const queued = source(belt, disc)
  const reflection = source(disc, disc, true)
  const shell = source(null, null)
  const control = source(null, null)
  const parent = { querySelectorAll: () => [shell, current, reflection, old, queued, control] }
  assert.deepEqual(cdGpuVolumeSources(parent), [shell, current, reflection, control])
  assert.equal(old.parentElement, departingSlot, 'Excluding the old cover preserves its queue handoff')
})

test('GPU composition reuses geometry and textures and releases all work on hide/disposal', () => {
  const saved = Object.fromEntries(['document','window','DOMMatrix','getComputedStyle','requestAnimationFrame','cancelAnimationFrame'].map(k => [k,globalThis[k]]))
  const calls = { uploads: 0, geometry: 0, draws: 0, texturesDeleted: 0, mipmaps: 0 }, frames = new Map()
  const minFilters = []
  let next = 0, failures = 0, depthTest = false, styleReads = 0
  const drawDepth = []
  const matrices = []
  const events = new Map()
  const canvases = []
  const gl = new Proxy({}, { get: (_, name) => {
    if (/^[A-Z_]+$/.test(name)) return name
    if (name === 'getShaderParameter' || name === 'getProgramParameter') return () => true
    if (name === 'isContextLost') return () => false
    if (name === 'getExtension') return () => ({ loseContext() {} })
    return (...args) => {
      if (name === 'texImage2D') calls.uploads++
      if (name === 'bufferData') calls.geometry++
      if (name === 'generateMipmap') calls.mipmaps++
      if (name === 'texParameteri' && args[1] === 'TEXTURE_MIN_FILTER') minFilters.push(args[2])
      if (name === 'enable' && args[0] === 'DEPTH_TEST') depthTest = true
      if (name === 'disable' && args[0] === 'DEPTH_TEST') depthTest = false
      if (name === 'drawArrays') { calls.draws++; drawDepth.push(depthTest) }
      if (name === 'deleteTexture') calls.texturesDeleted++
      return { name, args }
    }
  } })
  const cropProperties = {}
  const classes = new Set()
  const sources = [0,1].map(index => ({ width:16,height:16,style:{transform:'',display:'',visibility:''},dataset:{},closest:()=>null,classList:{contains:name=>index===1 && name==='cd-deck-volume-face'} }))
  const discOwner = {style:{transform:'stale-skip-pose'}}
  sources[0].closest = () => discOwner
  sources[0].parentElement = { dataset: { cdDiscSlot: 'current' }, parentElement: discOwner }
  sources[0].getAnimations = () => []
  const parent = { dataset:{},clientWidth:100,clientHeight:50,append(){},querySelectorAll:()=>sources,classList:{toggle:(k,v)=>v?classes.add(k):classes.delete(k),remove:k=>classes.delete(k)} }
  try {
    globalThis.document = { createElement: () => {
      const requests = []
      const canvas = { style:{},requests,getContext:(...args)=>{requests.push(args);return gl},addEventListener:(name,callback)=>events.set(name,callback),remove(){} }
      canvases.push(canvas)
      return canvas
    } }
    globalThis.window = { devicePixelRatio:1 }
    globalThis.DOMMatrix = class { constructor(value){matrices.push(value)} translate(){return this} multiply(){return this} scale(){return this} rotate(){return this} transformPoint(p){return {...p,w:1}} toFloat32Array(){return new Float32Array(16)} }
    globalThis.getComputedStyle = () => { styleReads++; return { transform:'none' } }
    globalThis.requestAnimationFrame = callback => { frames.set(++next,callback); return next }
    globalThis.cancelAnimationFrame = id => frames.delete(id)
    const api = createCdGpuVolume({parent,motionElement:{style:{getPropertyValue:k=>cropProperties[k] || ''}},getDiscTransform:()=>'current-chassis-disc-plane',getMotionTransform:()=>'sampled-motion',onFailure:()=>failures++})
    api.refresh(); api.sync(true,true)
    assert.equal(canvases[0].requests[0][1].antialias,true,'Native-density presentation must retain MSAA')
    assert.equal(api.status().width,150,'A 1x display lightly supersamples the rounded contour')
    assert.equal(api.status().height,75)
    assert.equal(parent.dataset.cdGpuVolume,'true')
    classes.clear()
    assert.equal(parent.dataset.cdGpuVolume,'true','A React className update cannot expose the original shell')
    assert.equal(calls.uploads,2)
    assert.equal(calls.mipmaps,1,'The static disc texture is prefiltered once')
    assert.equal(calls.geometry,2)
    assert.deepEqual(drawDepth,[true,false],'Shell depth is resolved before live pixels, regardless of DOM insertion order')
    assert.ok(matrices.includes('current-chassis-disc-plane'))
    assert.ok(!matrices.includes('stale-skip-pose'),'A remounted cover cannot restore an old skip projection')
    const tick = () => { const [id,callback]=frames.entries().next().value;frames.delete(id);callback(performance.now()+100+next*40) }
    tick(); tick()
    assert.equal(styleReads,0,'Steady GPU playback must not synchronously resolve CSS styles')
    assert.equal(calls.uploads,2,'Static surfaces are not uploaded on each animation frame')
    assert.equal(calls.geometry,2,'Turning the shell only updates uniforms')
    assert.equal(calls.mipmaps,1,'Playback cannot rebuild mipmaps on every frame')
    const cadenceStart = performance.now() + 500, cadenceDraws = calls.draws
    for (let index = 1; index <= 144; index++) {
      const [id,callback] = frames.entries().next().value
      frames.delete(id); callback(cadenceStart + index * 1000 / 144)
    }
    const presented = (calls.draws - cadenceDraws) / sources.length
    assert.ok(presented >= 59 && presented <= 61, `A 144Hz display keeps the 60fps presentation budget (${presented} frames)`)
    sources[1].dataset.cdTextureVersion='1'
    api.refresh(); tick()
    assert.equal(calls.uploads,3,'Only changed live pixels upload again')
    Object.assign(cropProperties, { '--cd-crop-width': '30', '--cd-crop-height': '20' })
    api.sync(true,false)
    assert.equal(canvases[0].style.display,'none','Paused playback releases the WebGL presentation surface')
    assert.equal(canvases[1].style.display,'block','A resolved bitmap preserves the paused image')
    assert.equal(frames.size,0,'A paused bitmap needs no drawing clock')
    assert.equal(api.status().width,59,'Transparent stage margins do not consume the GPU drawing buffer')
    assert.equal(api.status().height,39)
    window.devicePixelRatio = 2
    api.sync(true,false)
    assert.equal(api.status().width,59,'High-density displays retain the existing quality cap')
    assert.equal(api.status().height,39)
    window.devicePixelRatio = 1
    api.sync(true,true)
    assert.equal(canvases[0].style.display,'block','Resuming restores the live compositor')
    assert.equal(canvases[1].style.display,'none','The paused snapshot cannot cover resumed playback')
    const shellDraws = calls.draws
    sources.push({ ...sources[1], style: { ...sources[1].style } })
    api.refresh(); api.sync(true,false)
    assert.equal(calls.draws-shellDraws,2,'Multiple shell faces share one submission before the live disc')
    const draws=calls.draws
    api.sync(false,false)
    assert.equal(frames.size,0)
    assert.equal(calls.draws,draws)
    assert.equal(classes.size,0)
    assert.equal(parent.dataset.cdGpuVolume,undefined)
    api.sync(true,true)
    let prevented = false
    events.get('webglcontextlost')({preventDefault(){prevented=true}})
    assert.ok(prevented)
    assert.equal(failures,1)
    assert.equal(api.status().failed,true)
    assert.equal(frames.size,0,'Context loss stops the drawing clock before fallback')
    api.sync(true,true)
    assert.equal(frames.size,0,'A failed compositor cannot resume')
    api.dispose()
    assert.equal(calls.texturesDeleted,2)
    assert.equal(frames.size,0)
    parent.clientWidth = 0
    const delayed = createCdGpuVolume({parent,motionElement:{style:{getPropertyValue:()=>''}}})
    delayed.refresh(); delayed.sync(true,true)
    tick()
    const beforeLayout = calls.draws
    parent.clientWidth = 100
    tick()
    assert.ok(calls.draws > beforeLayout,'Starting before layout has a width cannot poison the animation clock')
    delayed.dispose()
    assert.equal(frames.size,0)
    for (const hz of [60,90,120,144,165,240]) {
      const smooth = createCdGpuVolume({parent,motionElement:{style:{getPropertyValue:()=>''}},frameRate:0})
      smooth.refresh(); smooth.sync(true,true)
      const initial = smooth.status().draws, uploads = calls.uploads, geometry = calls.geometry
      const startedAt = performance.now()
      for (let index = 1; index <= hz; index++) {
        const [id,callback] = frames.entries().next().value
        frames.delete(id); callback(startedAt + index * 1000 / hz)
      }
      assert.equal(smooth.status().draws-initial,hz,`Uncapped GPU motion presents every ${hz} Hz refresh`)
      assert.equal(calls.uploads,uploads,'Faster motion reuses the uploaded textures')
      assert.equal(calls.geometry,geometry,'Faster motion reuses the prepared shell geometry')
      smooth.sync(true,false)
      assert.equal(frames.size,0,'Pausing stops the uncapped compositor')
      smooth.dispose()
    }
    const envelope = [new DOMMatrix()]
    const cropped = createCdGpuVolume({parent,motionElement:{style:{getPropertyValue:()=>''}},getMotionEnvelope:()=>envelope})
    cropped.refresh(); cropped.sync(true,false)
    assert.equal(cropped.status().width,42,'A measured envelope removes transparent margins without reducing pixel density')
    assert.equal(cropped.status().height,42)
    sources[1].width = 24
    cropped.refresh(); cropped.sync(true,false)
    assert.equal(cropped.status().width,54,'Changed shell geometry rebuilds the envelope before presentation')
    cropped.dispose()
    assert.equal(frames.size,0)
    const reflection = {...sources[0],style:{...sources[0].style},dataset:{},classList:{contains:name=>name==='cd-deck-disc-reflection'}}
    sources.push(reflection)
    const paired = createCdGpuVolume({parent,motionElement:{style:{getPropertyValue:()=>''}}})
    paired.refresh()
    const pairDraws = calls.draws, pairUploads = calls.uploads
    paired.sync(true,false)
    assert.equal(calls.draws-pairDraws,2,'The shell and the combined disc/reflection each use one draw')
    assert.equal(calls.uploads-pairUploads,3,'Artwork, reflection and shell retain independent static textures')
    const uploaded = calls.uploads
    reflection.dataset.cdTextureVersion='2'
    paired.sync(true,false)
    assert.equal(calls.uploads-uploaded,1,'Changing reflections uploads only the reflection texture')
    reflection.style.visibility='hidden'
    const withoutReflection = calls.draws
    paired.sync(true,false)
    assert.equal(calls.draws-withoutReflection,2,'The artwork remains visible when its reflection is hidden')
    const previousMipmaps = calls.mipmaps
    sources[0].width = 18
    paired.sync(true,false)
    assert.equal(calls.mipmaps,previousMipmaps,'Non-power-of-two artwork remains valid in WebGL 1')
    assert.equal(minFilters.at(-1),'LINEAR','An updated non-power-of-two texture resets mipmap filtering')
    paired.dispose()
    assert.equal(frames.size,0)
  } finally {
    for(const [key,value] of Object.entries(saved)) { if(value===undefined)delete globalThis[key];else globalThis[key]=value }
  }
})





