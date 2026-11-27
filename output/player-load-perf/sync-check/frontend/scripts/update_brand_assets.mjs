import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import sharp from 'sharp'

// Regeneration helper: install the image processor without changing runtime
// dependencies, then run from frontend/: npm install --no-save sharp &&
// node scripts/update_brand_assets.mjs

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const FRONTEND_DIR = path.resolve(SCRIPT_DIR, '..')
const PUBLIC_DIR = path.join(FRONTEND_DIR, 'public')
const ASSETS_DIR = path.join(FRONTEND_DIR, 'src', 'assets')
const ANDROID_RES_DIR = path.resolve(FRONTEND_DIR, '..', 'android', 'app', 'src', 'main', 'res')
const MASTER = path.join(ASSETS_DIR, 'brand-source.png')
const SOURCE = path.resolve(process.argv.slice(2).find(argument => !argument.startsWith('--')) || MASTER)
const VERSION = 'v7'
const BOLT_COLOR = [138, 92, 248]
// Match the original heart's counterclockwise lean between B and LT.
const WORDMARK_HEART_ANGLE = -19.5
const BOLT_REGION = 'M.9 .12L1.05 .12L1.05 .52L.49 1.04L.39 1.04L.672 .624L.463 .674L.46 .632L.74 .35Z'

const SPLASH_SIZES = [
  [1290, 2796, 3],
  [1179, 2556, 3],
  [1284, 2778, 3],
  [1170, 2532, 3],
  [1125, 2436, 3],
  [1242, 2688, 3],
  [828, 1792, 2],
  [1242, 2208, 3],
  [750, 1334, 2],
  [640, 1136, 2],
]

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const smoothstep = (edge0, edge1, value) => {
  const x = clamp((value - edge0) / (edge1 - edge0), 0, 1)
  return x * x * (3 - 2 * x)
}

async function rgbaBuffer(input) {
  return sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
}

async function boltRegion(width, height) {
  return sharp(Buffer.from(`<svg width="${width}" height="${height}" viewBox="0 0 1 1" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg"><path d="${BOLT_REGION}" fill="white"/></svg>`)).png().toBuffer()
}

function heartInterior(alpha, width, height) {
  const outside = new Uint8Array(alpha.length)
  const queue = new Int32Array(alpha.length)
  let head = 0
  let tail = 0
  const visit = pixel => {
    if (outside[pixel] || alpha[pixel] >= 128) return
    outside[pixel] = 1
    queue[tail++] = pixel
  }
  for (let x = 0; x < width; x += 1) {
    visit(x)
    visit((height - 1) * width + x)
  }
  for (let y = 0; y < height; y += 1) {
    visit(y * width)
    visit(y * width + width - 1)
  }
  while (head < tail) {
    const pixel = queue[head++]
    const x = pixel % width
    if (x > 0) visit(pixel - 1)
    if (x + 1 < width) visit(pixel + 1)
    if (pixel >= width) visit(pixel - width)
    if (pixel + width < alpha.length) visit(pixel + width)
  }
  return Uint8Array.from(alpha, (a, pixel) => !outside[pixel] && a < 128 ? 255 : 0)
}

function distanceFromInterior(interior, width, height) {
  const distance = Float32Array.from(interior, value => value ? 0 : width + height)
  const diagonal = Math.SQRT2
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x
      if (x) distance[pixel] = Math.min(distance[pixel], distance[pixel - 1] + 1)
      if (y) distance[pixel] = Math.min(distance[pixel], distance[pixel - width] + 1)
      if (x && y) distance[pixel] = Math.min(distance[pixel], distance[pixel - width - 1] + diagonal)
      if (y && x + 1 < width) distance[pixel] = Math.min(distance[pixel], distance[pixel - width + 1] + diagonal)
    }
  }
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const pixel = y * width + x
      if (x + 1 < width) distance[pixel] = Math.min(distance[pixel], distance[pixel + 1] + 1)
      if (y + 1 < height) distance[pixel] = Math.min(distance[pixel], distance[pixel + width] + 1)
      if (x + 1 < width && y + 1 < height) distance[pixel] = Math.min(distance[pixel], distance[pixel + width + 1] + diagonal)
      if (x && y + 1 < height) distance[pixel] = Math.min(distance[pixel], distance[pixel + width - 1] + diagonal)
    }
  }
  return distance
}

