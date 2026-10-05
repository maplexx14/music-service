import { useEffect, useId, useLayoutEffect, useRef } from 'react'
import heart from '../assets/loader-heart.webp'
import heartLine from '../assets/like-heart-line.webp'
import heartBolt from '../assets/like-heart-bolt.webp'
import heartFill from '../assets/like-heart-fill.webp'

// Сердце из логотипа — та же картинка, что у BoltLoader, с мазками кисти.
// Лайкнуто — сердце целиком акцентного цвета (--brand-accent): и мазок, и
// заливка; молния — тёмный оттенок акцента, чтобы читалась на заливке
// (белые крапинки по её краю тоже перекрашиваются). Не лайкнуто — силуэт той же картинки цветом кнопки
// (currentColor), как остальные иконки.
// Обёртка — <svg>, чтобы работали правила размеров вида `.like-btn svg`.
//
// При лайке, как дуга в спиннере, по линии сердца пробегает белая
// полоса: от нижнего кончика вверх по левой доле, через верх и правую долю,
// и с инерцией встаёт на место молнии, после чего переходит в неё. Полоса —
// толстый штрих, обрезанный маской по самой картинке, поэтому подсвечивает
// мазок кисти, а не рисует поверх ровную линию. Для перехода картинка
// разрезана на слои: like-heart-line (без заливки молнии) и like-heart-bolt.
// Заодно сердце наливается акцентом снизу вверх. Маска заливки
// like-heart-fill — внутренность мазка, вырезанная по пикселям картинки:
// средняя линия LOOP для неё грубовата и у молнии вылезает за мазок.

// Замкнутый контур по средней линии мазка, кубические Безье в координатах
// картинки 128×128. Начало и конец — нижний кончик; последние два сегмента
// (правый край и внешняя грань молнии) — место, где полоса останавливается.
const LOOP = [
  [[60, 123], [32, 96], [6, 74], [10, 46]],
  [[10, 46], [13, 12], [48, 6], [60, 46]],
  [[60, 46], [74, 12], [106, -2], [116, 18]],
  [[116, 18], [122, 30], [121, 46], [123, 58]],
  [[123, 58], [102, 79], [81, 101], [60, 123]],
]
const REST_SEGMENTS = 2
const STEPS = 32

function bezier([p0, p1, p2, p3], t) {
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const c = 3 * u * t * t
  const d = t * t * t
  return [
    a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
    a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
  ]
}

// Контур — ломаной из точек Безье, длины считаем по ним же: так длина пути
// в браузере совпадает с нашей и штрих встаёт ровно на молнию. Контур
// пройден дважды — перелёт за конец продолжается на второй круг, а не
// обрывается.
const { LOOP_D, LOOP_LENGTH, REST_LENGTH } = (() => {
  const points = []
  let length = 0
  let restLength = 0
  LOOP.forEach((segment, index) => {
    for (let i = index ? 1 : 0; i <= STEPS; i++) {
      const point = bezier(segment, i / STEPS)
      const prev = points[points.length - 1]
      if (prev) {
        const step = Math.hypot(point[0] - prev[0], point[1] - prev[1])
        length += step
        if (index >= LOOP.length - REST_SEGMENTS) restLength += step
      }
      points.push(point)
    }
  })
  const loop = points.slice(1).map(([x, y]) => `L${x.toFixed(2)} ${y.toFixed(2)}`).join('')
  const [x0, y0] = points[0]
  return {
    LOOP_D: `M${x0} ${y0}${loop}${loop}`,
    LOOP_LENGTH: length,
    REST_LENGTH: restLength,
  }
})()

// Быстрый старт, торможение, лёгкий перелёт и возврат (easeOutBack).
const OVERSHOOT = 1.2
function easeOutBack(t) {
  const u = t - 1
  return 1 + (OVERSHOOT + 1) * u * u * u + OVERSHOOT * u * u
}

const DURATION = 800
// Заливка доходит до верха чуть раньше, чем полоса встаёт на молнию.
const FILL_UNTIL = 0.75
// Доля анимации, с которой полоса уже у молнии и перетекает в неё.
const SETTLE_FROM = 0.7
// Сколько после нажатия ждём, что лайк станет true: ответ API может прийти
// не сразу. Без нажатия (сменился трек, а он уже в понравившихся) полоса не
// бежит — анимация только как отклик на действие.
const CLICK_WINDOW = 3000

