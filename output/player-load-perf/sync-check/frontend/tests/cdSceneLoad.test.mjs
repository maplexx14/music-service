import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { Worker as NodeWorker } from 'node:worker_threads'
import { gunzipSync } from 'node:zlib'
import { BoxGeometry, Float32BufferAttribute, Group, Matrix4, Mesh, MeshPhysicalMaterial } from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'
import { mergeCdVertices } from '../src/utils/cdMergeVertices.js'
import { createCdSceneLoadTask } from '../src/utils/cdSceneLoadTask.js'
import { applyCdDrawingBufferSize, cdCanvasSize } from '../src/utils/cdCanvasSize.js'
import { createCdGeometryLoader } from '../src/utils/cdGeometryLoad.js'
import { createCdStudioTexture, decodeCdStudioEnvironment } from '../src/utils/cdStudioEnvironmentData.js'

test('staged vertex merging preserves the original player geometry exactly', async () => {
  const geometry = new BoxGeometry(2, 3, 4, 12, 12, 12).toNonIndexed()
  geometry.setAttribute('cdSurfaceIndex', new Float32BufferAttribute(new Float32Array(geometry.attributes.position.count).fill(2), 1))
  geometry.morphAttributes.position = [geometry.attributes.position.clone()]
  const expected = mergeVertices(geometry, 1e-6)
  let yields = 0
  const load = createCdSceneLoadTask(null, { budget: 0, yieldTask: async () => { yields++ } })
  const actual = await mergeCdVertices(geometry, 1e-6, load)
  assert.ok(yields > 1)
  assert.deepEqual(actual.index.array, expected.index.array)
  for (const name of Object.keys(expected.attributes)) assert.deepEqual(actual.attributes[name].array, expected.attributes[name].array)
  assert.deepEqual(actual.morphAttributes.position[0].array, expected.morphAttributes.position[0].array)
})

test('leaving the page stops construction after yielding and releases resources in reverse order', async () => {
  const controller = new AbortController()
  const released = []
  const load = createCdSceneLoadTask(controller.signal, { yieldTask: async () => controller.abort() })
  load.onCleanup(() => released.push('renderer'))
  load.onCleanup(() => { released.push('geometry'); throw new Error('cleanup failure') })
  await assert.rejects(load.checkpoint(true), { name: 'AbortError' })
  load.dispose()
  load.dispose()
  assert.deepEqual(released, ['geometry', 'renderer'])
})

test('GPU preparation polls without blocking and deletes the fence on cancellation', async () => {
  const controller = new AbortController()
  let polls = 0, deleted = 0
  const gl = {
    fenceSync: () => 1, flush() {}, isContextLost: () => false,
    clientWaitSync() { polls++; controller.abort(); return 3 },
    deleteSync: () => deleted++, ALREADY_SIGNALED: 1, CONDITION_SATISFIED: 2, WAIT_FAILED: 4,
  }
  const load = createCdSceneLoadTask(controller.signal)
  await assert.rejects(load.waitForGpu({ getContext: () => gl }), { name: 'AbortError' })
  assert.equal(polls, 1)
  assert.equal(deleted, 1)
})

test('initial canvas allocation retains the existing crop and resolution limits', () => {
  for (const mobile of [false, true]) for (const cachedRendering of [false, true]) {
    for (const constrainedDevice of [false, true]) for (const powerSave of [false, true]) {
      const options = { stageWidth: 900, height: 600, devicePixelRatio: 3, mobile, cachedRendering, constrainedDevice, powerSave }
      const size = cdCanvasSize(options)
      const width = mobile ? 900 : 840
      const limited = constrainedDevice || powerSave
      const maxPixels = cachedRendering ? 2_000_000 : limited ? 750_000 : 1_750_000
      assert.equal(size.width, width)
      assert.equal(size.pixelRatio, Math.min(3, cachedRendering ? 2 : limited ? 1 : 2, Math.sqrt(maxPixels / (width * 600))))
      assert.equal(size.pixelWidth, Math.floor(width * size.pixelRatio))
    }
  }
  assert.equal(cdCanvasSize({ stageWidth: 0, height: 600 }), null)
})

