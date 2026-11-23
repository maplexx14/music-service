import assert from 'node:assert/strict'
import test from 'node:test'
import { Matrix4, PerspectiveCamera, Ray, Vector3, Vector4 } from 'three'
import { cdCssCameraMatrix, cdCssCameraDelta, cdCssPlaneMatrix, cdPlaybackVolumeFaces, cdRayFromCssVolume, createCdPlaybackVolume } from '../src/utils/cdPlaybackVolume.js'
import { cdPointInQuad } from '../src/utils/cdProjection.js'

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`)
const target = new Vector3(0, 2.73, 0)
function environment() {
  const camera = new PerspectiveCamera(34, 1100 / 600, 0.1, 60)
  camera.position.set(2.4, 4.1, 11)
  camera.lookAt(target)
  camera.setViewOffset(1100, 600, 150, 15, 800, 600)
  camera.updateMatrixWorld(true)
  return { camera, ...cdCssCameraMatrix(camera, target, 800, 600, 150) }
}

test('the six surfaces close a chassis with outward normals and real thickness', () => {
  const faces = cdPlaybackVolumeFaces([-2.46, 0.045, 0.01], [2.46, 5.415, 0.81])
  const edges = new Map()
  for (const { corners } of faces) {
    const right = corners[1].clone().sub(corners[0]), down = corners[3].clone().sub(corners[0])
    const center = corners[0].clone().add(corners[2]).multiplyScalar(0.5)
    const normal = down.cross(right).normalize()
    assert.ok(normal.dot(center.clone().sub(new Vector3(0, 2.73, 0.41))) > 0)
    for (let i = 0; i < 4; i++) {
      const key = [corners[i].toArray().join(','), corners[(i + 1) % 4].toArray().join(',')].sort().join('|')
      edges.set(key, (edges.get(key) || 0) + 1)
    }
  }
  assert.equal(edges.size, 12)
  assert.ok([...edges.values()].every(count => count === 2))
})

test('rounded walls share their edges and stay inside the lid corner profile', () => {
  const walls = cdPlaybackVolumeFaces([-2.46, 0.045, 0.01], [2.46, 5.415, 0.81], 0.18).slice(2)
  for (const [index, wall] of walls.entries()) {
    const next = walls[(index + 1) % walls.length]
    assert.ok(wall.corners[1].distanceTo(next.corners[0]) < 1e-10)
    assert.ok(wall.corners[2].distanceTo(next.corners[3]) < 1e-10)
    const right = wall.corners[1].clone().sub(wall.corners[0])
    const down = wall.corners[3].clone().sub(wall.corners[0])
    const center = wall.corners[0].clone().add(wall.corners[2]).multiplyScalar(0.5)
    assert.ok(down.cross(right).dot(center.clone().sub(new Vector3(0, 2.73, 0.41))) > 0)
    for (const point of wall.corners) {
      const dx = Math.max(0, Math.abs(point.x) - (2.46 - 0.18))
      const dy = Math.max(0, Math.abs(point.y - 2.73) - (2.685 - 0.18))
      assert.ok(dx * dx + dy * dy <= 0.18 ** 2 + 1e-10, 'A wall cannot extend outside the rounded lid')
    }
  }
})

test('CSS positions match the original lens and view offset while preserving front/back depth', () => {
  const { camera, matrix } = environment()
  const samples = [new Vector3(-2, 4.8, 0.81), new Vector3(2, 0.4, 0.01), target]
  for (const point of samples) {
    const projected = point.clone().project(camera)
    const css = new Vector4(...point.toArray(), 1).applyMatrix4(matrix)
    close(css.x / css.w, 150 + (projected.x + 1) * 400)
    close(css.y / css.w, (1 - projected.y) * 300)
  }
  const front = new Vector3(0, 2.73, 0.81).applyMatrix4(matrix)
  const back = new Vector3(0, 2.73, 0.01).applyMatrix4(matrix)
  assert.ok(front.z - back.z > 60)
})

test('surface corners keep their depth through bitmap placement', () => {
  const { matrix } = environment()
  const face = cdPlaybackVolumeFaces([-2.46, 0.045, 0.01], [2.46, 5.415, 0.81])[3]
  const plane = cdCssPlaneMatrix(matrix, face.corners, 180, 900)
  for (const [index, x, y] of [[0, 0, 0], [1, 180, 0], [2, 180, 900], [3, 0, 900]]) {
    const actual = new Vector3(x, y, 0).applyMatrix4(plane)
    const expected = face.corners[index].clone().applyMatrix4(matrix)
    close(actual.x, expected.x); close(actual.y, expected.y); close(actual.z, expected.z)
  }
})

test('an affine native camera turn matches the original skip projection with one lens and a changed view offset', () => {
  const source = environment()
  const turned = source.camera.clone()
  turned.position.set(3.8, 4.9, 10.2)
  turned.up.set(0.06, 1, 0)
  turned.lookAt(target)
  turned.setViewOffset(1100, 600, 210, 6, 800, 600)
  const destination = cdCssCameraMatrix(turned, target, 800, 600, 150)
  const delta = cdCssCameraDelta(source, destination)
  for (const index of [3, 7, 11]) close(delta.elements[index], 0)
  close(delta.elements[15], 1)
  const lens = new Matrix4()
  lens.elements[11] = -1 / source.lens
  const combined = new Matrix4().makeTranslation(source.centerX, source.centerY, 0)
    .multiply(lens).multiply(delta)
    .multiply(new Matrix4().makeTranslation(-source.centerX, -source.centerY, 0))
    .multiply(source.viewMatrix)
  for (const point of [target, new Vector3(-2.46, 5.415, 0.81), new Vector3(2.46, 0.045, 0.01)]) {
    const actual = new Vector4(...point.toArray(), 1).applyMatrix4(combined)
    const expected = new Vector4(...point.toArray(), 1).applyMatrix4(destination.matrix)
    close(actual.x / actual.w, expected.x / expected.w)
    close(actual.y / actual.w, expected.y / expected.w)
    close(actual.z / actual.w, expected.z / expected.w)
  }
})

test('one lens retains the original framing and combined rotation exposes the actual chassis walls', () => {
  const { matrix, viewMatrix, lens, centerX, centerY } = environment()
  const perspective = new Matrix4()
  perspective.elements[11] = -1 / lens
  const lensMatrix = new Matrix4().makeTranslation(centerX, centerY, 0).multiply(perspective)
    .multiply(new Matrix4().makeTranslation(-centerX, -centerY, 0))
  for (const world of [target, new Vector3(2.46, 5.415, 0.81)]) {
    const original = world.clone().applyMatrix4(matrix)
    const css = world.clone().applyMatrix4(lensMatrix.clone().multiply(viewMatrix))
    close(css.x, original.x); close(css.y, original.y); close(css.z, original.z)
  }
  const tilted = new Matrix4().makeTranslation(centerX, centerY, 0).multiply(perspective)
    .multiply(new Matrix4().makeRotationY(-26 * Math.PI / 180))
    .multiply(new Matrix4().makeRotationX(-18 * Math.PI / 180))
    .multiply(new Matrix4().makeTranslation(-centerX, -centerY, 0))
  const eye = new Vector4(0, 0, 1, 0).applyMatrix4(tilted.clone().multiply(viewMatrix).invert())
  assert.ok(eye.x / eye.w > 2.46, 'The camera looks past the right wall')
  assert.ok(eye.y / eye.w > 5.415, 'The camera looks over the top wall')
})

test('rays hit the visible disc and controls under combined pitch, yaw, perspective and action offset', () => {
  const { matrix } = environment()
  for (const [pitch, yaw] of [[10, 20], [-10, -20], [7, -15], [-7, 15]]) {
    const perspective = new Matrix4()
    perspective.elements[11] = -1 / 1100
    const outer = new Matrix4().makeTranslation(580, 270, 0).multiply(perspective)
      .multiply(new Matrix4().makeRotationY(yaw * Math.PI / 180))
      .multiply(new Matrix4().makeRotationX(pitch * Math.PI / 180))
      .multiply(new Matrix4().makeTranslation(-580, -270, 0))
    const quad = [[0, 0], [1100, 0], [1100, 600], [0, 600]].map(([x, y]) => new Vector3(x, y, 0).applyMatrix4(outer))
    for (const worldPoint of [new Vector3(1.3, 2.98, 0.64), new Vector3(1.85, 0.37, 0.85)]) {
      const screen = worldPoint.clone().applyMatrix4(outer.clone().multiply(matrix))
      const flat = cdPointInQuad(quad, screen.x, screen.y)
      const ray = new Ray()
      assert.ok(cdRayFromCssVolume(ray, matrix, outer, { x: flat.x * 1100, y: flat.y * 600 }))
      assert.ok(ray.distanceToPoint(worldPoint) < 1e-8)
      assert.ok(worldPoint.clone().sub(ray.origin).dot(ray.direction) > 0)
      assert.ok(cdRayFromCssVolume(ray, matrix, outer, screen, true))
      assert.ok(ray.distanceToPoint(worldPoint) < 1e-8)
      assert.ok(worldPoint.clone().sub(ray.origin).dot(ray.direction) > 0)
    }
  }
})

async function pendingSurfaceCapture(t, options = {}) {
  const previousDocument = globalThis.document, previousWindow = globalThis.window
  const element = () => ({ style: {}, append() {}, remove() {}, setAttribute() {} })
  globalThis.document = { createElement: element }
  globalThis.window = { devicePixelRatio: 1 }
  let reject, started, finished, capturedCamera
  const readback = new Promise((_, fail) => { reject = fail })
  const reading = new Promise(resolve => { started = resolve })
  const done = new Promise(resolve => { finished = resolve })
  const renderer = {
    capabilities: { maxSamples: 0 }, getRenderTarget: () => null, setRenderTarget() {}, render(scene, camera) { capturedCamera = camera },
    readRenderTargetPixelsAsync(target) {
      target.addEventListener('dispose', finished)
      started()
      return readback
    },
  }
  const volume = createCdPlaybackVolume({
    parent: element(), renderer, scene: {}, enabled: () => true,
    faces: cdPlaybackVolumeFaces([-1, -1, 0], [1, 1, 1]).slice(0, 1),
    ...options,
  })
  t.after(async () => {
    volume.dispose()
    reject()
    await done
    if (previousDocument === undefined) delete globalThis.document
    else globalThis.document = previousDocument
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  })
  volume.setView(new Matrix4(), 1)
  volume.refresh('original')
  await reading
  return { volume, reject, done, capturedCamera }
}

test('front capture uses the resting camera to preserve the same material reflections', async t => {
  const restingCamera = { isPerspectiveCamera: true }
  const { capturedCamera } = await pendingSurfaceCapture(t, { captureCamera: () => restingCamera })
  assert.equal(capturedCamera, restingCamera)
})

test('closing the chassis while its pixels are pending safely ignores a cancelled readback', async t => {
  const { volume, reject, done } = await pendingSurfaceCapture(t)
  volume.dispose()
  reject()
  await done
  assert.equal(volume.status().failure, null)
  assert.equal(volume.status().preparing, false)
  assert.equal(volume.visible, false)
})

test('a stale readback failure cannot poison a newly requested chassis appearance', async t => {
  const { volume, reject, done } = await pendingSurfaceCapture(t)
  volume.refresh('updated')
  reject(new Error('Old capture was cancelled'))
  await done
  assert.equal(volume.status().failure, null)
  assert.equal(volume.status().pending, true)
})

test('a current readback rejection without an Error reports a failure and preserves the fallback', async t => {
  const { volume, reject, done } = await pendingSurfaceCapture(t)
  reject()
  await done
  assert.equal(volume.status().failure, 'CD surface capture failed')
  assert.equal(volume.status().ready, false)
  assert.equal(volume.setVisible(true), false)
})
