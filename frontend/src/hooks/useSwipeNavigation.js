import { useEffect, useRef } from 'react'
import {
  afterNextRouteCommit,
  holdHeavyAnimations,
  skipNextTransitionAnimation,
  swipeNextTransition,
} from '../services/navigation'
import { haptic, HAPTIC } from '../utils/haptics'
import { startSwipeDebug } from '../utils/swipeDebug'

// Навигация свайпами в PWA: вправо — «Назад» на вложенных экранах, влево/
// вправо — соседняя вкладка на корнях вкладок. Жест начинается из любой
// точки экрана, не только от края: прежний вариант (24 px от левой кромки)
// на устройстве почти не срабатывал — у самого края касание забирает
// система или чехол.
//
// Экран едет за пальцем; отпустили дальше трети ширины или быстрым броском —
// уезжает, и происходит переход, иначе возвращается на место. Новый экран
// доезжает с той стороны, откуда пришёл, без смены прозрачности: прежний
// доезд с opacity 0.4 выглядел как мигание страницы.
//
// Жест не начинается там, где горизонтальное движение уже занято: поля
// ввода, ползунки, горизонтально прокручиваемые ленты (карусели) и всё,
// что помечено data-swipe-ignore.

const AXIS_LOCK_PX = 10
// Горизонталь должна явно преобладать: косой жест при прокрутке списка не
// должен уводить экран вбок.
const AXIS_RATIO = 1.5
const COMMIT_FRACTION = 0.33
const FLING_VELOCITY = 0.5 // px/мс
// Сопротивление, когда в эту сторону идти некуда (первая/последняя вкладка).
const RESISTANCE = 0.2
// Длительность доезда считается от скорости пальца, чтобы экран продолжил
// движение с той же скоростью, а не дёрнулся быстрее или медленнее неё.
const MIN_MS = 200
const MAX_MS = 380
// Палец остановился перед отпусканием — броска нет.
const STALE_VELOCITY_MS = 80
const ENTER_MS = 260
const ENTER_SHIFT = 0.25
// = --ease-drawer. Начальный наклон кривой ≈ 0.72 / 0.32: на старте экран
// идёт в 2.25 раза быстрее средней скорости доезда.
const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)'
const EASE_START_SLOPE = 2.25
const IGNORE = 'input, textarea, select, [contenteditable="true"], [role="slider"], [data-swipe-ignore]'

// Есть ли между целью касания и контейнером горизонтально прокручиваемый
// элемент — такой жест принадлежит ему.
function insideHorizontalScroller(target, root) {
  for (let node = target; node && node !== root; node = node.parentElement) {
    if (node.scrollWidth > node.clientWidth + 1) {
      const { overflowX } = getComputedStyle(node)
      if (overflowX === 'auto' || overflowX === 'scroll') return true
    }
  }
  return false
}