test('canvas resizes allocate once and an unchanged layout does not reallocate', () => {
  let width = 300, height = 150, ratio = 1, allocations = 0
  const renderer = {
    getSize: target => target.set(width, height), getPixelRatio: () => ratio,
    setDrawingBufferSize(w, h, r) { width = w; height = h; ratio = r; allocations++ },
  }
  const size = cdCanvasSize({ stageWidth: 900, height: 600, cachedRendering: true })
  applyCdDrawingBufferSize(renderer, size)
  applyCdDrawingBufferSize(renderer, size)
  assert.equal(allocations, 1)
  applyCdDrawingBufferSize(renderer, cdCanvasSize({ stageWidth: 600, height: 400 }))
  assert.equal(allocations, 2)
})

test('baked studio retains half-float pixels and the original cube-UV texture settings', async () => {
  const file = await readFile(new URL('../src/assets/cd-studio-environment.bin.gzip', import.meta.url))
  const bytes = gunzipSync(file)
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  const data = decodeCdStudioEnvironment(buffer)
  assert.equal(data.pixels.length, 768 * 1024 * 4)
  assert.equal(data.pixels.buffer, buffer)
  assert.ok(data.pixels.some(value => value !== 0))
  const first = createCdStudioTexture(data), second = createCdStudioTexture(data)
  assert.notEqual(first, second)
  assert.equal(first.image.data, second.image.data)
  assert.equal(first.flipY, false)
  assert.equal(first.generateMipmaps, false)
  assert.equal(first.colorSpace, 'srgb-linear')
  first.dispose(); second.dispose()
  assert.throws(() => decodeCdStudioEnvironment(new ArrayBuffer(8)), /Incomplete/)
  new DataView(buffer).setUint32(4, 1, true)
  assert.throws(() => decodeCdStudioEnvironment(buffer), /dimensions/)
})

function geometryFixture() {
  const group = new Group()
  group.rotation.set(0.25, 0.3, -0.1)
  const sources = [new MeshPhysicalMaterial(), new MeshPhysicalMaterial()]
  const objects = sources.map((surface, index) => {
    const geometry = new BoxGeometry(2, 3, 4, 8, 8, 8)
    geometry.morphAttributes.position = [geometry.attributes.position.clone()]
    const object = new Mesh(index ? geometry.toNonIndexed() : geometry, surface)
    object.position.set(index * 2, -0.1, 0.4)
    object.rotation.set(-0.2, index * 0.4, 0.15)
    group.add(object)
    return object
  })
  group.updateMatrixWorld(true)
  const inverse = group.matrixWorld.clone().invert()
  const geometries = objects.map((object, index) => {
    const geometry = object.geometry.index ? object.geometry.toNonIndexed() : object.geometry.clone()
    geometry.setAttribute('cdSurfaceIndex', new Float32BufferAttribute(new Float32Array(geometry.attributes.position.count).fill(index), 1))
    return geometry.applyMatrix4(new Matrix4().multiplyMatrices(inverse, object.matrixWorld))
  })
  const expected = mergeVertices(mergeGeometries(geometries), 1e-6)
  return { objects, inverse, sources, expected }
}

function assertGeometryEqual(actual, expected) {
  assert.deepEqual(actual.index.array, expected.index.array)
  for (const name of Object.keys(expected.attributes)) assert.deepEqual(actual.attributes[name].array, expected.attributes[name].array, name)
  assert.deepEqual(actual.morphAttributes.position[0].array, expected.morphAttributes.position[0].array)
}

