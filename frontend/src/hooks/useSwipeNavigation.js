import { useEffect, useRef } from 'react'
import {
  afterNextRouteCommit,
  finishActiveTransition,
  holdHeavyAnimations,
  skipNextTransitionAnimation,
  swipeNextTransition,
} from '../services/navigation'
import { haptic, HAPTIC } from '../utils/haptics'

// Навигация свайпами в PWA: вправо — «Назад» на вложенных экранах, влево/
// вправо — соседняя вкладка на корнях вкладок. Жест начинается из любой
// точки экрана, не только от края: прежний вариант (24 px от левой кромки)
// на устройстве почти не срабатывал — у самого края касание забирает
// система или чехол.
//
// Экран едет за пальцем, а под ним, как в Telegram, с параллаксом выезжает
// живой экран, куда ведёт жест: соседняя вкладка или вкладка, куда ведёт
// «Назад» (ScreenStack держит их смонтированными, targets — их id).
// Отпустили дальше трети ширины или быстрым броском — экраны доезжают, и
// только потом меняется маршрут: оба уже на своих местах, анимации перехода
// не нужно. Иначе экран возвращается на место.
//
// Если живого экрана под пальцем нет (вложенный под вложенным, холодный
// старт), под экраном пусто, а после отпускания переход доигрывает View
// Transition: новый экран въезжает из-под уходящего снапшота.
//
// Жест не начинается там, где горизонтальное движение уже занято: поля
// ввода, ползунки, горизонтально прокручиваемые ленты (карусели) и всё,
// что помечено data-swipe-ignore.

const AXIS_LOCK_PX = 10
// Горизонталь должна явно преобладать: косой жест при прокрутке списка не
// должен уводить экран вбок.
const AXIS_RATIO = 1.2
// Порог перелистывания: на треть ширины приходилось тянуть экран долго,
// как в Telegram хватает четверти или короткого броска.
const COMMIT_FRACTION = 0.25
const FLING_VELOCITY = 0.3 // px/мс
const FLING_MIN_PX = 20
// Скорость — по смещению за последние VELOCITY_WINDOW_MS, а не по одному
// событию: перед отпусканием палец притормаживает, и последнее событие
// занижало скорость броска.
const VELOCITY_WINDOW_MS = 100
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

// Энергосбережение на iOS режет обновление страницы до 30 кадров/с (касания
// приходят чаще, но рисуется каждое второе), и экран под пальцем шёл
// ступеньками. При таком темпе каждый сдвиг отдаём CSS-переходу длиной в
// кадр: промежуточные положения дорисовывает системный композитор, который
// не урезан, — визуально снова плавно, ценой отставания от пальца на кадр.
// Темп меряется по rAF во время жеста и помнится до следующего.
const SLOW_FRAME_MS = 25
let frameMs = 16.7

function trackFrameRate() {
  let last = 0
  let raf = requestAnimationFrame(function tick(now) {
    if (last) frameMs = 0.8 * frameMs + 0.2 * Math.min(100, now - last)
    last = now
    raf = requestAnimationFrame(tick)
  })
  return () => cancelAnimationFrame(raf)
}

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

