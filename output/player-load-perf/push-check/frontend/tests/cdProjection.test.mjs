import assert from 'node:assert/strict'
import test from 'node:test'
import { squareToQuadTransform, cdQuadToQuadTransform, cdPointInQuad } from '../src/utils/cdProjection.js'

function mappedCorners(quad, width, height = width) {
  const matrix = squareToQuadTransform(quad, width, height).slice(9, -1).split(',').map(Number)
  return [[0, 0], [width, 0], [width, height], [0, height]].map(([x, y]) => {
    const w = matrix[3] * x + matrix[7] * y + matrix[15]
    return { x: (matrix[0] * x + matrix[4] * y + matrix[12]) / w,
      y: (matrix[1] * x + matrix[5] * y + matrix[13]) / w }
  })
}

test('a rectangular display retains all four corners at an oblique camera angle', () => {
  const quad = [{ x: 93, y: 240 }, { x: 367, y: 249 }, { x: 362, y: 308 }, { x: 96, y: 291 }]
  mappedCorners(quad, 768, 160).forEach((point, i) => {
    assert.ok(Math.abs(point.x - quad[i].x) < 1e-8)
    assert.ok(Math.abs(point.y - quad[i].y) < 1e-8)
  })
})

test('square discs preserve their existing projection and a frontal display stays finite', () => {
  const quad = [{ x: 40, y: 20 }, { x: 340, y: 20 }, { x: 340, y: 80 }, { x: 40, y: 80 }]
  assert.deepEqual(mappedCorners(quad, 512), quad)
  assert.deepEqual(mappedCorners(quad, 768, 160), quad)
  assert.equal(squareToQuadTransform(null, 512), 'none')
})

function mapPoint(transform, point) {
  const m = transform.slice(9, -1).split(',').map(Number)
  const w = m[3] * point.x + m[7] * point.y + m[15]
  return { x: (m[0] * point.x + m[4] * point.y + m[12]) / w,
    y: (m[1] * point.x + m[5] * point.y + m[13]) / w }
}

test('cached frame correction preserves the exact face and interior print through perspective', () => {
  const source = [{ x: 35, y: 20 }, { x: 400, y: 55 }, { x: 385, y: 490 }, { x: 22, y: 455 }]
  const destination = [{ x: 37, y: 23 }, { x: 396, y: 53 }, { x: 387, y: 491 }, { x: 24, y: 458 }]
  const transform = cdQuadToQuadTransform(source, destination)
  const sourcePlane = squareToQuadTransform(source, 1)
  const targetPlane = squareToQuadTransform(destination, 1)
  for (const [x, y] of [[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0.5], [0.2, 0.73]]) {
    const actual = mapPoint(transform, mapPoint(sourcePlane, { x, y }))
    const expected = mapPoint(targetPlane, { x, y })
    assert.ok(Math.hypot(actual.x - expected.x, actual.y - expected.y) < 1e-8)
  }
  const identity = cdQuadToQuadTransform(source, source)
  const point = { x: 180, y: 200 }
  const mapped = mapPoint(identity, point)
  assert.ok(Math.hypot(mapped.x - point.x, mapped.y - point.y) < 1e-8)
})

test('changing the prepared pose cannot move the interpolated body or its central aperture', () => {
  const destination = [{ x: 120, y: 28 }, { x: 390, y: 24 }, { x: 386, y: 425 }, { x: 122, y: 412 }]
  const poses = [
    [{ x: 119, y: 30 }, { x: 388, y: 27 }, { x: 384, y: 427 }, { x: 121, y: 415 }],
    [{ x: 121, y: 26 }, { x: 392, y: 21 }, { x: 388, y: 423 }, { x: 123, y: 409 }],
  ]
  const corrected = poses.map(source => {
    const center = mapPoint(squareToQuadTransform(source, 1), { x: 0.5, y: 0.5 })
    return mapPoint(cdQuadToQuadTransform(source, destination), center)
  })
  assert.ok(Math.hypot(corrected[0].x - corrected[1].x, corrected[0].y - corrected[1].y) < 1e-8)
})

test('pointer coordinates follow the rendered plane at both tilt extremes and through perspective', () => {
  const quads = [
    [{ x: 450, y: 100 }, { x: 950, y: 120 }, { x: 926, y: 720 }, { x: 426, y: 700 }],
    [{ x: 426, y: 120 }, { x: 926, y: 100 }, { x: 950, y: 700 }, { x: 450, y: 720 }],
    [{ x: 93, y: 240 }, { x: 367, y: 249 }, { x: 362, y: 308 }, { x: 96, y: 291 }],
  ]
  for (const quad of quads) {
    const transform = squareToQuadTransform(quad, 1)
    for (const [x, y] of [[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0.5], [0.15, 0.82]]) {
      const screen = mapPoint(transform, { x, y })
      const actual = cdPointInQuad(quad, screen.x, screen.y)
      assert.ok(actual && Math.hypot(actual.x - x, actual.y - y) < 1e-8)
    }
  }
})

test('a transformed pointer outside the chassis stays outside instead of being clamped into a button', () => {
  const quad = [{ x: 100, y: 40 }, { x: 520, y: 20 }, { x: 550, y: 400 }, { x: 130, y: 420 }]
  const screen = mapPoint(squareToQuadTransform(quad, 1), { x: -0.2, y: 1.15 })
  const point = cdPointInQuad(quad, screen.x, screen.y)
  assert.ok(point && point.x < 0 && point.y > 1)
})

test('collapsed or invalid pointer planes cannot produce a raycast', () => {
  const flat = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 }]
  assert.equal(cdPointInQuad(flat, 5, 0), null)
  assert.equal(cdPointInQuad(null, 0, 0), null)
  assert.equal(cdPointInQuad(flat.slice(0, 3), 0, 0), null)
  assert.equal(cdPointInQuad(flat, NaN, 0), null)
  assert.equal(cdPointInQuad([{ x: Infinity, y: 0 }, ...flat.slice(1)], 0, 0), null)
})

