// Use the same resolution limits for initial allocation and later resizes.
export function cdCanvasSize({ stageWidth, height, mobile = false, cachedRendering = false,
  powerSave = false, constrainedDevice = false, devicePixelRatio = 1 }) {
  if (stageWidth < 1 || height < 1) return null
  const width = mobile ? stageWidth : Math.min(stageWidth, height * 1.4)
  const limited = powerSave || constrainedDevice
  const maxPixels = cachedRendering ? 2_000_000 : limited ? 750_000 : 1_750_000
  const ratioCap = cachedRendering ? 2 : limited ? 1 : 2
  const requested = cachedRendering ? Math.max(1.5, devicePixelRatio) : devicePixelRatio
  const pixelRatio = Math.min(requested, ratioCap, Math.sqrt(maxPixels / (width * height)))
  return { stageWidth, width, height, pixelRatio, pixelWidth: Math.floor(width * pixelRatio),
    pixelHeight: Math.floor(height * pixelRatio), key: `${stageWidth}:${width}:${height}:${pixelRatio}` }
}

export function applyCdDrawingBufferSize(renderer, size) {
  if (!size) return
  const current = renderer.getSize({ set(width, height) { this.x = width; this.y = height; return this } })
  if (current.x === size.width && current.y === size.height && renderer.getPixelRatio() === size.pixelRatio) return
  // One allocation, instead of setPixelRatio resizing the previous dimensions
  // followed by setSize allocating the actual viewport again.
  renderer.setDrawingBufferSize(size.width, size.height, size.pixelRatio)
}