export function useSwipeNavigation(containerRef, { enabled, onBack, onPrev, onNext, onCommit, targets }) {
  const actionsRef = useRef(null)
  // Свайп вправо: «Назад» на вложенном экране, предыдущая вкладка на корне.
  // onCommit(dir) — палец отпущен и переход решён: нижнее меню переключается
  // сразу, не дожидаясь доезда экранов и коммита роутера.
  actionsRef.current = {
    right: onBack || onPrev || null,
    left: onNext || null,
    onCommit: onCommit || null,
    targets: targets || {},
  }

  useEffect(() => {
    const container = containerRef.current
    if (!container || !enabled) return undefined

    let g = null
    // Экраны текущего жеста: тот, что под пальцем, его контейнер прокрутки и
    // экран под ним (under, сторона underDir). Живут до конца доезда.
    let pan = null
    // Переход через View Transition: новый жест ждёт его конца.
    let busy = false
    // Свайп-переход уже снял сдвиг (onCapture) и доигрывает анимацию — экран
    // живой и новый жест можно начинать, оборвав анимацию.
    let interruptible = false
    // Живой доезд экранов идёт — новое касание доводит его сразу (finishLive).
    let finishLive = null
    // Маршрут сменён, но роутер ещё не закоммитил экран — новый жест ждёт.
    let committing = false
    let settleTimer = 0
    // Пауза WebGL-фона, пока экран под пальцем или доезжает (см. navigation.js).
    let releaseHeavy = null
    let stopFrameTrack = null

    const activeScreen = () => container.querySelector(':scope > .screen[data-active]')
    const screenById = (id) => (id ? container.querySelector(`:scope > .screen[data-screen="${id}"]`) : null)

    // Сколько ехать distance px, чтобы стартовать со скоростью пальца v (px/мс).
    const settleMs = (distance, v) => {
      const ms = v > 0 ? (EASE_START_SLOPE * distance) / v : MAX_MS
      return Math.round(Math.min(MAX_MS, Math.max(MIN_MS, ms)))
    }

    const transitionFor = (ms) => {
      if (ms) return `transform ${ms}ms ${EASE}`
      if (frameMs > SLOW_FRAME_MS) return `transform ${Math.round(frameMs)}ms linear`
      return 'none'
    }

    const clearScreen = (el) => {
      const st = el.style
      st.transition = ''
      st.transform = ''
      st.willChange = ''
      st.zIndex = ''
      st.visibility = ''
      st.boxShadow = ''
    }

    const reset = () => {
      if (pan) {
        clearScreen(pan.screen)
        if (pan.under) clearScreen(pan.under)
        if (pan.scroller) pan.scroller.style.overflowY = ''
        pan = null
      }
      releaseHeavy?.()
      releaseHeavy = null
      stopFrameTrack?.()
      stopFrameTrack = null
    }

    // Экран под пальцем со стороны dir (0 — никакого). Порядок слоёв — инлайн
    // на время жеста: без z-index в покое экраны не запирают модалки страниц.
    const showUnder = (dir) => {
      if (pan.underDir === dir) return
      if (pan.under) clearScreen(pan.under)
      pan.underDir = dir
      const id = dir > 0 ? actionsRef.current.targets.right : dir < 0 ? actionsRef.current.targets.left : null
      const under = screenById(id)
      pan.under = under && under !== pan.screen ? under : null
      if (pan.under) {
        const st = pan.under.style
        st.visibility = 'visible'
        st.zIndex = '1'
        st.willChange = 'transform'
      }
      const shadow = pan.under && !document.documentElement.classList.contains('no-gpu')
      pan.screen.style.boxShadow = shadow ? `${-dir * 12}px 0 32px rgba(0, 0, 0, 0.55)` : ''
    }

    const setOffset = (x, ms = 0) => {
      const transition = transitionFor(ms)
      const st = pan.screen.style
      st.transition = transition
      st.transform = x ? `translate3d(${x}px, 0, 0)` : ''
      if (pan.under) {
        // Нижний экран едет с параллаксом: от сдвига на четверть ширины к нулю.
        const ux = -pan.underDir * ENTER_SHIFT * Math.max(0, pan.width - Math.abs(x))
        pan.under.style.transition = transition
        pan.under.style.transform = `translate3d(${ux}px, 0, 0)`
      }
    }

    // Возврат экрана на место. Таймер сброса снимается новым жестом: иначе
    // reset() сработал бы посреди следующей протяжки — кадр с экраном на нуле
    // и прокрутка списка под пальцем.
    const settle = (ms) => {
      setOffset(0, ms)
      clearTimeout(settleTimer)
      settleTimer = setTimeout(reset, ms + 40)
    }

    // Живой переход: экраны доезжают, потом меняется маршрут. Новый экран к
    // этому моменту уже на месте, поэтому коммит роутера ничего не двигает, а
    // инлайн-стили снимаются в его layout-эффекте — до отрисовки кадра.
    const commitLive = (dir, ms, action) => {
      const finished = pan
      setOffset(dir * pan.width, ms)
      let timer = 0
      const navigateNow = () => {
        clearTimeout(timer)
        finishLive = null
        committing = true
        // Новое касание оборвало доезд — ставим экраны в конечные точки сразу.
        finished.screen.style.transition = 'none'
        finished.under.style.transition = 'none'
        finished.under.style.transform = ''
        const done = () => {
          clearTimeout(fallback)
          committing = false
          if (pan === finished) reset()
        }
        const cancel = afterNextRouteCommit(done)
        const fallback = setTimeout(() => {
          cancel()
          done()
        }, 1000)
        skipNextTransitionAnimation()
        action()
      }
      timer = setTimeout(navigateNow, ms + 20)
      finishLive = navigateNow
    }

    const onStart = (e) => {
      if (e.touches.length !== 1) {
        g = null
        return
      }
      finishLive?.()
      if (busy && interruptible) {
        finishActiveTransition()
        busy = false
        interruptible = false
      }
      if (busy) {
        g = null
        return
      }
      const target = e.target instanceof Element ? e.target : null
      if (!target || target.closest(IGNORE) || insideHorizontalScroller(target, container)) return
      const t = e.touches[0]
      g = { x: t.clientX, y: t.clientY, dx: 0, axis: null, lastT: e.timeStamp, v: 0, samples: [{ x: t.clientX, t: e.timeStamp }] }
    }

    const onMove = (e) => {
      if (!g) return
      if (e.touches.length !== 1) {
        g = null
        reset()
        return
      }
      const t = e.touches[0]
      const dx = t.clientX - g.x
      const dy = t.clientY - g.y
      if (!g.axis) {
        if (Math.abs(dx) < AXIS_LOCK_PX && Math.abs(dy) < AXIS_LOCK_PX) return
        // Прошлый свайп ещё коммитится (активный экран вот-вот сменится) —
        // жест не теряем, а ждём следующего движения пальца.
        if (committing) return
        const screen = activeScreen()
        if (!screen || Math.abs(dx) < Math.abs(dy) * AXIS_RATIO) {
          g = null
          return
        }
        g.axis = 'x'
        clearTimeout(settleTimer)
        reset()
        releaseHeavy = holdHeavyAnimations()
        stopFrameTrack = trackFrameRate()
        pan = {
          screen,
          scroller: screen.querySelector(':scope > .screen-scroll'),
          under: null,
          underDir: 0,
          width: container.clientWidth || window.innerWidth,
        }
        screen.style.willChange = 'transform'
        screen.style.zIndex = '2'
        // Горизонтальный жест забираем целиком: список под пальцем не должен
        // одновременно прокручиваться. Через overflow, а не preventDefault —
        // тот требует непассивного touchmove, и тогда КАЖДОЕ движение пальца
        // при обычной прокрутке ждало бы главный поток.
        if (pan.scroller) pan.scroller.style.overflowY = 'hidden'
      }
      g.lastT = e.timeStamp
      g.samples.push({ x: t.clientX, t: e.timeStamp })
      while (g.samples.length > 2 && e.timeStamp - g.samples[0].t > VELOCITY_WINDOW_MS) g.samples.shift()
      const first = g.samples[0]
      g.v = (t.clientX - first.x) / Math.max(1, e.timeStamp - first.t)
      const action = dx > 0 ? actionsRef.current.right : actionsRef.current.left
      g.dx = action ? dx : dx * RESISTANCE
      showUnder(action && dx !== 0 ? Math.sign(dx) : 0)
      setOffset(g.dx)
    }

    const onEnd = (e) => {
      if (!g) return
      const { axis, dx } = g
      const v = e.timeStamp - g.lastT > STALE_VELOCITY_MS ? 0 : g.v
      g = null
      if (axis !== 'x' || !pan) return
      stopFrameTrack?.()
      stopFrameTrack = null
      const dir = dx > 0 ? 1 : -1
      const action = dir > 0 ? actionsRef.current.right : actionsRef.current.left
      const width = pan.width
      const commit =
        action && (Math.abs(dx) > width * COMMIT_FRACTION || (v * dir > FLING_VELOCITY && Math.abs(dx) > FLING_MIN_PX))
      if (!commit) {
        settle(settleMs(Math.abs(dx), -v * dir))
        return
      }
      haptic(HAPTIC.selection)
      actionsRef.current.onCommit?.(dir)
      const ms = settleMs(width - Math.abs(dx), v * dir)

      if (pan.under) {
        commitLive(dir, ms, action)
        return
      }

      busy = true
      // Под пальцем пусто — переход доигрывает View Transition: старый экран
      // (снапшот) уезжает от того места, где его отпустил палец, новый
      // одновременно въезжает из-под него.
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
        interruptible = true
        finished.finally(() => {
          busy = false
          interruptible = false
        })
      })
      if (cancelSwipe) {
        // Навигации не случилось — вернуть экран на место.
        fallback = setTimeout(() => {
          cancelSwipe()
          settle(MAX_MS)
          setTimeout(() => {
            busy = false
          }, MAX_MS + 40)
        }, 1000)
        action()
        return
      }

      // Без View Transitions (старый WebKit, lite-mode, reduced motion):
      // старый экран доезжает, новый на коммите въезжает коротким сдвигом.
      setOffset(dir * width, ms)
      skipNextTransitionAnimation()
      const cancel = afterNextRouteCommit(() => {
        clearTimeout(fallback)
        reset()
        busy = false
        if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
        activeScreen()?.animate(
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
      g = null
      if (!wasDragging || !pan) return
      settle(MAX_MS)
    }

    container.addEventListener('touchstart', onStart, { passive: true })
    container.addEventListener('touchmove', onMove, { passive: true })
    container.addEventListener('touchend', onEnd, { passive: true })
    container.addEventListener('touchcancel', onCancel, { passive: true })
    return () => {
      container.removeEventListener('touchstart', onStart)
      container.removeEventListener('touchmove', onMove)
      container.removeEventListener('touchend', onEnd)
      container.removeEventListener('touchcancel', onCancel)
      clearTimeout(settleTimer)
      finishLive = null
      reset()
    }
  }, [containerRef, enabled])
}
