import assert from 'node:assert/strict'
import test from 'node:test'
import { Float32BufferAttribute, MeshPhysicalMaterial, PlaneGeometry, Texture } from 'three'
import { canBatchCdSurface, createCdSurfaceBatch, updateCdSurfaceBatch } from '../src/utils/cdSurfaceBatch.js'

test('only compatible opaque surfaces share parameterized draws', () => {
  assert.equal(canBatchCdSurface(new MeshPhysicalMaterial({ color: '#34393e', roughness: 0.32 })), true)
  for (const options of [{ transparent: true }, { map: new Texture() }, { iridescence: 0.9 },
    { normalMap: new Texture() }, { specularIntensity: 0.5 }, { envMapIntensity: 0.45 }, { depthWrite: false }]) {
    assert.equal(canBatchCdSurface(new MeshPhysicalMaterial(options)), false, JSON.stringify(options))
  }
})

function makeBatch() {
  const geometry = new PlaneGeometry(1, 1)
  geometry.setAttribute('cdSurfaceIndex', new Float32BufferAttribute([0, 0, 1, 1], 1))
  const sources = [
    new MeshPhysicalMaterial({ color: '#34393e', metalness: 0.82, roughness: 0.32, bumpScale: 0.0015 }),
    new MeshPhysicalMaterial({ color: '#747b80', metalness: 0.94, roughness: 0.25 }),
  ]
  return createCdSurfaceBatch(geometry, sources)
}

test('linear colors and physical parameters survive combining different parts', () => {
  const { geometry, sources, material } = makeBatch()
  for (let index = 0; index < 4; index++) {
    const source = sources[index < 2 ? 0 : 1]
    assert.ok(Math.abs(geometry.attributes.color.getX(index) - source.color.r) < 1e-7)
    assert.ok(Math.abs(geometry.attributes.cdSurface.getX(index) - source.roughness) < 1e-7)
    assert.ok(Math.abs(geometry.attributes.cdSurface.getY(index) - source.metalness) < 1e-7)
    assert.ok(Math.abs(geometry.attributes.cdSurface.getZ(index) - source.bumpScale) < 1e-7)
  }
  assert.equal(material.clearcoat, 0)
  assert.equal(material.color.getHex(), 0xffffff)
})

test('changing finish updates the original parts and toggles the clearcoat shader only as needed', () => {
  const batch = makeBatch()
  const version = batch.material.version
  Object.assign(batch.sources[0], { clearcoat: 1, clearcoatRoughness: 0.1, roughness: 0.16 })
  batch.sources[0].color.set('#c09070')
  updateCdSurfaceBatch(batch)
  assert.ok(batch.material.version > version)
  assert.equal(batch.material.clearcoat, 1)
  assert.equal(batch.geometry.attributes.cdSurface.getW(0), 1)
  assert.equal(batch.geometry.attributes.cdSurface.getW(2), 0)
  assert.ok(Math.abs(batch.geometry.attributes.cdCoatRoughness.getX(0) - 0.1) < 1e-7)
  const glossyVersion = batch.material.version
  updateCdSurfaceBatch(batch)
  assert.equal(batch.material.version, glossyVersion)
  batch.sources[0].clearcoat = 0
  updateCdSurfaceBatch(batch)
  assert.equal(batch.material.clearcoat, 0)
  assert.ok(batch.material.version > glossyVersion)
})

test('the shared shader retains physical shading while taking per-part surface parameters', () => {
  const { material } = makeBatch()
  const shader = {
    vertexShader: '#include <color_vertex>',
    fragmentShader: '#include <roughnessmap_fragment>\n#include <metalnessmap_fragment>\n#include <bumpmap_pars_fragment>\n#include <lights_physical_fragment>',
  }
  material.onBeforeCompile(shader)
  assert.ok(shader.vertexShader.includes('vCdSurface = cdSurface'))
  assert.ok(shader.fragmentShader.includes('roughnessFactor = vCdSurface.x'))
  assert.ok(shader.fragmentShader.includes('metalnessFactor = vCdSurface.y'))
  assert.ok(shader.fragmentShader.includes('vCdSurface.z * texture2D'))
  assert.ok(shader.fragmentShader.includes('material.clearcoat = vCdSurface.w'))
  assert.ok(shader.fragmentShader.includes('material.clearcoatRoughness = vCdCoatRoughness'))
  assert.ok(shader.fragmentShader.includes('material.roughness += geometryRoughness'))
})
