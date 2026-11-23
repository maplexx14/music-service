import { Float32BufferAttribute, ShaderChunk } from 'three'

// These opaque surfaces differ only in parameters, not in shader features.
// Textured prints, transparent glass and iridescent foil keep their own draws.
export function canBatchCdSurface(surface) {
  return surface?.isMeshPhysicalMaterial && !surface.transparent && !surface.map &&
    !surface.normalMap && !surface.roughnessMap && !surface.metalnessMap &&
    !surface.clearcoatMap && !surface.clearcoatNormalMap && !surface.clearcoatRoughnessMap &&
    !surface.specularColorMap && !surface.specularIntensityMap &&
    surface.ior === 1.5 && surface.specularIntensity === 1 && surface.specularColor.getHex() === 0xffffff &&
    surface.envMapIntensity === 1 && surface.opacity === 1 &&
    surface.depthWrite && surface.depthTest && surface.colorWrite && !surface.polygonOffset && !surface.flatShading &&
    !surface.iridescence && !surface.transmission && !surface.anisotropy &&
    !surface.sheen && !surface.emissive.getHex()
}

export function createCdSurfaceBatch(geometry, sources) {
  const material = sources[0].clone()
  material.color.set(0xffffff)
  material.roughness = material.metalness = material.bumpScale = 1
  material.vertexColors = true
  material.customProgramCacheKey = () => 'cd-surface-parameters-v1'
  material.onBeforeCompile = shader => {
    shader.vertexShader = `attribute vec4 cdSurface;
      attribute float cdCoatRoughness;
      varying vec4 vCdSurface;
      varying float vCdCoatRoughness;\n${shader.vertexShader}`.replace(
      '#include <color_vertex>',
      '#include <color_vertex>\nvCdSurface = cdSurface; vCdCoatRoughness = cdCoatRoughness;',
    )
    shader.fragmentShader = `varying vec4 vCdSurface;
      varying float vCdCoatRoughness;\n${shader.fragmentShader}`
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = vCdSurface.x;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = vCdSurface.y;')
      .replace('#include <bumpmap_pars_fragment>', ShaderChunk.bumpmap_pars_fragment
        .replace('uniform float bumpScale;', '')
        .replaceAll('bumpScale *', 'vCdSurface.z *'))
      .replace('#include <lights_physical_fragment>', ShaderChunk.lights_physical_fragment
        .replace('material.clearcoat = clearcoat;', 'material.clearcoat = vCdSurface.w;')
        .replace('material.clearcoatRoughness = clearcoatRoughness;', 'material.clearcoatRoughness = vCdCoatRoughness;'))
  }
  const count = geometry.attributes.position.count
  geometry.setAttribute('color', new Float32BufferAttribute(new Float32Array(count * 3), 3))
  geometry.setAttribute('cdSurface', new Float32BufferAttribute(new Float32Array(count * 4), 4))
  geometry.setAttribute('cdCoatRoughness', new Float32BufferAttribute(new Float32Array(count), 1))
  const batch = { geometry, material, sources }
  updateCdSurfaceBatch(batch)
  return batch
}

export function updateCdSurfaceBatch({ geometry, material, sources }) {
  const color = geometry.attributes.color
  const params = geometry.attributes.cdSurface
  const coat = geometry.attributes.cdCoatRoughness
  const indices = geometry.attributes.cdSurfaceIndex.array
  const nextClearcoat = Math.max(...sources.map(source => source.clearcoat))
  if (Boolean(material.clearcoat) !== Boolean(nextClearcoat)) material.needsUpdate = true
  material.clearcoat = nextClearcoat
  for (let index = 0; index < indices.length; index++) {
    const source = sources[indices[index]]
    color.setXYZ(index, source.color.r, source.color.g, source.color.b)
    params.setXYZW(index, source.roughness, source.metalness, source.bumpScale, source.clearcoat)
    coat.setX(index, source.clearcoatRoughness)
  }
  color.needsUpdate = params.needsUpdate = coat.needsUpdate = true
}