async function boltLayers(mark) {
  const raw = await rgbaBuffer(mark)
  const { width, height } = raw.info
  const alpha = Uint8Array.from({ length: width * height }, (_, pixel) => raw.data[pixel * 4 + 3])
  const interior = heartInterior(alpha, width, height)
  const distance = distanceFromInterior(interior, width, height)
  const region = await rgbaBuffer(await boltRegion(width, height))
  const purple = Buffer.alloc(alpha.length)
  const edge = Buffer.alloc(alpha.length)
  const whiteWidth = Math.min(width, height) * 0.027
  for (let pixel = 0; pixel < alpha.length; pixel += 1) {
    const regionShare = region.data[pixel * 4 + 3] / 255 * smoothstep(0.12, 0.27, Math.floor(pixel / width) / height)
    const tintShare = regionShare * smoothstep(whiteWidth, whiteWidth + 2, distance[pixel])
    purple[pixel] = Math.round(alpha[pixel] * tintShare)
    edge[pixel] = Math.round(alpha[pixel] * (regionShare - tintShare))
  }
  return { raw, purple, edge }
}

async function cleanLogo() {
  const source = await sharp(SOURCE)
    .rotate()
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const { width, height, channels } = source.info
  const alpha = Buffer.alloc(width * height)

  for (let pixel = 0, offset = 0; pixel < alpha.length; pixel += 1, offset += channels) {
    const minChannel = Math.min(source.data[offset], source.data[offset + 1], source.data[offset + 2])
    alpha[pixel] = Math.round(smoothstep(50, 210, minChannel) * 255)
  }

  let left = width
  let top = height
  let right = -1
  let bottom = -1
  const rgba = Buffer.alloc(width * height * 4)
  for (let pixel = 0; pixel < alpha.length; pixel += 1) {
    const a = alpha[pixel] < 2 ? 0 : alpha[pixel]
    const offset = pixel * channels
    // Preserve the pale blue of the supplied sign. Edge pixels use the same
    // foreground colour so the removed purple background cannot leave a halo.
    rgba[pixel * 4] = a === 255 ? source.data[offset] : 223
    rgba[pixel * 4 + 1] = a === 255 ? source.data[offset + 1] : 237
    rgba[pixel * 4 + 2] = a === 255 ? source.data[offset + 2] : 242
    rgba[pixel * 4 + 3] = a
    if (a < 8) continue
    const x = pixel % width
    const y = Math.floor(pixel / width)
    if (x < left) left = x
    if (x > right) right = x
    if (y < top) top = y
    if (y > bottom) bottom = y
  }

  if (right < left || bottom < top) throw new Error('Could not find the white logo in the source image')

  const fullMark = await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer()
  const crop = {
    left,
    top,
    width: right - left + 1,
    height: bottom - top + 1,
  }
  const { raw: cropped, purple } = await boltLayers(await sharp(fullMark).extract(crop).png().toBuffer())
  const iconPixels = Buffer.from(source.data)
  for (let y = 0; y < crop.height; y += 1) {
    for (let x = 0; x < crop.width; x += 1) {
      const offset = (y * crop.width + x) * 4
      const a = cropped.data[offset + 3]
      const share = a ? purple[y * crop.width + x] / a : 0
      const iconOffset = ((y + crop.top) * width + x + crop.left) * channels
      const photoShare = share * cropped.data[offset + 3] / 255
      for (let channel = 0; channel < 3; channel += 1) {
        cropped.data[offset + channel] = Math.round(cropped.data[offset + channel] * (1 - share) + BOLT_COLOR[channel] * share)
        iconPixels[iconOffset + channel] = Math.round(source.data[iconOffset + channel] * (1 - photoShare) + BOLT_COLOR[channel] * photoShare)
      }
    }
  }
  const croppedMark = await sharp(cropped.data, { raw: cropped.info }).png().toBuffer()
  const icon = await sharp(iconPixels, { raw: source.info }).png().toBuffer()
  const sourcePng = await sharp(SOURCE)
    .rotate()
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer()

  return { croppedMark, icon, sourcePng }
}

async function squareMark(mark, size, occupancy = 0.92) {
  const target = Math.round(size * occupancy)
  const resized = await sharp(mark)
    .resize(target, target, { fit: 'inside', withoutEnlargement: false })
    .png()
    .toBuffer({ resolveWithObject: true })
  const left = Math.floor((size - resized.info.width) / 2)
  const top = Math.floor((size - resized.info.height) / 2)
  return sharp({
    create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: resized.data, left, top }])
    .png()
    .toBuffer()
}

