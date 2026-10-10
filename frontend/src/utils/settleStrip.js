export const SETTLE_MS = 340
// Тот же изгиб, что у --ease-out: cubic-bezier(0.23, 1, 0.32, 1).
const EASE_X1 = 0.23

// Карусель обложек (фуллскрин и мини-плеер) доезжает из `from` (px) в `to`
// (по умолчанию ноль; к соседу — см. CAROUSEL_SWITCH_DELAY_MS).
// Сначала без перехода ставим стартовую позицию и форсируем раскладку —
// иначе браузер склеит два присваивания transform и анимации не будет.
//
// velocity — скорость пальца в момент отпускания, px/мс со знаком. Без неё
// доезд идёт по --ease-out, а тот стартует в разы быстрее пальца: на
// отпускании полоса срывалась с места рывком. Со скоростью кривая начинается
// ровно с той скорости, с которой ехала под пальцем, а быстрый флик ещё и
// укорачивает доезд. Возвращает длительность, мс (0 — без анимации).
export function settleStrip(strip, from, { velocity, to = 0 } = {}) {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const place = (x) => (x ? `translateX(${x}px)` : '')
  strip.style.transition = 'none'
  if (reduced || from === to) {
    strip.style.transform = place(to)
    return 0
  }
  strip.style.transform = place(from)
  strip.getBoundingClientRect()

  let duration = SETTLE_MS
  let easing = 'var(--ease-out)'
  if (velocity != null) {
    const distance = Math.abs(to - from)
    // Скорость в сторону цели; палец, тянущий прочь, считаем остановкой.
    const toward = Math.max(0, Math.sign(to - from) * velocity)
    if (toward > 0.3) duration = Math.min(SETTLE_MS, Math.max(200, (2.2 * distance) / toward))
    // Начальный наклон кривой cubic-bezier — y1/x1, в долях пути за долю
    // времени. Подбираем y1 так, чтобы он совпал со скоростью пальца.
    const y1 = Math.min(1, (toward * duration * EASE_X1) / distance)
    easing = `cubic-bezier(${EASE_X1}, ${y1.toFixed(3)}, 0.32, 1)`
  }
  strip.style.transition = `transform ${duration}ms ${easing}`
  strip.style.transform = place(to)
  return duration
}

// Переключение каруселью (свайп, кнопки): сначала полоса доезжает до соседа
// — одна анимация на композиторе, без смены трека и без медиа, — и только
// когда сосед встал на место текущей, трек переключается. Если переключать
// сразу, кадр со стартом доезда ждал медиапроцесс WebKit (замер: главный
// поток занят 100–300 мс после play() и подмены элемента): обложка стояла
// там, где её отпустили, и только потом ехала. Теперь эта пауза приходится на
// момент, когда ничего не движется: слайды переставляются, полоса встаёт в
// ноль — на экране то же самое. Звук нового трека стартует на время доезда
// позже. Запас после доезда — чтобы последний кадр анимации успел на экран.
export const CAROUSEL_SWITCH_DELAY_MS = 30