function createThreadWorker() {
  const thread = new NodeWorker(`
    const {parentPort,workerData}=require('node:worker_threads');
    globalThis.self={postMessage:(data,transfers)=>parentPort.postMessage(data,transfers)};
    import(workerData).then(()=>parentPort.on('message',data=>self.onmessage({data})));
  `, { eval: true, workerData: new URL('../src/utils/cdGeometry.worker.js', import.meta.url).href })
  const worker = { postMessage: (...args) => thread.postMessage(...args), terminate: () => thread.terminate() }
  thread.on('message', data => worker.onmessage?.({ data }))
  thread.on('error', error => worker.onerror?.(error))
  return worker
}

test('real worker produces identical transforms, surface indices and morphs without detaching hit meshes', async () => {
  const fixture = geometryFixture()
  const original = fixture.objects.map(object => object.geometry.attributes.position.array.slice())
  const load = createCdSceneLoadTask()
  const loader = createCdGeometryLoader(load, null, { createWorker: createThreadWorker })
  try {
    const result = await loader.batch(fixture.objects, fixture.inverse, fixture.sources, true)
    assertGeometryEqual(result, fixture.expected)
    fixture.objects.forEach((object, index) => assert.deepEqual(object.geometry.attributes.position.array, original[index]))
  } finally { loader.dispose() }
})

test('unavailable worker falls back to staged geometry preparation', async () => {
  const fixture = geometryFixture()
  let yields = 0
  const load = createCdSceneLoadTask(null, { budget: 0, yieldTask: async () => { yields++ } })
  const loader = createCdGeometryLoader(load, null, { createWorker: () => { throw new Error('Workers unavailable') } })
  try {
    assertGeometryEqual(await loader.batch(fixture.objects, fixture.inverse, fixture.sources, true), fixture.expected)
    assert.ok(yields > 1)
  } finally { loader.dispose() }
})

test('cancelling a running worker terminates it and rejects the pending batch', async () => {
  const fixture = geometryFixture()
  const controller = new AbortController()
  const load = createCdSceneLoadTask(controller.signal)
  let started, terminated = 0
  const running = new Promise(resolve => { started = resolve })
  const loader = createCdGeometryLoader(load, controller.signal, { createWorker: () => ({
    postMessage() { started() }, terminate() { terminated++ },
  }) })
  const result = loader.batch(fixture.objects, fixture.inverse, fixture.sources, true)
  await running
  controller.abort()
  await assert.rejects(result, { name: 'AbortError' })
  loader.dispose()
  assert.equal(terminated, 1)
})

test('worker startup failure retries from retained meshes after transferring the copies', async () => {
  const fixture = geometryFixture()
  const load = createCdSceneLoadTask()
  let terminated = 0
  const worker = {
    postMessage(data, transfers) {
      structuredClone(data, { transfer: transfers })
      queueMicrotask(() => worker.onerror({ preventDefault() {} }))
    },
    terminate() { terminated++ },
  }
  const loader = createCdGeometryLoader(load, null, { createWorker: () => worker })
  try {
    assertGeometryEqual(await loader.batch(fixture.objects, fixture.inverse, fixture.sources, true), fixture.expected)
    assert.equal(terminated, 1)
    assert.ok(fixture.objects.every(object => object.geometry.attributes.position.array.byteLength > 0))
  } finally { loader.dispose() }
})

test('first-frame readiness waits for both browser commits', async () => {
  const frames = []
  const load = createCdSceneLoadTask(null, { requestFrame: callback => frames.push(callback) })
  let ready = false
  const result = load.waitForPaint().then(() => { ready = true })
  assert.equal(frames.length, 1)
  assert.equal(ready, false)
  frames[0]()
  await Promise.resolve()
  assert.equal(frames.length, 2)
  assert.equal(ready, false)
  frames[1]()
  await result
  assert.equal(ready, true)
})

test('leaving a hidden tab cancels pending first-frame readiness', async () => {
  const controller = new AbortController()
  let cancelled
  const load = createCdSceneLoadTask(controller.signal, { requestFrame: () => 42, cancelFrame: frame => { cancelled = frame } })
  const result = load.waitForPaint()
  controller.abort()
  await assert.rejects(result, { name: 'AbortError' })
  assert.equal(cancelled, 42)
})
