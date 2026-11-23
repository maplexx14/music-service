import assert from 'node:assert/strict'
import test from 'node:test'
import { Group, Object3D, Scene, Vector3 } from 'three'
import { freezeCdSceneTransforms } from '../src/utils/cdSceneTransforms.js'

test('fixed scene transforms are computed once and skipped on repeated camera frames', () => {
  const scene = new Scene()
  const deck = new Group()
  const part = new Object3D()
  deck.position.set(1, 2, 3)
  part.position.set(4, 5, 6)
  scene.add(deck)
  deck.add(part)
  freezeCdSceneTransforms(scene)
  const before = part.matrixWorld.clone()
  let localUpdates = 0
  for (const object of [scene, deck, part]) {
    const update = object.updateMatrix.bind(object)
    object.updateMatrix = () => { localUpdates++; update() }
  }
  for (let index = 0; index < 60; index++) scene.updateMatrixWorld()
  assert.equal(localUpdates, 0)
  assert.deepEqual(part.matrixWorld.elements, before.elements)
  assert.deepEqual(part.getWorldPosition(new Vector3()).toArray(), [5, 7, 9])
})

test('a moving lid/dial still updates its fixed descendants under a frozen chassis', () => {
  const scene = new Scene()
  const deck = new Group()
  const lid = new Group()
  const glass = new Object3D()
  scene.add(deck)
  deck.add(lid)
  lid.add(glass)
  glass.position.set(1, 0, 0)
  freezeCdSceneTransforms(scene, [lid])
  lid.rotation.z = Math.PI / 2
  scene.updateMatrixWorld()
  const point = glass.getWorldPosition(new Vector3())
  assert.ok(Math.abs(point.x) < 1e-10)
  assert.ok(Math.abs(point.y - 1) < 1e-10)
})

test('explicitly updated transport matrices remain valid for rendering and hit testing', () => {
  const scene = new Scene()
  const button = new Group()
  const face = new Object3D()
  scene.add(button)
  button.add(face)
  freezeCdSceneTransforms(scene)
  button.position.y = -0.026
  button.updateMatrix()
  scene.updateMatrixWorld()
  assert.equal(face.getWorldPosition(new Vector3()).y, -0.026)
  button.position.y = 0
  button.updateMatrix()
  scene.updateMatrixWorld()
  assert.equal(face.getWorldPosition(new Vector3()).y, 0)
})
