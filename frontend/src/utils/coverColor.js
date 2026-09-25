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

// От обложки берём ТОЛЬКО тон. Три стопа повторяют дефолтную фиолетовую
// палитру hero (#e0c3ff / #a259ff / #6a3093) по светлоте и насыщенности —
// поэтому фон всегда выглядит тем же градиентом, но в цвете трека, а белая
// кнопка «поток» остаётся контрастной на любом оттенке.
const STOPS = [
  { s: 1, l: 0.882 },
  { s: 1, l: 0.675 },
  { s: 0.51, l: 0.382 },
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
  if (!data) return null
  const bins = new Float64Array(HUE_BINS)
  // Средний тон внутри победившей корзины считаем через сумму синусов и
  // косинусов: обычное среднее ломается на переходе через 0°/360° (красный).
  const sin = new Float64Array(HUE_BINS)
  const cos = new Float64Array(HUE_BINS)
  let vivid = 0

  for (let i = 0; i < data.length; i += 4) {
    const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2])
    if (s < MIN_SATURATION || l < MIN_LIGHTNESS || l > MAX_LIGHTNESS) continue
    vivid += 1
    const bin = Math.min(HUE_BINS - 1, Math.floor((h / 360) * HUE_BINS))
    const rad = (h * Math.PI) / 180
    bins[bin] += s
    sin[bin] += Math.sin(rad) * s
    cos[bin] += Math.cos(rad) * s
  }

  let best = -1
  for (let i = 0; i < HUE_BINS; i += 1) {
    if (best < 0 || bins[i] > bins[best]) best = i
  }
  if (best < 0 || bins[best] < MIN_WEIGHT || vivid < MIN_VIVID_PIXELS) return null

  const hue = (Math.atan2(sin[best], cos[best]) * 180) / Math.PI
  return (hue + 360) % 360
}

// Три стопа градиента по доминирующему тону обложки.
export function paletteFromHue(hue) {
  return STOPS.map(({ s, l }) => hslToHex(hue, s, l))
}

// Палитра по умолчанию — те же цвета, что были зашиты в hero (и в CSS-заглушку
// .hero-grainient-static), на случай серой обложки или её отсутствия.
export const DEFAULT_HERO_COLORS = ['#e0c3ff', '#a259ff', '#6a3093']