function LikeHeart({ liked = false, size = 24, className = '' }) {
  const id = useId().replace(/:/g, '')
  const svgRef = useRef(null)
  const boltRef = useRef(null)
  const dashRef = useRef(null)
  const fillRef = useRef(null)
  const clickedAtRef = useRef(0)
  const prevLikedRef = useRef(liked)

  useEffect(() => {
    const button = svgRef.current?.closest('button')
    if (!button) return undefined
    const onClick = () => {
      clickedAtRef.current = performance.now()
    }
    button.addEventListener('click', onClick)
    return () => button.removeEventListener('click', onClick)
  }, [])

  // Layout-эффект: полоса и спрятанная молния выставляются до первой
  // отрисовки, иначе на кадр мелькает готовое сердце.
  useLayoutEffect(() => {
    const wasLiked = prevLikedRef.current
    prevLikedRef.current = liked
    const bolt = boltRef.current
    const dash = dashRef.current
    const fill = fillRef.current
    if (!liked || wasLiked || !bolt || !dash || !fill) return undefined
    if (performance.now() - clickedAtRef.current > CLICK_WINDOW) return undefined
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return undefined

    let frame = 0
    const start = performance.now()
    dash.setAttribute('visibility', 'visible')
    const step = (now) => {
      const t = Math.min(1, (now - start) / DURATION)
      // Голова полосы: от кончика (0) до конца контура, где полоса целиком
      // лежит на молнии. Полоса длиной с молнию: [голова − REST, голова].
      const head = easeOutBack(t) * LOOP_LENGTH
      dash.setAttribute('stroke-dashoffset', String(REST_LENGTH - head))
      const settle = Math.max(0, (t - SETTLE_FROM) / (1 - SETTLE_FROM))
      bolt.setAttribute('opacity', String(settle))
      dash.setAttribute('opacity', String(1 - settle))
      // Уровень заливки: верх обрезающего прямоугольника идёт от низа
      // картинки к верху, с торможением в конце.
      const level = 1 - (1 - Math.min(1, t / FILL_UNTIL)) ** 3
      fill.setAttribute('y', String(128 * (1 - level)))
      if (t < 1) {
        frame = requestAnimationFrame(step)
      } else {
        dash.setAttribute('visibility', 'hidden')
      }
    }
    step(start)
    return () => {
      cancelAnimationFrame(frame)
      bolt.setAttribute('opacity', '1')
      dash.setAttribute('visibility', 'hidden')
      fill.setAttribute('y', '0')
    }
  }, [liked])

  return (
    <svg
      ref={svgRef}
      className={className || undefined}
      width={size}
      height={size}
      viewBox="0 0 128 128"
      aria-hidden="true"
    >
      {/* Силуэт картинки: непрозрачные пиксели — цветом flood. */}
      <filter id={`${id}-fill`} colorInterpolationFilters="sRGB">
        <feFlood floodColor={liked ? '#ffffff' : 'currentColor'} />
        <feComposite in2="SourceAlpha" operator="in" />
      </filter>
      {liked ? (
        <>
          <mask id={`${id}-mask`} maskUnits="userSpaceOnUse" x="0" y="0" width="128" height="128">
            <image href={heart} width="128" height="128" filter={`url(#${id}-fill)`} />
          </mask>
          {/* Слои крашены прямоугольниками с fill по маскам из белых
              силуэтов картинок. Не feFlood с var(): переменные внутри
              фильтров iOS Safari не подставлял. И уровень заливки двигает
              сам прямоугольник, а не rect внутри clipPath: правку clipPath
              WebKit не перерисовывает, и сердце оставалось пустым. Атрибут
              fill — запасной цвет, если style не понят (color-mix до iOS
              16.2). */}
          <mask id={`${id}-in`} maskUnits="userSpaceOnUse" x="0" y="0" width="128" height="128">
            <image href={heartFill} width="128" height="128" />
          </mask>
          <mask id={`${id}-line`} maskUnits="userSpaceOnUse" x="0" y="0" width="128" height="128">
            <image href={heartLine} width="128" height="128" filter={`url(#${id}-fill)`} />
          </mask>
          <mask id={`${id}-bolt`} maskUnits="userSpaceOnUse" x="0" y="0" width="128" height="128">
            <image href={heartBolt} width="128" height="128" filter={`url(#${id}-fill)`} />
          </mask>
          <g mask={`url(#${id}-in)`}>
            <rect ref={fillRef} x="0" y="0" width="128" height="128" fill="#a259ff" style={{ fill: 'var(--brand-accent)' }} />
          </g>
          <rect width="128" height="128" mask={`url(#${id}-line)`} fill="#a259ff" style={{ fill: 'var(--brand-accent)' }} />
          <rect
            ref={boltRef}
            width="128"
            height="128"
            mask={`url(#${id}-bolt)`}
            fill="#61359a"
            style={{ fill: 'color-mix(in oklab, var(--brand-accent) 60%, black)' }}
          />
          <path
            ref={dashRef}
            d={LOOP_D}
            fill="none"
            stroke="#ffffff"
            strokeWidth="24"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray={`${REST_LENGTH} ${LOOP_LENGTH * 3}`}
            mask={`url(#${id}-mask)`}
            visibility="hidden"
          />
        </>
      ) : (
        <image href={heart} width="128" height="128" filter={`url(#${id}-fill)`} />
      )}
    </svg>
  )
}

export default LikeHeart
