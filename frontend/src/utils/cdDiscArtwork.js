// Bake the aperture and soft edge into pixels once. Masking a projected DOM
// parent forces browsers to combine the spinning artwork and reflections in
// an intermediate surface on every frame, including software compositing.
export function maskCdDisc(ctx, size, hubRatio) {
  const radius = size / 2
  const mask = ctx.createRadialGradient(radius, radius, 0, radius, radius, radius)
  mask.addColorStop(0, 'transparent')
  mask.addColorStop(hubRatio, 'transparent')
  mask.addColorStop(hubRatio + 0.003, '#000')
  mask.addColorStop(1 - 2 / radius, '#000')
  mask.addColorStop(1, 'transparent')
  ctx.save()
  ctx.globalCompositeOperation = 'destination-in'
  ctx.fillStyle = mask
  ctx.fillRect(0, 0, size, size)
  ctx.restore()
}

const artworkFrames = new WeakMap()

// The print is baked once per cover for both the 3D surface and the mobile /
// queue bitmap. Circular details can rotate with the record; light stays on
// the separate reflection layer.
export function paintCdDiscPrint(ctx, size, image = null) {
  const center = size / 2
  ctx.fillStyle = '#c7ced3'
  ctx.fillRect(0, 0, size, size)
  if (image) {
    const side = Math.min(image.naturalWidth, image.naturalHeight)
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(image,
      (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side,
      0, 0, size, size,
    )
  }
  const coating = ctx.createRadialGradient(center, center, 0, center, center, center)
  for (const [stop, color] of [[0, '#00000000'], [0.7, '#ffffff00'],
    [0.978, '#18202c0c'], [0.984, '#18202c28'], [0.989, '#aebac7'],
    [0.994, '#d3dce5'], [0.998, '#9cabb9'], [1, '#b9c5d1']]) coating.addColorStop(stop, color)
  ctx.save()
  ctx.fillStyle = coating
  ctx.fillRect(0, 0, size, size)
  ctx.lineWidth = Math.max(0.35, size * 0.00055)
  ctx.strokeStyle = image ? '#ffffff09' : '#677c921c'
  for (let ratio = 0.15; ratio < 0.955; ratio += 0.016) {
    ctx.beginPath()
    ctx.arc(center, center, center * ratio, 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.restore()
}

function renderCdDiscArtwork(ctx, size, hubRatio, image) {
  ctx.clearRect(0, 0, size, size)
  // Keep the record opaque beneath missing or partially transparent artwork.
  paintCdDiscPrint(ctx, size, image)
  // Print right up to the spindle hole; the surrounding hub stays opaque.
  maskCdDisc(ctx, size, Math.min(hubRatio, 0.12))
  const radius = size / 2, center = size / 2
  const hub = ctx.createRadialGradient(center, center, 0, center, center, radius * 0.14)
  for (const [stop, color] of [[0, '#fff0'], [0.855, '#fff0'],
    [0.87, '#44505fa0'], [0.885, '#f3f7fc'], [0.91, '#c2cdd8'],
    [0.93, '#899ba980'], [0.945, '#fff0'], [1, '#fff0']]) hub.addColorStop(stop, color)
  ctx.save()
  ctx.fillStyle = hub
  ctx.beginPath()
  ctx.arc(center, center, radius * 0.14, 0, Math.PI * 2)
  ctx.fill()
  ctx.globalCompositeOperation = 'destination-out'
  ctx.beginPath()
  ctx.arc(center, center, radius * 0.12, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

export function paintCdDiscArtwork(ctx, size, hubRatio, image = null) {
  const document = ctx.canvas?.ownerDocument
  if (!document) { renderCdDiscArtwork(ctx, size, hubRatio, image); return }
  let frame = artworkFrames.get(ctx)
  if (!frame || frame.width !== size) {
    frame = document.createElement('canvas')
    frame.width = frame.height = size
    artworkFrames.set(ctx, frame)
  }
  renderCdDiscArtwork(frame.getContext('2d'), size, hubRatio, image)
  // Replace the displayed pixels in one operation. Clearing a live texture
  // first exposes an empty disc to a compositor during a track handoff.
  ctx.save()
  ctx.globalCompositeOperation = 'copy'
  ctx.drawImage(frame, 0, 0)
  ctx.restore()
}

export function paintCdDiscReflection(ctx, size, hubRatio, smoked) {
  ctx.clearRect(0, 0, size, size)
  ctx.fillStyle = smoked ? '#10172658' : '#0c101c0e'
  ctx.fillRect(0, 0, size, size)
  // A soft studio reflection stays still while the artwork spins beneath it.
  const light = ctx.createRadialGradient(size * 0.18, size * 0.1, 0,
    size * 0.18, size * 0.1, size * 0.92)
  light.addColorStop(0, smoked ? '#edf4ff20' : '#f4f8ff32')
  light.addColorStop(0.34, '#e8f0ff0c')
  light.addColorStop(0.7, '#ffffff00')
  light.addColorStop(1, '#ffffff00')
  ctx.fillStyle = light
  ctx.fillRect(0, 0, size, size)
  maskCdDisc(ctx, size, hubRatio)
  // The fixed spindle casts a soft contact shadow onto the rotating hub.
  // Keep its center transparent so the raised 3D crown remains uncovered.
  const center = size / 2
  const shadow = ctx.createRadialGradient(center, size * 0.503, 0,
    center, size * 0.503, size * 0.091)
  for (const [stop, color] of [[0, '#07101b00'], [0.56, '#07101b00'],
    [0.68, '#07101b3d'], [0.8, '#07101b14'], [1, '#07101b00']]) shadow.addColorStop(stop, color)
  ctx.save()
  ctx.fillStyle = shadow
  ctx.fillRect(0, 0, size, size)
  ctx.globalCompositeOperation = 'destination-out'
  ctx.beginPath()
  ctx.arc(center, center, center * 0.12, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}
