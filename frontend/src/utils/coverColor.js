// Цвета фона главной выводятся из обложки текущего трека. Здесь — чистая
// арифметика (её можно проверять в отрыве от DOM), загрузка картинки и сам
// хук живут в hooks/useCoverColors.js.
//
// Палитра — три стопа: светлый угол градиента, основной тон и тёмный угол.
// Основной тон и тёмный угол строятся по ДОМИНИРУЮЩЕМУ цвету обложки, светлый
// угол — по ВТОРОМУ по доминантности (раньше там стоял почти белый оттенок
// основного тона, и угол градиента читался как белое пятно). Обложки без цвета
// вовсе — чёрные, серые, белые — получают градиент из собственной светлоты:
// чёрная обложка даёт тёмный градиент, а не дефолтную фиолетовую палитру.

// Размер выборки: 16×16 = 256 пикселей. Усредняет их сам браузер при
// drawImage — это дешевле любого ручного прохода по полноразмерной обложке.
export const SAMPLE = 16

// Корзины тона по 15°.
const HUE_BINS = 24
// Второй цвет ищем не ближе этого угла (в корзинах) от первого: соседняя
// корзина — это тот же цвет, а не второй.
const SECOND_MIN_BINS = 3
// Второй цвет должен быть заметным, а не одной цветной точкой на обложке.
const SECOND_MIN_WEIGHT = 0.6
const SECOND_MIN_SHARE = 0.25

// Ниже этой насыщенности пиксель считаем серым и на тон не пускаем: формально
// тон у серого есть, но он случаен (шум сжатия), и ч/б обложка красила бы фон
// в произвольный цвет.
const MIN_SATURATION = 0.22
// Совсем тёмные и совсем светлые пиксели тоже выбрасываем: их тон либо не
// читается, либо это блики и рамки, а не цвет обложки.
const MIN_LIGHTNESS = 0.08
const MAX_LIGHTNESS = 0.95
// Меньше этого суммарного веса — считаем, что выраженного цвета у обложки нет.
// 2.5 ≈ десяток насыщенных пикселей из 256.
const MIN_WEIGHT = 2.5
// И отдельно требуем, чтобы «цветных» пикселей было хотя бы 1/16 выборки:
// одна яркая точка не должна перекрашивать весь фон.
const MIN_VIVID_PIXELS = SAMPLE

// Мягкий проход: пороги для обложек, у которых выраженного цвета нет, но цвет
// всё-таки есть. Пастельные и приглушённые обложки на уменьшенной копии теряют
// насыщенность (усреднение по ячейке съедает её), и строгие пороги выше
// отправляли их в ч/б палитру.
const SOFT_MIN_SATURATION = 0.1
const SOFT_MIN_WEIGHT = 0.8
const SOFT_MIN_VIVID_PIXELS = 8

// Пределы светлоты стопов. Верхние сознательно ниже единицы: шейдер ещё раз
// поднимает контраст (uContrast = 1.5), и светлый стоп на экране заметно
// светлее, чем в палитре, — белый угол градиента выглядел заливкой поверх фона.
// Нижние не дают совсем тёмной обложке уйти в чёрный прямоугольник.
const MID_LIGHTNESS = [0.26, 0.58]
const LIGHT_LIGHTNESS = [0.42, 0.72]
const DARK_LIGHTNESS = [0.1, 0.29]
// Насколько светлый угол поднимается над основным тоном, когда второго цвета
// у обложки нет.
const LIGHT_LIFT = 0.18

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

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

// Разбор выборки обложки в одну статистику: корзины тона (вес — насыщенность),
// тон цветных пикселей через суммы синусов и косинусов (обычное среднее ломается
// на переходе через 0°/360°, то есть на красном) и общая светлота картинки.
function analyse(data) {
  const weight = new Float64Array(HUE_BINS)
  const sin = new Float64Array(HUE_BINS)
  const cos = new Float64Array(HUE_BINS)
  const sSum = new Float64Array(HUE_BINS)
  const lSum = new Float64Array(HUE_BINS)
  const count = new Float64Array(HUE_BINS)
  let strictCount = 0
  let softWeight = 0
  let softSin = 0
  let softCos = 0
  let softSSum = 0
  let softLSum = 0
  let softCount = 0
  let lTotal = 0
  let pixels = 0

  for (let i = 0; i < data.length; i += 4) {
    const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2])
    pixels += 1
    lTotal += l
    const rad = (h * Math.PI) / 180
    if (s >= SOFT_MIN_SATURATION) {
      softWeight += s
      softSin += Math.sin(rad) * s
      softCos += Math.cos(rad) * s
      softSSum += s
      softLSum += l
      softCount += 1
    }
    if (s < MIN_SATURATION || l < MIN_LIGHTNESS || l > MAX_LIGHTNESS) continue
    strictCount += 1
    const bin = Math.min(HUE_BINS - 1, Math.floor((h / 360) * HUE_BINS))
    weight[bin] += s
    sin[bin] += Math.sin(rad) * s
    cos[bin] += Math.cos(rad) * s
    sSum[bin] += s
    lSum[bin] += l
    count[bin] += 1
  }

  return {
    weight, sin, cos, sSum, lSum, count,
    strictCount, softWeight, softSin, softCos, softSSum, softLSum, softCount,
    lTotal, pixels,
  }
}

const binsApart = (a, b) => {
  const d = Math.abs(a - b)
  return Math.min(d, HUE_BINS - d)
}