export function useSwipeNavigation(scrollerRef, { enabled, onBack, onPrev, onNext }) {
  const actionsRef = useRef(null)
  // Свайп вправо: «Назад» на вложенном экране, предыдущая вкладка на корне.
  actionsRef.current = { right: onBack || onPrev || null, left: onNext || null }

  useEffect(() => {
    const el = scrollerRef.current
    if (!el || !enabled) return undefined

    let g = null
    let busy = false
    let settleTimer = 0
    // Пауза WebGL-фона, пока экран под пальцем или доезжает (см. navigation.js).
    let releaseHeavy = null

    // Сколько ехать distance px, чтобы стартовать со скоростью пальца v (px/мс).
    const settleMs = (distance, v) => {
      const ms = v > 0 ? (EASE_START_SLOPE * distance) / v : MAX_MS
      return Math.round(Math.min(MAX_MS, Math.max(MIN_MS, ms)))
    }

    const setOffset = (x, ms = 0) => {
      el.style.transition = ms ? `transform ${ms}ms ${EASE}` : 'none'
      el.style.transform = x ? `translate3d(${x}px, 0, 0)` : ''
    }

    const reset = () => {
      el.style.transition = ''
      el.style.transform = ''
      el.style.willChange = ''
      el.style.overflowY = ''
      releaseHeavy?.()
      releaseHeavy = null
    }

    // Возврат экрана на место. Таймер сброса снимается новым жестом: иначе
    // reset() сработал бы посреди следующей протяжки — кадр с экраном на нуле
    // и прокрутка списка под пальцем.
    const settle = (ms) => {
      setOffset(0, ms)
      clearTimeout(settleTimer)
      settleTimer = setTimeout(reset, ms + 40)
    }

    const onStart = (e) => {
      if (busy || e.touches.length !== 1) {
        g = null
        return
      }
      const target = e.target instanceof Element ? e.target : null
      if (!target || target.closest(IGNORE) || insideHorizontalScroller(target, el)) return
      const t = e.touches[0]
      g = { x: t.clientX, y: t.clientY, dx: 0, axis: null, lastX: t.clientX, lastT: e.timeStamp, v: 0 }
    }

    const onMove = (e) => {
      if (!g) return
      if (e.touches.length !== 1) {
        g.debug?.end()
        g = null
        reset()
        return
      }
      const t = e.touches[0]
      const dx = t.clientX - g.x
      const dy = t.clientY - g.y
      if (!g.axis) {
        if (Math.abs(dx) < AXIS_LOCK_PX && Math.abs(dy) < AXIS_LOCK_PX) return
        if (Math.abs(dx) < Math.abs(dy) * AXIS_RATIO) {
          g = null
          return
        }
        g.axis = 'x'
        clearTimeout(settleTimer)
        if (!releaseHeavy) releaseHeavy = holdHeavyAnimations()
        g.debug = startSwipeDebug()
        el.style.willChange = 'transform'
        // Горизонтальный жест забираем целиком: список под пальцем не должен
        // одновременно прокручиваться. Через overflow, а не preventDefault —
        // тот требует непассивного touchmove, и тогда КАЖДОЕ движение пальца
        // при обычной прокрутке ждало бы главный поток.
        el.style.overflowY = 'hidden'
      }
      const dt = Math.max(1, e.timeStamp - g.lastT)
      // Сглаживание: скорость по одному событию шумит от кадра к кадру.
      g.v = 0.6 * ((t.clientX - g.lastX) / dt) + 0.4 * g.v
      g.lastX = t.clientX
      g.lastT = e.timeStamp
      const action = dx > 0 ? actionsRef.current.right : actionsRef.current.left
      g.dx = action ? dx : dx * RESISTANCE
      const handlerStart = g.debug ? performance.now() : 0
      setOffset(g.dx)
      g.debug?.move(performance.now() - handlerStart)
    }

    const onEnd = (e) => {
      if (!g) return
      const { axis, dx } = g
      g.debug?.end()
      const v = e.timeStamp - g.lastT > STALE_VELOCITY_MS ? 0 : g.v
      g = null
      if (axis !== 'x') return
      const dir = dx > 0 ? 1 : -1
      const action = dir > 0 ? actionsRef.current.right : actionsRef.current.left
      const width = el.clientWidth || window.innerWidth
      const commit =
        action && (Math.abs(dx) > width * COMMIT_FRACTION || (v * dir > FLING_VELOCITY && Math.abs(dx) > 30))
      if (!commit) {
        settle(settleMs(Math.abs(dx), -v * dir))
        return
      }
      busy = true
      haptic(HAPTIC.selection)
      const ms = settleMs(width - Math.abs(dx), v * dir)

      // Основной путь — View Transition: старый экран (снапшот) уезжает от
      // того места, где его отпустил палец, новый одновременно въезжает
      // из-под него. Раньше всё делал один элемент: коммит нового экрана
      // обрывал уезд старого на полпути, и экран прыгал на стартовую точку
      // въезда (или, при долгом рендере, висел чёрный фон).
      const root = document.documentElement.style
      root.setProperty('--swipe-from', `${dx}px`)
      root.setProperty('--swipe-to', `${dir * width}px`)
      root.setProperty('--swipe-under', `${-dir * ENTER_SHIFT * width}px`)
      root.setProperty('--swipe-shadow', `${-dir * 12}px`)
      root.setProperty('--swipe-ms', `${ms}ms`)
      let fallback = 0
      // Новый жест — только когда переход доиграл: дерево ::view-transition
      // пропускает касания к живому экрану под снапшотами, и протяжка во
      // время анимации невидимо двигала бы его, а по окончании он прыгал бы.
      const cancelSwipe = swipeNextTransition((finished) => {
        clearTimeout(fallback)
        reset()
        finished.finally(() => {
          busy = false
        })
      })
      if (cancelSwipe) {
        // Навигации не случилось — вернуть экран на место.
        fallback = setTimeout(() => {
          cancelSwipe()
          setOffset(0, MAX_MS)
          setTimeout(() => {
            reset()
            busy = false
          }, MAX_MS + 40)
        }, 1000)
        action()
        return
      }

      // Без View Transitions (старый WebKit, lite-mode, reduced motion).
      // Переход запускаем СРАЗУ, параллельно с уездом старого экрана. Раньше
      // он стартовал только после того, как экран уехал целиком, и всё время
      // рендера нового экрана на месте ленты был пустой чёрный фон (видна
      // одна нижняя панель). Теперь, пока роутер готовит новый экран, старый
      // ещё виден и доезжает; на коммите нового сдвиг снимается до первого
      // кадра. Экран уже увезён пальцем — штатная анимация перехода не нужна.
      setOffset(dir * width, ms)
      skipNextTransitionAnimation()
      const cancel = afterNextRouteCommit(() => {
        clearTimeout(fallback)
        reset()
        busy = false
        if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
        el.animate(
          [{ transform: `translate3d(${-dir * ENTER_SHIFT * 100}%, 0, 0)` }, { transform: 'none' }],
          { duration: ENTER_MS, easing: EASE },
        )
      })
      fallback = setTimeout(() => {
        cancel()
        reset()
        busy = false
      }, 1500)
      action()
    }

    // Касание отобрала система (входящий звонок, жест iOS) — возвращаем экран
    // на место, а не переходим.
    const onCancel = () => {
      if (!g) return
      const wasDragging = g.axis === 'x'
      g.debug?.end()
      g = null
      if (!wasDragging) return
      settle(MAX_MS)
    }

    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: true })
    el.addEventListener('touchend', onEnd, { passive: true })
    el.addEventListener('touchcancel', onCancel, { passive: true })
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onCancel)
      clearTimeout(settleTimer)
      reset()
    }
  }, [scrollerRef, enabled])
}
