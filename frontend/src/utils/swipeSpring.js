// Более мягкий разгон: при коротком движении пальца оставшаяся ширина
// экрана не должна пролетать за первые два кадра после отпускания.
const FREQUENCY = 24
const STEP_MS = 1000 / 120
const REST_DISTANCE = 0.15
const REST_SPEED = 8

// Критически затухающая пружина: сохраняет скорость отпускания (px/мс),
// не имеет минимальной длительности и заканчивается, когда движение уже
// незаметно. Кадры заранее получает WAAPI, главный поток на доезде свободен.
export function swipeSpring(from, to, velocity = 0) {
  const distance = to - from
  if (Math.abs(distance) < REST_DISTANCE) return { duration: 0, samples: [{ value: to, offset: 1 }] }

  const initialVelocity = velocity * 1000
  // При коротком остатке пути быстрый флик не должен пролетать за вкладку.
  // Увеличиваем затухание, сохраняя именно начальную скорость, а не обрезая её.
  const frequency = Math.max(FREQUENCY, (Math.sign(distance) * initialVelocity) / Math.abs(distance))
  const initialDelta = from - to
  const coefficient = initialVelocity + frequency * initialDelta
  const points = [{ value: from, time: 0 }]
  let duration = 0
  for (let time = STEP_MS; time <= 800; time += STEP_MS) {
    const seconds = time / 1000
    const envelope = Math.exp(-frequency * seconds)
    const delta = (initialDelta + coefficient * seconds) * envelope
    const speed = (coefficient - frequency * (initialDelta + coefficient * seconds)) * envelope
    duration = time
    if (Math.abs(delta) <= REST_DISTANCE && Math.abs(speed) <= REST_SPEED) break
    points.push({ value: to + delta, time })
  }
  points.push({ value: to, time: duration })
  return { duration, samples: points.map(({ value, time }) => ({ value, offset: time / duration })) }
}