function clusterOf(stats, bin) {
  const hue = (Math.atan2(stats.sin[bin], stats.cos[bin]) * 180) / Math.PI
  const n = stats.count[bin]
  return {
    bin,
    hue: (hue + 360) % 360,
    s: stats.sSum[bin] / n,
    l: stats.lSum[bin] / n,
    weight: stats.weight[bin],
  }
}

// Самый весомый тон среди корзин. excludeBin — корзина уже выбранного цвета:
// тогда берётся самый весомый тон в стороне от неё (это и есть «второй по
// доминантности»), и он должен быть заметным, а не единичной точкой.
function pickCluster(stats, excludeBin = -1) {
  let best = -1
  for (let i = 0; i < HUE_BINS; i += 1) {
    if (stats.weight[i] <= 0) continue
    if (excludeBin >= 0 && binsApart(i, excludeBin) < SECOND_MIN_BINS) continue
    if (best < 0 || stats.weight[i] > stats.weight[best]) best = i
  }
  if (best < 0) return null
  if (excludeBin < 0) {
    if (stats.weight[best] < MIN_WEIGHT || stats.strictCount < MIN_VIVID_PIXELS) return null
  } else {
    const minWeight = Math.max(SECOND_MIN_WEIGHT, stats.weight[excludeBin] * SECOND_MIN_SHARE)
    if (stats.weight[best] < minWeight) return null
  }
  return clusterOf(stats, best)
}

// Приглушённый, но всё-таки цветной тон — для пастельных обложек.
function softCluster(stats) {
  if (stats.softCount < SOFT_MIN_VIVID_PIXELS || stats.softWeight < SOFT_MIN_WEIGHT) return null
  const hue = (Math.atan2(stats.softSin, stats.softCos) * 180) / Math.PI
  return {
    hue: (hue + 360) % 360,
    s: stats.softSSum / stats.softCount,
    l: stats.softLSum / stats.softCount,
  }
}

function paletteFromClusters(dominant, second) {
  const sat = clamp(dominant.s, 0.35, 1)
  const midL = clamp(Math.min(dominant.l, MID_LIGHTNESS[1]), MID_LIGHTNESS[0], MID_LIGHTNESS[1])
  const light = second
    ? hslToHex(
        second.hue,
        clamp(second.s, 0.35, 1),
        clamp(Math.min(second.l, LIGHT_LIGHTNESS[1]), LIGHT_LIGHTNESS[0], LIGHT_LIGHTNESS[1]),
      )
    : hslToHex(dominant.hue, sat, clamp(midL + LIGHT_LIFT, LIGHT_LIGHTNESS[0], LIGHT_LIGHTNESS[1]))

  return [
    light,
    hslToHex(dominant.hue, sat, midL),
    hslToHex(
      dominant.hue,
      clamp(dominant.s * 0.8, 0.3, 0.75),
      clamp(midL * 0.5, DARK_LIGHTNESS[0], DARK_LIGHTNESS[1]),
    ),
  ]
}

// Ч/б обложка: цвета брать неоткуда, берём её собственную светлоту. Чёрная
// обложка даёт тёмно-серый градиент (раньше такие обложки проваливались в
// дефолтную фиолетовую палитру — со стороны это выглядело как «для чёрного
// цвета градиента нет»).
//
// Нижние границы здесь ВЫШЕ, чем у цветных палитр, и это не произвол: шейдер
// поднимает контраст (uContrast = 1.5 по формуле (c - 0.5) * 1.5 + 0.5), то
// есть вся светлота ниже 0.167 на экране обнуляется. Первая версия этой
// функции строилась от нуля картинки (0.14 / 0.07 / 0.02) — все три стопа
// упирались в чёрный, и градиент для чёрной обложки оставался невидимым.
// Поэтому отсчёт идёт от 0.32: на экране это ~0.23 — тёмный, но различимый
// уголь, а не чёрный прямоугольник.
function neutralPalette(stats) {
  const l = stats.pixels > 0 ? stats.lTotal / stats.pixels : 0
  const gray = (value) => hslToHex(0, 0, value)
  return [
    gray(clamp(0.32 + l * 0.2, 0.32, 0.52)),
    gray(clamp(0.21 + l * 0.17, 0.21, 0.38)),
    gray(clamp(0.11 + l * 0.09, 0.11, 0.2)),
  ]
}

// Пиксели уменьшенной копии обложки → палитра градиента. null означает «цвета
// взять неоткуда» (canvas недоступен) — вызывающий остаётся на дефолтной палитре.
export function paletteFromPixels(data) {
  if (!data) return null
  const stats = analyse(data)
  const dominant = pickCluster(stats)
  if (dominant) return paletteFromClusters(dominant, pickCluster(stats, dominant.bin))
  const soft = softCluster(stats)
  if (soft) return paletteFromClusters(soft, null)
  return neutralPalette(stats)
}

// Палитра по умолчанию — для трека без обложки и на время разбора. Это тот же
// фиолетовый, что и прежний фон hero, сведённый к тем же пределам светлоты, что
// и палитры из обложек (см. MID_LIGHTNESS/LIGHT_LIGHTNESS/DARK_LIGHTNESS), —
// иначе фон мигал бы на дефолт другим по светлоте.
export const DEFAULT_HERO_COLORS = ['#b070ff', '#8929ff', '#440f85']