async function writePng(file, image, size) {
  const output = await sharp(image)
    .resize(size, size, { fit: 'cover' })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer()
  await writeFile(file, output)
}

async function writeWebp(file, image, size) {
  const output = await sharp(image)
    .resize(size, size, { fit: 'cover' })
    .webp({ lossless: true, effort: 6 })
    .toBuffer()
  await writeFile(file, output)
}

async function makeWordmark(templateName, mark, clearLeft, clearRight) {
  const template = await rgbaBuffer(path.join(SCRIPT_DIR, templateName))
  const { width, height } = template.info
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4
      if (x >= clearLeft && x < clearRight) {
        template.data.fill(0, offset, offset + 4)
      } else {
        // The source lettering was flattened onto black. Recover its alpha
        // from brightness and keep white edge pixels free of black fringes.
        const brightness = Math.min(template.data[offset], template.data[offset + 1], template.data[offset + 2])
        template.data[offset + 3] = Math.round(template.data[offset + 3] * brightness / 255)
        template.data[offset] = template.data[offset + 1] = template.data[offset + 2] = 255
      }
    }
  }
  const tiltedMark = await sharp(mark)
    .rotate(WORDMARK_HEART_ANGLE, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png().toBuffer()
  const resized = await sharp(tiltedMark)
    .trim({ threshold: 1 })
    .resize(Math.round((clearRight - clearLeft) * 0.94), Math.round(height * 0.94), { fit: 'inside' })
    .png().toBuffer({ resolveWithObject: true })
  return sharp(template.data, { raw: template.info })
    .composite([{ input: resized.data, left: clearLeft + Math.floor((clearRight - clearLeft - resized.info.width) / 2), top: Math.floor((height - resized.info.height) / 2) }])
    .png().toBuffer()
}

async function maskImage(alpha, width, height, format = 'webp') {
  const rgba = Buffer.alloc(width * height * 4, 255)
  for (let pixel = 0; pixel < alpha.length; pixel += 1) rgba[pixel * 4 + 3] = alpha[pixel]
  const image = sharp(rgba, { raw: { width, height, channels: 4 } })
  return format === 'png' ? image.png().toBuffer() : image.webp({ lossless: true, effort: 6 }).toBuffer()
}

async function makeLikeLayers(mark) {
  const square = await squareMark(mark, 128, 0.92)
  const raw = await rgbaBuffer(square)
  const alpha = Buffer.alloc(128 * 128)
  for (let pixel = 0; pixel < alpha.length; pixel += 1) alpha[pixel] = raw.data[pixel * 4 + 3]
  const hole = heartInterior(alpha, 128, 128)
  const interior = Buffer.from(hole)
  // Overlap the ink by one pixel so its antialiased inner edge cannot leave
  // a dark seam between the solid fill and the outline.
  for (let y = 0; y < 128; y += 1) {
    for (let x = 0; x < 128; x += 1) {
      if (!hole[y * 128 + x]) continue
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const xx = x + dx
          const yy = y + dy
          if (xx >= 0 && xx < 128 && yy >= 0 && yy < 128) interior[yy * 128 + xx] = 255
        }
      }
    }
  }
  const { raw: fullMark, purple, edge } = await boltLayers(mark)
  const { width, height } = fullMark.info
  const boltMask = await rgbaBuffer(await squareMark(await maskImage(purple, width, height, 'png'), 128, 0.92))
  const edgeMask = await rgbaBuffer(await squareMark(await maskImage(edge, width, height, 'png'), 128, 0.92))
  const bolt = Buffer.alloc(alpha.length)
  const line = Buffer.alloc(alpha.length)
  const whiteEdge = Buffer.alloc(alpha.length)
  for (let pixel = 0; pixel < alpha.length; pixel += 1) {
    bolt[pixel] = Math.min(alpha[pixel], boltMask.data[pixel * 4 + 3])
    whiteEdge[pixel] = edgeMask.data[pixel * 4 + 3]
    line[pixel] = Math.max(0, alpha[pixel] - bolt[pixel])
  }

  await Promise.all([
    writeFile(path.join(ASSETS_DIR, 'like-heart-fill.webp'), await maskImage(interior, 128, 128)),
    writeFile(path.join(ASSETS_DIR, 'like-heart-line.webp'), await maskImage(line, 128, 128)),
    writeFile(path.join(ASSETS_DIR, 'like-heart-bolt.webp'), await maskImage(bolt, 128, 128)),
    writeFile(path.join(ASSETS_DIR, 'like-heart-bolt-edge.webp'), await maskImage(whiteEdge, 128, 128)),
  ])
}

