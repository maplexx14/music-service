const FREQUENCY = 26
const SHORT_DISTANCE = 96
const MAX_FREQUENCY = 80
const STEP_MS = 1000 / 120
const REST_DISTANCE = 0.15
const REST_SPEED = 8

// Критически затухающая пружина с устойчивым откликом на скорость (px/мс).
// Кадры заранее получает WAAPI, главный поток на доезде свободен.
export function swipeSpring(from, to, velocity = 0) {
  const distance = to - from
  if (Math.abs(distance) < REST_DISTANCE) return { duration: 0, samples: [{ value: to, offset: 1 }] }

  // Характер доезда задаёт оставшийся путь, а не резкость флика. Раньше
  // скорость повышала частоту без предела: тот же экран мог доехать за
  // 400 мс или проскочить почти целиком за один кадр. Короткие доводки
  // ускоряем по расстоянию, чтобы несколько пикселей не тянулись долго.
  const frequency = Math.min(MAX_FREQUENCY, FREQUENCY * Math.sqrt(Math.max(1, SHORT_DISTANCE / Math.abs(distance))))
  const speed = Math.abs(velocity) * 1000
  const speedLimit = frequency * Math.abs(distance) * 0.5
  const softStart = speedLimit * 0.5
  // Обычная скорость передаётся без изменений. Чрезмерный импульс плавно
  // ограничиваем: без резкого порога и скачка к сверхжёсткой пружине.
  const initialVelocity = Math.sign(velocity) * (speed <= softStart
    ? speed
    : softStart + (speedLimit - softStart) * Math.tanh((speed - softStart) / (speedLimit - softStart)))
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
