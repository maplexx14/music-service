import assert from 'node:assert/strict'
import test from 'node:test'
import { PerspectiveCamera, Vector3 } from 'three'
import { centerCdCamera, cdMotionRegion, growCdMotionRegion } from '../src/utils/cdMotionRegion.js'

test('the crop covers projected chassis corners, includes edge padding and clips to the framebuffer', () => {
  const camera = new PerspectiveCamera(34, 1.4, 0.1, 60)
  camera.position.z = 12
  camera.updateMatrixWorld()
  const points = [-2.5, 2.5].flatMap(x => [-2.7, 2.7].map(y => new Vector3(x, y, 0)))
  const region = cdMotionRegion(points, camera, 848, 606)
  assert.ok(region.width < 848 && region.height < 606)
  for (const point of points) {
    const p = point.clone().project(camera)
    const x = (p.x + 1) * 848 / 2, y = (p.y + 1) * 606 / 2
    assert.ok(x >= region.x + 9 && x <= region.x + region.width - 9)
    assert.ok(y >= region.y + 9 && y <= region.y + region.height - 9)
  }
  const full = cdMotionRegion([new Vector3(-100, -100, 0), new Vector3(100, 100, 0)], camera, 848, 606)
  assert.deepEqual(full, { x: 0, y: 0, width: 848, height: 606 })
})

test('a cropped camera reconstructs the exact full-frame position and perspective', () => {
  const camera = new PerspectiveCamera(34, 1374 / 606, 0.1, 60)
  camera.position.set(3, 2, 12)
  camera.lookAt(0, 0, 0)
  camera.setViewOffset(1374, 606, 263, 0, 848, 606)
  camera.updateMatrixWorld()
  const points = [new Vector3(-2.5, -2.7, 0), new Vector3(2.5, 2.7, 0), new Vector3(0, 0, 1)]
  const r = cdMotionRegion(points, camera, 848, 606)
  const cropped = camera.clone(), view = camera.view
  cropped.setViewOffset(view.fullWidth, view.fullHeight,
    view.offsetX + r.x / 848 * view.width,
    view.offsetY + (606 - r.y - r.height) / 606 * view.height,
    r.width / 848 * view.width, r.height / 606 * view.height)
  for (const point of points) {
    const full = point.clone().project(camera), part = point.clone().project(cropped)
    assert.ok(Math.abs((full.x + 1) * 848 / 2 - (r.x + (part.x + 1) * r.width / 2)) < 1e-8)
    assert.ok(Math.abs((full.y + 1) * 606 / 2 - (r.y + (part.y + 1) * r.height / 2)) < 1e-8)
  }
})

test('motion keeps one sampling grid while contained and only grows when necessary', () => {
  const first = growCdMotionRegion(null, { x: 160, y: 10, width: 510, height: 570 }, 848, 606)
  assert.deepEqual(first, { x: 128, y: 0, width: 574, height: 606 })
  assert.equal(growCdMotionRegion(first, { x: 145, y: 0, width: 550, height: 600 }, 848, 606), first)
  const larger = growCdMotionRegion(first, { x: 0, y: 0, width: 750, height: 606 }, 848, 606)
  assert.deepEqual(larger, { x: 0, y: 0, width: 782, height: 606 })
  assert.equal(growCdMotionRegion(larger, first, 848, 606), larger)
})

test('mobile chassis stays centered through viewport changes and device tilt without accumulating offsets', () => {
  const points = [-2.5, 2.5].flatMap(x => [-2.7, 2.7].flatMap(y => [0, 1].map(z => new Vector3(x, y, z))))
  for (const [width, height] of [[390, 430], [320, 198], [740, 138]]) {
    const camera = new PerspectiveCamera(34, width / height, 0.1, 60)
    for (const [x, y] of [[2, 0], [3, 1], [-1, -1], [2, 0]]) {
      camera.position.set(x, y, 12)
      camera.lookAt(0, 0, 0)
      camera.updateMatrixWorld()
      const orientation = camera.quaternion.clone()
      centerCdCamera(points, camera, width, height)
      const projection = camera.projectionMatrix.clone()
      centerCdCamera(points, camera, width, height)
      assert.deepEqual(camera.projectionMatrix.elements, projection.elements)
      assert.deepEqual(camera.quaternion.toArray(), orientation.toArray())
      const projected = points.map(point => point.clone().project(camera))
      for (const axis of ['x', 'y']) {
        assert.ok(Math.abs(Math.min(...projected.map(p => p[axis])) + Math.max(...projected.map(p => p[axis]))) < 1e-10)
      }
      const point = new Vector3(1, 1, 0.7)
      assert.ok(point.clone().project(camera).unproject(camera).distanceTo(point) < 1e-10, 'pointer projection remains invertible')
    }
  }
})

test('cached camera crops retain the centered chassis and artwork positions', () => {
  const width = 390, height = 430
  const camera = new PerspectiveCamera(34, width / height, 0.1, 60)
  camera.position.set(2, 1, 12)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld()
  const points = [new Vector3(-2.5, -2.7, 1), new Vector3(2.5, 2.7, 1), new Vector3(0, 0, 0.7)]
  centerCdCamera(points, camera, width, height)
  const region = cdMotionRegion(points, camera, width, height)
  const cropped = camera.clone(), view = camera.view
  const offsetY = height - region.y - region.height
  cropped.setViewOffset(view.fullWidth, view.fullHeight,
    view.offsetX + region.x, view.offsetY + offsetY, region.width, region.height)
  for (const point of points) {
    const full = point.clone().project(camera), part = point.clone().project(cropped)
    assert.ok(Math.abs((full.x + 1) * width / 2 - (region.x + (part.x + 1) * region.width / 2)) < 1e-8)
    assert.ok(Math.abs((1 - full.y) * height / 2 - (offsetY + (1 - part.y) * region.height / 2)) < 1e-8)
  }
})

test('automatic reactions retain their movement through the centered resting frame', () => {
  const points = [-2.5, 2.5].flatMap(x => [-2.7, 2.7].flatMap(y => [0, 1].map(z => new Vector3(x, y, z))))
  const rest = new PerspectiveCamera(34, 390 / 430, 0.1, 60)
  rest.position.set(2, 0, 12)
  rest.lookAt(0, 0, 0)
  rest.updateMatrixWorld()
  centerCdCamera(points, rest, 390, 430)
  const animated = rest.clone()
  animated.position.set(4, 0.8, 11)
  animated.lookAt(0, 0, 0)
  animated.updateMatrixWorld()
  centerCdCamera(points, animated, 390, 430, rest.clone())
  assert.deepEqual(animated.view, rest.view, 'the reaction inherits the resting frame')
  const projected = points.map(point => point.clone().project(animated))
  assert.ok(Math.abs(Math.min(...projected.map(p => p.x)) + Math.max(...projected.map(p => p.x))) > 0.001, 'centering does not cancel the camera reaction')
  const point = new Vector3(1, 1, 0.7)
  assert.ok(point.clone().project(animated).unproject(animated).distanceTo(point) < 1e-10)
})