async function makeSplash(icon, width, height, scale, version) {
  const side = Math.round(width * 0.245)
  const radius = Math.round(side * 0.225)
  const roundedMask = Buffer.from(
    `<svg width="${side}" height="${side}" xmlns="http://www.w3.org/2000/svg"><rect width="${side}" height="${side}" rx="${radius}" fill="#fff"/></svg>`,
  )
  const roundedIcon = await sharp(icon)
    .resize(side, side, { fit: 'cover' })
    .composite([{ input: roundedMask, blend: 'dest-in' }])
    .png()
    .toBuffer()
  const left = Math.floor((width - side) / 2)
  const top = Math.round(height * 0.485 - side / 2)
  const output = await sharp({ create: { width, height, channels: 3, background: '#000' } })
    .composite([{ input: roundedIcon, left, top }])
    .png({ compressionLevel: 9, adaptiveFiltering: true, palette: true, colours: 256, dither: 0.75 })
    .toBuffer()
  await writeFile(path.join(PUBLIC_DIR, `apple-splash-${version}-${width}-${height}.png`), output)
  return `    <link rel="apple-touch-startup-image" href="/apple-splash-${version}-${width}-${height}.png" media="(device-width: ${Math.floor(width / scale)}px) and (device-height: ${Math.floor(height / scale)}px) and (-webkit-device-pixel-ratio: ${scale})" />`
}

