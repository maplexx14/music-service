import { BufferAttribute, BufferGeometry, Float16BufferAttribute, Float32BufferAttribute, Matrix4 } from 'three'
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'
import { mergeCdVertices } from './cdMergeVertices.js'

function packAttribute(attribute) {
  return { array: attribute.array.slice(), itemSize: attribute.itemSize, normalized: attribute.normalized,
    float16: Boolean(attribute.isFloat16BufferAttribute) }
}

export function packCdGeometry(geometry) {
  return {
    attributes: Object.fromEntries(Object.entries(geometry.attributes).map(([name, attribute]) => [name, packAttribute(attribute)])),
    index: geometry.index ? packAttribute(geometry.index) : null,
    morphAttributes: Object.fromEntries(Object.entries(geometry.morphAttributes).map(([name, attributes]) => [name, attributes.map(packAttribute)])),
    morphTargetsRelative: geometry.morphTargetsRelative,
  }
}

export function unpackCdGeometry(data) {
  const attribute = value => new (value.float16 ? Float16BufferAttribute : BufferAttribute)(value.array, value.itemSize, value.normalized)
  const geometry = new BufferGeometry()
  for (const [name, value] of Object.entries(data.attributes)) geometry.setAttribute(name, attribute(value))
  if (data.index) geometry.setIndex(attribute(data.index))
  for (const [name, values] of Object.entries(data.morphAttributes)) geometry.morphAttributes[name] = values.map(attribute)
  geometry.morphTargetsRelative = data.morphTargetsRelative
  return geometry
}

export function cdGeometryBuffers(data) {
  const attributes = [...Object.values(data.attributes), ...Object.values(data.morphAttributes).flat()]
  if (data.index) attributes.push(data.index)
  return [...new Set(attributes.map(attribute => attribute.array.buffer))]
}

// Called in the worker, or cooperatively on the main thread when workers are unavailable.
export async function buildCdGeometryBatch(parts, load) {
  const geometries = []
  let merged
  try {
    for (const part of parts) {
      await load?.checkpoint()
      const source = unpackCdGeometry(part.geometry)
      const geometry = source.index ? source.toNonIndexed() : source
      if (geometry !== source) source.dispose()
      geometries.push(geometry)
      if (part.surfaceIndex != null) geometry.setAttribute('cdSurfaceIndex', new Float32BufferAttribute(
        new Float32Array(geometry.attributes.position.count).fill(part.surfaceIndex), 1,
      ))
      geometry.applyMatrix4(new Matrix4().fromArray(part.matrix))
    }
    await load?.checkpoint()
    merged = mergeGeometries(geometries)
    if (!merged) throw new Error('CD chassis geometries could not be combined')
    await load?.checkpoint()
    return load ? await mergeCdVertices(merged, 1e-6, load) : mergeVertices(merged, 1e-6)
  } finally {
    merged?.dispose()
    geometries.forEach(geometry => geometry.dispose())
  }
}
