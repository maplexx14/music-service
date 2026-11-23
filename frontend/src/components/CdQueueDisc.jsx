import { memo, useLayoutEffect, useRef, useState } from 'react'
import { useDiscCover } from '../hooks/useDiscCover'
import { resolveCoverUrl } from '../utils/media'
import { paintCdDiscArtwork } from '../utils/cdDiscArtwork'
import { subscribeCdDiscRecord, takeCdDiscRecord } from '../utils/cdDiscRecords'
import { settleCdQueueRecord } from '../utils/cdQueueHandoff'

const DIAMETER = 320
const PADDING = 80
const SIZE = DIAMETER + PADDING * 2
// Bound decoded preview pixels. Navigation reuses these pixels; gradients,
// masks and shadows never need rebuilding during a queue animation.
const frames = new Map()
const MAX_FRAMES = 16
const circle = (ctx, radius) => { ctx.beginPath(); ctx.arc(SIZE / 2, SIZE / 2, radius, 0, Math.PI * 2) }
function paintFrame(image, featured, mobile) {
  const frame = document.createElement('canvas')
  frame.width = frame.height = SIZE
  const ctx = frame.getContext('2d')
  const radius = DIAMETER / 2
  ctx.save()
  ctx.shadowColor = mobile ? '#0005' : featured ? '#0009' : '#0008'
  ctx.shadowBlur = (mobile ? 18 : featured ? 50 : 30) * DIAMETER / 270
  ctx.shadowOffsetY = (mobile ? 6 : featured ? 18 : 14) * DIAMETER / 270
  circle(ctx, radius)
  ctx.fillStyle = '#dce3ed'
  ctx.fill()
  ctx.restore()
  ctx.save()
  ctx.globalCompositeOperation = 'destination-out'
  circle(ctx, radius)
  ctx.fill()
  ctx.restore()
  const surface = document.createElement('canvas')
  surface.width = surface.height = DIAMETER
  paintCdDiscArtwork(surface.getContext('2d'), DIAMETER, 0.2, image)
  ctx.drawImage(surface, PADDING, PADDING)
  return frame
}

export default memo(function CdQueueDisc({ track, recordKey, slot, generation = 0, featured, mobile }) {
  const { src } = useDiscCover(resolveCoverUrl(track?.cover_url, 'card'), null, 'auto')
  const hostRef = useRef(null)
  const transferredRef = useRef(false)
  const [recordVersion, setRecordVersion] = useState(0)
  useLayoutEffect(() => subscribeCdDiscRecord(recordKey, () => setRecordVersion(value => value + 1)), [recordKey])
  useLayoutEffect(() => {
    const host = hostRef.current
    settleCdQueueRecord(host, slot)
    const record = takeCdDiscRecord(recordKey)
    if (record) {
      record.place(host)
      transferredRef.current = true
      return undefined
    }
    if (transferredRef.current && host.querySelector('canvas')) return undefined
    transferredRef.current = false
    let canvas = host.querySelector('canvas')
    if (!canvas) {
      canvas = document.createElement('canvas')
      canvas.width = canvas.height = Math.round(512 * Math.min(2, Math.max(1, globalThis.devicePixelRatio || 1)))
      host.append(canvas)
    }
    canvas.dataset.cdTrackId = String(track?.id ?? '')
    const key = JSON.stringify([src, featured, mobile])
    let cancelled = false
    const show = (image) => {
      if (cancelled) return
      let frame = frames.get(key)
      if (!frame) {
        frame = paintFrame(image, featured, mobile)
        frames.set(key, frame)
        while (frames.size > MAX_FRAMES) frames.delete(frames.keys().next().value)
      } else { frames.delete(key); frames.set(key, frame) }
      const ctx = canvas.getContext('2d')
      ctx.save()
      ctx.globalCompositeOperation = 'copy'
      ctx.drawImage(frame, 0, 0, canvas.width, canvas.height)
      ctx.restore()
      canvas.dataset.cdArtworkReady = 'true'
    }
    let image
    if (!src || frames.has(key)) show(null)
    else {
      image = new Image()
      image.onload = () => show(image)
      image.onerror = () => show(null)
      image.src = src
      if (image.complete && image.naturalWidth) show(image)
    }
    return () => { cancelled = true; if (image) { image.onload = null; image.onerror = null } }
  }, [src, recordKey, slot, recordVersion, generation, featured, mobile])
  return <span ref={hostRef} className="hero-disc is-cd cd-queue-bitmap" aria-hidden="true" />
})