async function main() {
  await mkdir(PUBLIC_DIR, { recursive: true })
  const { croppedMark, icon, sourcePng } = await cleanLogo()
  if (process.argv.includes('--likes-only')) {
    await makeLikeLayers(croppedMark)
    console.log('Updated like masks')
    return
  }

  const loaderMark = await squareMark(croppedMark, 512, 0.92)
  const heroMark = await squareMark(croppedMark, 1024, 0.94)
  const logoWebp = await sharp(loaderMark).webp({ quality: 92, alphaQuality: 100, effort: 6 }).toBuffer()
  const compactWordmark = await makeWordmark('brand-wordmark-compact.png', croppedMark, 160, 410)
  const wideWordmark = await makeWordmark('brand-wordmark-wide.png', croppedMark, 198, 510)
  const compactWebp = await sharp(compactWordmark).webp({ quality: 95, alphaQuality: 100, effort: 6 }).toBuffer()
  const wideWebp = await sharp(wideWordmark).webp({ quality: 95, alphaQuality: 100, effort: 6 }).toBuffer()
  await Promise.all([
    writeFile(MASTER, sourcePng),
    writeFile(path.join(ASSETS_DIR, 'brand-mark.png'), croppedMark),
    writeFile(path.join(ASSETS_DIR, 'player-invite-logo.jpg'), await sharp(icon).jpeg({ quality: 98 }).toBuffer()),
    writeFile(path.join(ASSETS_DIR, 'loader-heart.webp'), logoWebp),
    writeFile(path.join(ASSETS_DIR, 'liked-hero-heart.webp'), await sharp(heroMark).webp({ quality: 92, alphaQuality: 100, effort: 6 }).toBuffer()),
    writeFile(path.join(ASSETS_DIR, 'bolt-wordmark.webp'), compactWebp),
    writeFile(path.join(ASSETS_DIR, 'bolt-wordmark-wide.webp'), wideWebp),
    writeFile(path.join(PUBLIC_DIR, 'logoBolt1.PNG'), compactWordmark),
    writeFile(path.join(PUBLIC_DIR, 'logoBolt1.webp'), compactWebp),
    writeFile(path.join(PUBLIC_DIR, 'logoBolt.PNG'), wideWordmark),
    writeFile(path.join(PUBLIC_DIR, 'logoBoltwo.png'), wideWordmark),
    writeFile(path.join(PUBLIC_DIR, 'logoBoltwo.webp'), wideWebp),
  ])
  if (process.argv.includes('--wordmarks-only')) {
    console.log('Updated transparent wordmarks and interface marks')
    return
  }
  await makeLikeLayers(croppedMark)

  const iconPngs = [
    ['favicon-64.png', 1025],
    ['apple-touch-icon.png', 1025],
    ['favicon-64-64.png', 64],
    ['favicon-641.png', 64],
    ['favicon-64-v2.png', 64],
    ['favicon-64-v4.png', 64],
    ['favicon-64-v5.png', 64],
    ['favicon-64-v6.png', 64],
    [`favicon-64-${VERSION}.png`, 64],
    ['apple-touch-icon-v2.png', 180],
    ['apple-touch-icon-v3.png', 180],
    ['apple-touch-icon-v4.png', 180],
    ['apple-touch-icon-v5.png', 180],
    ['apple-touch-icon-v6.png', 180],
    [`apple-touch-icon-${VERSION}.png`, 180],
    ['icon-192-v3.png', 192],
    ['icon-192-v4.png', 192],
    ['icon-192-v5.png', 192],
    ['icon-192-v6.png', 192],
    [`icon-192-${VERSION}.png`, 192],
    ['icon-512-v3.png', 512],
    ['icon-512-v4.png', 512],
    ['icon-512-v5.png', 512],
    ['icon-512-v6.png', 512],
    [`icon-512-${VERSION}.png`, 512],
  ]
  const iconWebps = [
    ['icon-192-v2.webp', 192],
    ['icon-192-v3.webp', 192],
    ['icon-192-v4.webp', 192],
    ['icon-192-v5.webp', 192],
    ['icon-192-v6.webp', 192],
    [`icon-192-${VERSION}.webp`, 192],
    ['icon-512-v2.webp', 512],
    ['icon-512-v3.webp', 512],
    ['icon-512-v4.webp', 512],
    ['icon-512-v5.webp', 512],
    ['icon-512-v6.webp', 512],
    [`icon-512-${VERSION}.webp`, 512],
  ]
  await Promise.all([
    ...iconPngs.map(([name, size]) => writePng(path.join(PUBLIC_DIR, name), icon, size)),
    ...iconWebps.map(([name, size]) => writeWebp(path.join(PUBLIC_DIR, name), icon, size)),
    writeFile(path.join(PUBLIC_DIR, 'icon.jpg'), await sharp(icon).resize(512, 512).jpeg({ quality: 92, mozjpeg: true }).toBuffer()),
    writeFile(path.join(PUBLIC_DIR, `icon-maskable-512-${VERSION}.png`), await sharp(icon).resize(460, 460).extend({ top: 26, bottom: 26, left: 26, right: 26, extendWith: 'mirror' }).png().toBuffer()),
  ])

  const splashLinks = []
  for (const version of ['v3', 'v4', 'v5', 'v6', VERSION]) {
    for (const [width, height, scale] of SPLASH_SIZES) {
      splashLinks.push(await makeSplash(icon, width, height, scale, version))
    }
  }

  const androidSizes = [
    ['mipmap-mdpi', 48],
    ['mipmap-hdpi', 72],
    ['mipmap-xhdpi', 96],
    ['mipmap-xxhdpi', 144],
    ['mipmap-xxxhdpi', 192],
  ]
  await Promise.all(androidSizes.map(async ([folder, size]) => {
    const directory = path.join(ANDROID_RES_DIR, folder)
    await mkdir(directory, { recursive: true })
    await writePng(path.join(directory, 'ic_launcher.png'), icon, size)
  }))

  const notificationDir = path.join(ANDROID_RES_DIR, 'drawable-xxxhdpi')
  await mkdir(notificationDir, { recursive: true })
  const notification = await rgbaBuffer(await squareMark(croppedMark, 96, 0.92))
  for (let offset = 0; offset < notification.data.length; offset += 4) {
    notification.data[offset] = 255
    notification.data[offset + 1] = 255
    notification.data[offset + 2] = 255
  }
  await writeFile(path.join(notificationDir, 'brand_mark_notification.png'), await sharp(notification.data, { raw: notification.info }).png().toBuffer())

  console.log(`Updated brand assets from ${SOURCE}`)
  console.log(`Use these ${VERSION} splash links in index.html:`)
  console.log(splashLinks.slice(-SPLASH_SIZES.length).join('\n'))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
