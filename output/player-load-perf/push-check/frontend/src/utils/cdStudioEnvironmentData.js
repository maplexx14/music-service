import { CubeUVReflectionMapping, DataTexture, HalfFloatType, LinearFilter, LinearSRGBColorSpace, RGBAFormat } from 'three'

export function decodeCdStudioEnvironment(buffer) {
  if (buffer.byteLength < 12) throw new Error('Incomplete CD studio environment')
  const header = new DataView(buffer)
  if (header.getUint32(0, true) !== 0x4e454443) throw new Error('Invalid CD studio environment')
  const width = header.getUint32(4, true), height = header.getUint32(8, true)
  if (width !== 768 || height !== 1024 || buffer.byteLength !== 12 + width * height * 8) {
    throw new Error('Invalid CD studio environment dimensions')
  }
  return { width, height, pixels: new Uint16Array(buffer, 12) }
}

export function createCdStudioTexture({ width, height, pixels }) {
  const texture = new DataTexture(pixels, width, height, RGBAFormat, HalfFloatType)
  texture.mapping = CubeUVReflectionMapping
  texture.colorSpace = LinearSRGBColorSpace
  texture.minFilter = texture.magFilter = LinearFilter
  texture.generateMipmaps = false
  texture.needsUpdate = true
  return texture
}
