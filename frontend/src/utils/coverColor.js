// Цвета фона главной выводятся из обложки текущего трека. Здесь — чистая
// арифметика (её можно проверять в отрыве от DOM), загрузка картинки и сам
// хук живут в hooks/useCoverColors.js.

// Размер выборки: 16×16 = 256 пикселей. Усредняет их сам браузер при
// drawImage — это дешевле любого ручного прохода по полноразмерной обложке.
export const SAMPLE = 16

// Ниже этой насыщенности пиксель считаем серым и на тон не пускаем: формально
// тон у серого есть, но он случаен (шум сжатия), и ч/б обложка красила бы фон
// в произвольный цвет.
const MIN_SATURATION = 0.22
// Совсем тёмные и совсем светлые пиксели тоже выбрасываем: их тон либо не
// читается, либо это блики и рамки, а не цвет обложки.
const MIN_LIGHTNESS = 0.12
const MAX_LIGHTNESS = 0.92
// Корзины тона по 15°.
const HUE_BINS = 24
// Меньше этого суммарного веса — считаем, что выраженного цвета у обложки нет.
// 2.5 ≈ десяток насыщенных пикселей из 256.
const MIN_WEIGHT = 2.5
// И отдельно требуем, чтобы «цветных» пикселей было хотя бы 1/16 выборки:
// одна яркая точка не должна перекрашивать весь фон.
const MIN_VIVID_PIXELS = SAMPLE

// Мягкий проход: пороги для обложек, у которых выраженного цвета нет, но цвет
// всё-таки есть. Тёмные и пастельные обложки на уменьшенной копии теряют
// насыщенность (усреднение по ячейке съедает её), и строгие пороги выше
// отправляли их в дефолтный фиолетовый. Со стороны это выглядит как «фон не
// обновился под новый трек», поэтому во втором проходе пороги опущены, а тон
// считается средним по всем цветным пикселям, а не по победившей корзине.
const SOFT_MIN_SATURATION = 0.1
const SOFT_MIN_LIGHTNESS = 0.06
const SOFT_MAX_LIGHTNESS = 0.96
const SOFT_MIN_WEIGHT = 0.8
const SOFT_MIN_VIVID_PIXELS = 8

// От обложки берём ТОЛЬКО тон. Три стопа задают дефолтную фиолетовую палитру
// hero (#d2adff / #943dff / #4d287b) по светлоте и насыщенности — поэтому фон
// всегда выглядит тем же градиентом, но в цвете трека, а белая кнопка «поток»
// остаётся контрастной на любом оттенке. Светлота подобрана так, чтобы фон
// оставался тёмным: шейдер ещё раз поднимает контраст (uContrast = 1.5), и
// светлые стопы на экране заметно светлее, чем здесь.
const STOPS = [
  { s: 1, l: 0.84 },
  { s: 1, l: 0.62 },
  { s: 0.51, l: 0.32 },
]

export function rgbToHsl(r, g, b) {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return [0, 0, l]
  const s = d / (1 - Math.abs(2 * l - 1))
  let h
  if (max === rn) h = 60 * (((gn - bn) / d) % 6)
  else if (max === gn) h = 60 * ((bn - rn) / d + 2)
  else h = 60 * ((rn - gn) / d + 4)
  return [(h + 360) % 360, s, l]
}

export function hslToHex(h, s, l) {
  const k = (n) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  const to = (v) =>
    Math.round(v * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${to(f(0))}${to(f(8))}${to(f(4))}`
}

// Доминирующий ТОН обложки, а не средний цвет: среднее по картинке почти
// всегда уходит в серый (взаимно дополнительные цвета гасят друг друга), и
// градиент из него получался бы грязным. Поэтому пиксели уменьшенной копии
// раскладываются по корзинам тона с весом по насыщенности — побеждает самый
// цветной участок обложки, а не самый большой (иначе фон уводило бы в цвет
// фона фотографии или полей постера).
export function dominantHue(data) {
  return pickHue(data, {
    minSaturation: MIN_SATURATION,
    minLightness: MIN_LIGHTNESS,
    maxLightness: MAX_LIGHTNESS,
    minWeight: MIN_WEIGHT,
    minVivid: MIN_VIVID_PIXELS,
    pickBin: true,
  })
}

// Тон обложки без выраженного доминирующего участка: средний по всем цветным
// пикселям (мягкие пороги выше). Возвращает null, если цвета в обложке нет
// вовсе — ч/б фотографию фон по-прежнему не красит.
export function averageHue(data) {
  return pickHue(data, {
    minSaturation: SOFT_MIN_SATURATION,
    minLightness: SOFT_MIN_LIGHTNESS,
    maxLightness: SOFT_MAX_LIGHTNESS,
    minWeight: SOFT_MIN_WEIGHT,
    minVivid: SOFT_MIN_VIVID_PIXELS,
    pickBin: false,
  })
}

// Пиксели уменьшенной копии → палитра градиента (или null, если цвета нет).
// Два прохода: сначала строгий доминирующий тон, затем мягкий средний. Без
// второго прохода часть обложек (тёмные, пастельные) проваливалась в дефолтную
// палитру, и на смене трека казалось, что фон не обновился.
export function paletteFromPixels(data) {
  const hue = dominantHue(data) ?? averageHue(data)
  return hue == null ? null : paletteFromHue(hue)
}

function pickHue(data, { minSaturation, minLightness, maxLightness, minWeight, minVivid, pickBin }) {
  if (!data) return null
  const bins = new Float64Array(HUE_BINS)
  // Средний тон внутри победившей корзины считаем через сумму синусов и
  // косинусов: обычное среднее ломается на переходе через 0°/360° (красный).
  const sin = new Float64Array(HUE_BINS)
  const cos = new Float64Array(HUE_BINS)
  let vivid = 0

  for (let i = 0; i < data.length; i += 4) {
    const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2])
    if (s < minSaturation || l < minLightness || l > maxLightness) continue
    vivid += 1
    const bin = Math.min(HUE_BINS - 1, Math.floor((h / 360) * HUE_BINS))
    const rad = (h * Math.PI) / 180
    bins[bin] += s
    sin[bin] += Math.sin(rad) * s
    cos[bin] += Math.cos(rad) * s
  }

  let best = -1
  let weight = 0
  for (let i = 0; i < HUE_BINS; i += 1) {
    weight += bins[i]
    if (best < 0 || bins[i] > bins[best]) best = i
  }
  if (best < 0 || vivid < minVivid) return null
  if (pickBin && bins[best] < minWeight) return null
  if (!pickBin && weight < minWeight) return null

  const bin = pickBin ? best : null
  let sumSin = 0
  let sumCos = 0
  for (let i = 0; i < HUE_BINS; i += 1) {
    if (bin !== null && i !== bin) continue
    sumSin += sin[i]
    sumCos += cos[i]
  }
  if (sumSin === 0 && sumCos === 0) return null
  const hue = (Math.atan2(sumSin, sumCos) * 180) / Math.PI
  return (hue + 360) % 360
}


// Три стопа градиента по доминирующему тону обложки.
export function paletteFromHue(hue) {
  return STOPS.map(({ s, l }) => hslToHex(hue, s, l))
}

// Палитра по умолчанию — те же цвета, что были зашиты в hero (и в CSS-заглушку
// .hero-grainient-static), на случай серой обложки или её отсутствия. Совпадает
// с paletteFromHue(267) — тоном прежней фиолетовой палитры.
export const DEFAULT_HERO_COLORS = ['#d2adff', '#943dff', '#4d287b']
