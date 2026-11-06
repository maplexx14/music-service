import { useEffect, useLayoutEffect, useRef } from 'react'
import {
  afterNextRouteCommit,
  finishActiveTransition,
  holdHeavyAnimations,
  skipNextTransitionAnimation,
  swipeNextTransition,
  isIOS,
} from '../services/navigation'
import { haptic, HAPTIC } from '../utils/haptics'
import { swipeSpring } from '../utils/swipeSpring'
import { setSwipePhase } from '../utils/swipeActivity'

// Навигация свайпами в PWA: вправо — «Назад» на вложенных экранах, влево/
// вправо — соседняя вкладка на корнях вкладок. Жест начинается из любой
// точки экрана, не только от края: прежний вариант (24 px от левой кромки)
// на устройстве почти не срабатывал — у самого края касание забирает
// система или чехол.
//
// Вкладки едут рядом с одинаковой скоростью. На вложенных экранах «Назад»
// раскрывает нижний экран с параллаксом (ScreenStack держит их
// смонтированными, targets — их id).
// Отпустили дальше четверти ширины или быстрым броском — экраны доезжают, и
// только потом меняется маршрут: оба уже на своих местах, анимации перехода
// не нужно. Иначе экран возвращается на место.
// Повторный свайп по уже видимой входящей вкладке передаёт ей управление
// раньше: следующий жест начинает новый переход с текущих позиций экранов.
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
// Небольшая поправка координаты при поднятии пальца не означает «передумал».
const REVERSE_MIN_PX = 24
// Скорость — по смещению за последние VELOCITY_WINDOW_MS, а не по одному
// событию: перед отпусканием палец притормаживает, и последнее событие
// занижало скорость броска.
const VELOCITY_WINDOW_MS = 60
// touchend без смещения в пределах двух кадров — отпускание, а не остановка.
const RELEASE_GRACE_MS = 32
// Сопротивление, когда в эту сторону идти некуда (первая/последняя вкладка).
const RESISTANCE = 0.2
// Палец остановился перед отпусканием — броска нет.
const STALE_VELOCITY_MS = 80
const ENTER_MS = 260
const ENTER_SHIFT = 0.25
// Уезжающий экран с тенью доезжает за край на её длину (сдвиг 12px + размытие
// 32px, см. showUnder и --vt-shadow-reach в index.css): остановись он ровно у
// края, полоса тени оставалась бы на экране и пропадала рывком.
const SHADOW_REACH = 48
const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)'
const IGNORE = 'input, textarea, select, [contenteditable="true"], [role="slider"], [data-swipe-ignore]'
// Полоса у левой кромки, где iOS в установленной PWA запускает свой жест
// «назад» по истории: он листает снапшот WebKit без наших экранов, и после
// отпускания страница отрисовывалась заново — выглядело как перезагрузка.
// Касание в полосе забираем (preventDefault на touchstart — единственное,
// что этот жест отменяет), и дальше его ведёт наш свайп.
//
// Слушатель — на отдельном элементе-полосе (.swipe-edge-guard), а не на всём
// контейнере. Непассивный touchstart WebKit учитывает по области элемента:
// в ней он перед каждым жестом ждёт ответа главного потока, можно ли
// прокручивать. Висел он на контейнере — и старт любой прокрутки экрана
// ждал страницу, занятую рендером или событием медиаэлемента.
const EDGE_PX = 20
// Под полосой, а не на ней, лежит то, во что целился палец.
const EDITABLE = 'input, textarea, select, [contenteditable="true"]'
const TAP_SLOP_PX = 10
const isStandalone = () =>
  window.navigator.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches

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

export function useSwipeNavigation(containerRef, { enabled, screenKey, onBack, onPrev, onNext, onCommit, onPan, targets }) {
  const actionsRef = useRef(null)
  const screenChangeRef = useRef(null)
  // Свайп вправо: «Назад» на вложенном экране, предыдущая вкладка на корне.
  // onCommit(dir) — палец отпущен и переход решён: нижнее меню переключается
  // сразу, не дожидаясь доезда экранов и коммита роутера; null отменяет выбор.
  // onPan(x, width, transition, motion) — экран под пальцем сдвинут на x px;
  // motion готовит капсулу меню при протяжке и передаёт ей те же кадры
  // пружины при отпускании; onPan(null) —
  // жест закончен, сдвиг снят.
  actionsRef.current = {
    screenKey,
    right: onBack || onPrev || null,
    left: onNext || null,
    onCommit: onCommit || null,
    onPan: onPan || null,
    back: Boolean(onBack),
    targets: targets || {},
  }

  // Внешняя навигация отменяет старый жест до показа нового экрана.
  // Слушатели остаются на месте: переподключение после коммита стирало
  // следующее касание, уже начавшееся между двумя быстрыми свайпами.
  useLayoutEffect(() => {
    screenChangeRef.current?.(screenKey)
  }, [screenKey])

  useEffect(() => {
    const container = containerRef.current
    if (!container || !enabled) return undefined

    let g = null
    // Экраны текущего жеста: тот, что под пальцем, и экран под ним (under,
    // сторона underDir). Живут до конца доезда.
    let pan = null
    // Переход через View Transition: новый жест ждёт его конца.
    let busy = false
    // Свайп-переход уже снял сдвиг (onCapture) и доигрывает анимацию — экран
    // живой и новый жест можно начинать, оборвав анимацию.
    let interruptible = false
    // Живой доезд экранов идёт — новое касание останавливает его под пальцем.
    let finishLive = null
    // Маршрут сменён, но роутер ещё не закоммитил экран — новый жест ждёт.
    let committing = false
    let cancelRouteCommit = null
    let routeCommitTimer = 0
    let currentScreenKey = actionsRef.current.screenKey
    let routeRequested = false
    let queuedMove = null
    let queuedEnd = null
    // Пауза WebGL-фона, пока экран под пальцем или доезжает (см. navigation.js).
    let releaseHeavy = null

    const requestNavigation = (action) => {
      routeRequested = true
      action()
    }

    const resumeInput = () => {
      const move = queuedMove
      const end = queuedEnd
      queuedMove = queuedEnd = null
      if (move) onMove(move)
      if (end) onEnd(end)
    }

    const activeScreen = () => container.querySelector(':scope > .screen[data-active]')
    const screenById = (id) => (id ? container.querySelector(`:scope > .screen[data-screen="${id}"]`) : null)

    const settleMotion = (to, velocity = 0) => {
      if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
        return { duration: 0, samples: [{ value: to, offset: 1 }] }
      }
      return swipeSpring(pan.offset, to, velocity)
    }

    const transformAt = (x) => `translate3d(${x}px, 0, 0)`
    const underOffset = (x) => pan.tabSwipe
      ? x - pan.underDir * pan.width
      : -pan.underDir * ENTER_SHIFT * Math.max(0, pan.width - Math.abs(x))
    const exitOffset = (dir) => dir * (pan.width + (pan.tabSwipe ? 0 : SHADOW_REACH))

    const cancelDragFrame = () => {
      if (!pan?.dragFrame) return
      cancelAnimationFrame(pan.dragFrame)
      pan.dragFrame = 0
    }

    const cancelAnimations = () => {
      if (!pan) return
      cancelDragFrame()
      const animations = pan.animations
      pan.animations = null
      animations?.forEach((animation) => animation.cancel())
      pan.dragAnimations?.forEach((animation) => animation.cancel())
      pan.dragAnimations = null
    }

    const clearScreen = (el) => {
      pan?.dragAnimations?.get(el)?.cancel()
      pan?.dragAnimations?.delete(el)
      const st = el.style
      st.transition = ''
      st.transform = ''
      st.willChange = ''
      st.zIndex = ''
      st.visibility = ''
      st.boxShadow = ''
    }

    const reset = () => {
      finishLive = null
      setSwipePhase(null)
      container.removeAttribute('data-swiping')
      if (pan) {
        cancelAnimations()
        actionsRef.current.onPan?.(null)
        clearScreen(pan.screen)
        if (pan.under) clearScreen(pan.under)
        if (pan.trailing) clearScreen(pan.trailing.screen)
        pan = null
      }
      releaseHeavy?.()
      releaseHeavy = null
    }

    // Экран под пальцем со стороны dir (0 — никакого). Порядок слоёв — инлайн
    // на время жеста: без z-index в покое экраны не запирают модалки страниц.
    const showUnder = (dir, retain = false) => {
      if (pan.underDir === dir) return
      if (pan.trailing) clearScreen(pan.trailing.screen)
      pan.trailing = retain && pan.under ? { screen: pan.under, shift: -pan.underDir * pan.width } : null
      if (pan.under && !retain) clearScreen(pan.under)
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
      const shadow = pan.under && !pan.tabSwipe && !document.documentElement.classList.contains('no-gpu')
      pan.screen.style.boxShadow = shadow ? `${-dir * 12}px 0 32px rgba(0, 0, 0, 0.55)` : ''
    }

    // Вкладка остаётся на одной WAAPI-анимации от протяжки до доезда.
    // Пока палец движется, её время — координата, а не часы: каждый кадр
    // выставляется напрямую. Отпускание заменяет траекторию у уже готовой
    // анимации, без создания нового эффекта поверх живого transform.
    const setDragOffset = (el, value, range, transform = transformAt) => {
      if (!pan.dragAnimations) return
      let animation = pan.dragAnimations.get(el)
      if (!animation) {
        animation = el.animate([
          { transform: transform(-range) },
          { transform: transform(range) },
        ], { duration: range * 2, easing: 'linear', fill: 'both' })
        animation.pause()
        // Жест может закончиться отменой ещё до появления доезда.
        animation.ready.catch(() => {})
        animation.finished.catch(() => {})
        pan.dragAnimations.set(el, animation)
      }
      animation.currentTime = value + range
      return animation
    }
    const dragMotion = { drag: setDragOffset }

    const setScreenOffset = (el, x) => {
      const st = el.style
      st.transition = 'none'
      st.transform = transformAt(x)
      setDragOffset(el, x, pan.width * 3)
    }

    const setOffset = (x, motion = null) => {
      setScreenOffset(pan.screen, x)
      pan.offset = x
      // Довод за край ради тени (SHADOW_REACH) — не сдвиг вкладки: индикатор
      // таб-бара проскочил бы свою ячейку.
      actionsRef.current.onPan?.(Math.sign(x) * Math.min(Math.abs(x), pan.width), pan.width, 'none', motion ?? (pan.dragAnimations ? dragMotion : null))
      if (pan.under) {
        // Вкладки едут рядом, вложенный нижний экран — с параллаксом.
        setScreenOffset(pan.under, underOffset(x))
      }
      if (pan.trailing) {
        setScreenOffset(pan.trailing.screen, x + pan.trailing.shift)
      }
    }

    // Явные начальные кадры не дают браузеру склеить последнее движение
    // пальца с доездом. Оба экрана анимирует композитор; конец сообщает сама
    // анимация, без паузы таймера после визуальной остановки.
    const animateOffset = (x, motion, done) => {
      const finished = pan
      const prepared = pan.dragAnimations
      pan.dragAnimations = null
      cancelAnimations()
      const animations = []
      const options = { duration: motion.duration, easing: 'linear', fill: 'both' }
      const animateTransform = (el, keyframes) => {
        let animation = prepared?.get(el)
        prepared?.delete(el)
        if (animation && animation.playState !== 'idle') {
          // Сначала сбрасываем часы: прежняя координата может быть больше
          // новой длительности и преждевременно завершить finished.
          animation.currentTime = 0
          animation.effect.setKeyframes(keyframes)
          animation.effect.updateTiming(options)
        } else {
          animation = el.animate(keyframes, options)
        }
        animation.pause()
        animations.push(animation)
        return animation
      }
      // Капсула тоже использует подготовленный эффект: новая анимация при
      // отпускании задерживала общий запуск, хотя оба экрана уже были готовы.
      // Конечные стили выставляем только после доезда, перед коммитом роутера.
      setOffset(motion.duration ? motion.samples[0].value : x, { ...motion, animate: animateTransform })
      if (!motion.duration) {
        prepared?.forEach((animation) => animation.cancel())
        done()
        return
      }
      setSwipePhase('prepare')
      animateTransform(pan.screen, motion.samples.map(({ value, offset }) => ({
        transform: transformAt(value), offset,
      })))
      if (pan.under) {
        animateTransform(pan.under, motion.samples.map(({ value, offset }) => ({
          transform: transformAt(underOffset(value)), offset,
        })))
      }
      if (pan.trailing) {
        animateTransform(pan.trailing.screen, motion.samples.map(({ value, offset }) => ({
          transform: transformAt(value + pan.trailing.shift), offset,
        })))
      }
      prepared?.forEach((animation) => animation.cancel())
      pan.animations = animations
      // В WebKit ready может прийти со startTime из момента отпускания:
      // подготовка слоёв уже «съела» первые кадры пружины. Держим время на
      // нуле до готовности всех анимаций, затем запускаем их общими часами.
      Promise.all(animations.map((animation) => animation.ready)).then(() => {
        if (pan !== finished || pan.animations !== animations) return
        setSwipePhase('settle')
        const start = document.timeline.currentTime
        animations.forEach((animation) => {
          animation.play()
          if (start !== null) animation.startTime = start
        })
      }, () => {})
      Promise.all(animations.map((animation) => animation.finished)).then(() => {
        if (pan === finished && pan.animations === animations) {
          setOffset(x)
          done()
        }
      }, () => {
        // Наш cancelAnimations сначала снимает ссылку. Если её сохранили,
        // анимацию отменил композитор: выбранный переход всё равно завершаем.
        if (pan === finished && pan.animations === animations) {
          cancelAnimations()
          setOffset(x)
          done()
        }
      })
    }

    const settle = (motion, done) => {
      finishLive = null
      pan.advance = null
      // Возврат тоже можно взять под палец. Если касание оказалось тапом
      // или вертикальным скроллом, продолжим с удержанного положения.
      pan.resume = () => settle(settleMotion(0), done)
      actionsRef.current.onCommit?.(null)
      animateOffset(0, motion, () => {
        reset()
        done?.()
      })
    }

    // Живой переход: экраны доезжают, потом меняется маршрут. Новый экран к
    // этому моменту уже на месте, поэтому коммит роутера ничего не двигает, а
    // инлайн-стили снимаются в его layout-эффекте — до отрисовки кадра.
    const commitLive = (dir, motion, action) => {
      const finished = pan
      let navigated = false
      const navigateNow = (handoff = false) => {
        if (navigated || pan !== finished) return
        navigated = true
        finishLive = null
        cancelAnimations()
        committing = true
        setSwipePhase('commit')
        // Доезд завершён — под конечными кадрами остаются конечные стили.
        finished.screen.style.transition = 'none'
        finished.under.style.transition = 'none'
        if (!handoff) finished.under.style.transform = ''
        const done = () => {
          clearTimeout(routeCommitTimer)
          cancelRouteCommit = null
          committing = false
          routeRequested = false
          currentScreenKey = actionsRef.current.screenKey
          if (pan === finished && handoff) {
            if (activeScreen() !== finished.under) {
              cancelGesture()
              return
            }
            // Палец уже на входящей вкладке. Меняем владельца жеста,
            // сохраняя обе видимые позиции и прогресс индикатора.
            const offset = underOffset(finished.offset)
            const outgoing = finished.screen
            if (finished.trailing) clearScreen(finished.trailing.screen)
            finished.trailing = null
            // Передача принадлежит текущему касанию. Если хранить её на pan,
            // следующий палец наследует старое направление и при развороте
            // отправляет экран за центр, оставляя с той стороны пустоту.
            if (g) g.handoffDirection = finished.underDir
            finished.screen = finished.under
            finished.under = outgoing
            finished.underDir *= -1
            finished.screen.style.zIndex = '2'
            finished.under.style.zIndex = '1'
            finished.under.style.visibility = 'visible'
            finished.advance = null
            finished.resume = () => settle(settleMotion(0))
            setOffset(offset)
          } else if (pan === finished) reset()
          resumeInput()
          if (handoff && !g) resumePaused()
        }
        cancelRouteCommit = afterNextRouteCommit(done)
        routeCommitTimer = setTimeout(cancelGesture, 1000)
        skipNextTransitionAnimation()
        requestNavigation(action)
      }
      const resume = (nextMotion) => {
        finishLive = navigateNow
        animateOffset(exitOffset(dir), nextMotion, navigateNow)
      }
      pan.resume = () => resume(settleMotion(exitOffset(dir)))
      pan.advance = () => navigateNow(true)
      resume(motion)
    }

    const resumePaused = () => {
      if (!finishLive && !committing && !pan?.animations) pan?.resume?.()
    }

    const onStart = (e) => {
      queuedMove = queuedEnd = null
      if (e.touches.length !== 1) {
        onCancel()
        return
      }
      if (pan?.animations && !busy && !committing) {
        // И переход, и возврат останавливаются уже на касании. Иначе во
        // время распознавания нового жеста экран продолжал уезжать из-под
        // пальца, а при захвате менял позицию ещё на несколько пикселей.
        const offset = new DOMMatrixReadOnly(getComputedStyle(pan.screen).transform).m41
        cancelAnimations()
        finishLive = null
        setOffset(offset)
        setSwipePhase('hold')
      }
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
      if (!target || target.closest(IGNORE) || insideHorizontalScroller(target, container)) {
        resumePaused()
        return
      }
      const t = e.touches[0]
      const hit = target === edgeGuard ? elementBelow(t.clientX, t.clientY) : target
      const fromDestination = Boolean(pan?.tabSwipe && pan.advance && hit && hit !== pan.screen && hit.closest('.screen') !== pan.screen)
      // Геометрия до записей стилей: первый кадр свайпа не должен ждать
      // синхронной раскладки после показа соседнего экрана.
      g = { x: t.clientX, originX: t.clientX, y: t.clientY, width: container.clientWidth || window.innerWidth, dx: 0, minDx: 0, maxDx: 0, axis: null, fromDestination, startT: e.timeStamp, lastT: e.timeStamp, v: 0, samples: [{ x: t.clientX, t: e.timeStamp }] }
    }

    const onMove = (e) => {
      if (!g) return
      if (e.touches.length !== 1) {
        onCancel()
        return
      }
      const t = e.touches[0]
      let dx = t.clientX - g.x
      const dy = t.clientY - g.y
      if (!g.axis) {
        if (Math.abs(dx) < AXIS_LOCK_PX && Math.abs(dy) < AXIS_LOCK_PX) return
        if (!g.waitingForCommit && Math.abs(dx) < Math.abs(dy) * AXIS_RATIO) {
          g = null
          resumePaused()
          return
        }
        // Первый экран уже доехал, но роутер ещё не сменил его. Сохраняем
        // движение и отпускание: второй короткий флик может закончиться
        // целиком до коммита, без ещё одного pointermove после него.
        if (committing) {
          g.waitingForCommit = true
          queuedMove = e
          return
        }
        if (g.fromDestination && pan?.advance && Math.sign(dx) === pan.underDir) {
          g.waitingForCommit = true
          queuedMove = e
          pan.advance()
          return
        }
        const screen = activeScreen()
        if (!screen) {
          g = null
          resumePaused()
          return
        }
        g.axis = 'x'
        g.waitingForCommit = false
        // Новый жест во время возврата подхватывает экран там, где он сейчас
        // виден, вместо скачка к логическому нулю.
        if (pan?.screen === screen) {
          const offset = new DOMMatrixReadOnly(getComputedStyle(screen).transform).m41
          const offsetAction = offset > 0 ? actionsRef.current.right : actionsRef.current.left
          const rawOffset = offsetAction ? offset : offset / RESISTANCE
          g.x -= rawOffset
          dx += rawOffset
          g.minDx = g.handoffDirection ? offset : Math.min(g.minDx, offset)
          g.maxDx = g.handoffDirection ? offset : Math.max(g.maxDx, offset)
          cancelAnimations()
          if (pan.offset !== offset) setOffset(offset)
          finishLive = null
          pan.resume = null
          pan.advance = null
        } else {
          reset()
          releaseHeavy = holdHeavyAnimations()
          container.setAttribute('data-swiping', '')
          pan = {
            screen,
            under: null,
            underDir: 0,
            width: g.width,
            offset: 0,
            animations: null,
            dragFrame: 0,
            tabSwipe: !actionsRef.current.back,
          }
          screen.style.willChange = 'transform'
          screen.style.zIndex = '2'
        }
        if (pan.tabSwipe && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
          pan.dragAnimations = new Map()
        }
        pan.dragSamples = [{ x: pan.offset, t: g.startT }]
        pan.dragVelocity = 0
        setSwipePhase('drag')
        // touch-action: pan-y pinch-zoom уже разделяет оси. Менять overflow
        // здесь нельзя: WebKit пересоздаёт слой прокрутки в начале и конце
        // жеста, заново растеризуя содержимое экрана.
      }
      sampleVelocity(t.clientX, e.timeStamp)
      updateDrag(dx)
    }

    const updateDrag = (raw, render = true) => {
      const action = raw > 0 ? actionsRef.current.right : actionsRef.current.left
      // Продолжение доезда может пройти больше ширины: сосед уже на месте,
      // двигать его дальше означало бы пустой край и обратный отскок пружины.
      g.dx = action
        ? Math.sign(raw) * (pan.tabSwipe ? Math.min(Math.abs(raw), pan.width) : Math.abs(raw))
        : raw * RESISTANCE
      g.minDx = Math.min(g.minDx, g.dx)
      g.maxDx = Math.max(g.maxDx, g.dx)
      if (render) {
        if (pan.dragFrame) return
        const dragging = pan
        // Несколько touchmove между кадрами меняют только намерение. DOM и
        // скорость видимого экрана обновляем один раз на такт дисплея.
        pan.dragFrame = requestAnimationFrame((time) => {
          dragging.dragFrame = 0
          if (pan !== dragging || g?.axis !== 'x') return
          const dir = Math.sign(g.dx)
          const dragAction = dir > 0 ? actionsRef.current.right : actionsRef.current.left
          showUnder(dragAction && dir ? dir : 0)
          setOffset(g.dx)
          pan.dragVelocity = sample(pan.dragSamples, g.dx, time)
        })
      }
    }

    const sample = (samples, x, time) => {
      samples.push({ x, t: time })
      while (samples.length > 2 && time - samples[0].t > VELOCITY_WINDOW_MS) samples.shift()
      const first = samples[0]
      return (x - first.x) / Math.max(1, time - first.t)
    }

    const sampleVelocity = (x, time) => {
      g.v = sample(g.samples, x, time)
      g.lastT = time
    }

    const onEnd = (e) => {
      if (!g) {
        resumePaused()
        return
      }
      if (committing) {
        queuedEnd = e
        return
      }
      const { axis } = g
      // Скорость последнего движения определяет намерение. touchend может
      // прийти позже с той же координатой и обнулить её — это не отмена флика.
      const movementAge = e.timeStamp - g.lastT
      const movementVelocity = movementAge > STALE_VELOCITY_MS ? 0 : g.v
      // Записанный touchmove ещё мог не попасть в кадр. Доезд наследует
      // положение и скорость последнего кадра, а не очередь событий.
      const renderedAge = pan?.dragSamples ? e.timeStamp - pan.dragSamples.at(-1).t : Infinity
      let animationVelocity = renderedAge > STALE_VELOCITY_MS ? 0 : pan?.dragVelocity || 0
      if (renderedAge > RELEASE_GRACE_MS && pan?.dragSamples) {
        animationVelocity = sample([...pan.dragSamples], pan.offset, e.timeStamp)
      }
      if (axis === 'x' && pan && e.changedTouches?.[0]) {
        const x = e.changedTouches[0].clientX
        const lastX = g.samples[g.samples.length - 1].x
        const correction = x - lastX
        const liftingCorrection = correction * g.dx < 0 && Math.abs(correction) <= TAP_SLOP_PX
        if (correction !== 0 && !liftingCorrection) {
          // Safari может отдать остаток быстрого движения только в touchend.
          // Координата влияет на намерение, а доезд начинает с экрана,
          // который уже был под пальцем: прямой сдвиг здесь давал скачок.
          updateDrag(x - g.x, false)
          sampleVelocity(x, e.timeStamp)
        } else if (movementAge > RELEASE_GRACE_MS) {
          // Пауза перед отпусканием гасит скорость; немедленное отпускание
          // сохраняет скорость последних движений, без торможения на стыке.
          sampleVelocity(lastX, e.timeStamp)
        }
      }
      const { dx, minDx, maxDx, handoffDirection } = g
      const intentDx = handoffDirection ? g.samples.at(-1).x - g.originX : dx
      const v = e.timeStamp - g.lastT > STALE_VELOCITY_MS ? 0 : g.v
      g = null
      if (axis !== 'x' || !pan) {
        resumePaused()
        return
      }
      cancelDragFrame()
      setSwipePhase('release')
      const dir = intentDx > 0 ? 1 : -1
      const action = dir > 0 ? actionsRef.current.right : actionsRef.current.left
      // Очень короткий флик может закончиться до первого кадра протяжки.
      // Сосед уже смонтирован: начинаем живой доезд от нуля, без подмены
      // маршрута и скачка к непоказанной координате пальца.
      if (pan.offset === 0 && !pan.underDir) showUnder(action ? dir : 0)
      const width = pan.width
      const reversedDistance = dir > 0 ? maxDx - dx : dx - minDx
      const reversing = reversedDistance >= REVERSE_MIN_PX &&
        Math.min(v * dir, movementVelocity * dir) < -FLING_VELOCITY
      const continueHandoff = handoffDirection === dir
      // После передачи жеста входящий экран ещё может быть правее центра,
      // хотя второй флик уже направлен к следующей вкладке. Остаток старой
      // вкладки тоже доезжает: до пересечения центра нужны три экрана.
      const commit =
        action && (dx * pan.offset >= 0 || continueHandoff) && !reversing &&
        (Math.abs(intentDx) >= width * COMMIT_FRACTION ||
          (Math.max(v * dir, movementVelocity * dir) > FLING_VELOCITY && Math.abs(intentDx) >= FLING_MIN_PX))
      if (!commit) {
        settle(settleMotion(0, animationVelocity))
        return
      }
      haptic(HAPTIC.selection, { allowDomFallback: false })
      actionsRef.current.onCommit?.(dir)
      if (continueHandoff) showUnder(dir, pan.offset * dir < 0)
      // Небольшая поправка пальца не отменяет переход и не должна запускать
      // доезд в обратную сторону. Настоящий разворот обработан выше.
      const motion = settleMotion(exitOffset(dir), dir * Math.max(0, animationVelocity * dir))
      const ms = motion.duration

      if (pan.under) {
        commitLive(dir, motion, action)
        return
      }

      busy = true
      actionsRef.current.onPan?.(dir * width, width, `transform ${ms}ms ${EASE}`)
      // Под пальцем пусто — переход доигрывает View Transition: старый экран
      // (снапшот) уезжает от того места, где его отпустил палец, новый
      // одновременно въезжает из-под него.
      const root = document.documentElement.style
      root.setProperty('--swipe-from', `${pan.offset}px`)
      root.setProperty('--swipe-to', `${dir * (width + SHADOW_REACH)}px`)
      root.setProperty('--swipe-under', `${-dir * ENTER_SHIFT * width}px`)
      root.setProperty('--swipe-shadow', `${-dir * 12}px`)
      root.setProperty('--swipe-ms', `${ms}ms`)
      // Новый жест — только когда переход доиграл: дерево ::view-transition
      // пропускает касания к живому экрану под снапшотами, и протяжка во
      // время анимации невидимо двигала бы его, а по окончании он прыгал бы.
      const cancelSwipe = swipeNextTransition((finished) => {
        clearTimeout(routeCommitTimer)
        cancelRouteCommit = null
        reset()
        interruptible = true
        finished.finally(() => {
          busy = false
          interruptible = false
        })
      })
      if (cancelSwipe) {
        cancelRouteCommit = cancelSwipe
        // Навигации не случилось — вернуть экран на место.
        routeCommitTimer = setTimeout(() => {
          routeRequested = false
          cancelSwipe()
          cancelRouteCommit = null
          settle(settleMotion(0), () => {
            busy = false
          })
        }, 1000)
        requestNavigation(action)
        return
      }

      // Без View Transitions (старый WebKit, lite-mode, reduced motion):
      // старый экран доезжает, новый на коммите въезжает коротким сдвигом.
      animateOffset(dir * width, motion, () => {})
      skipNextTransitionAnimation()
      cancelRouteCommit = afterNextRouteCommit(() => {
        clearTimeout(routeCommitTimer)
        cancelRouteCommit = null
        routeRequested = false
        currentScreenKey = actionsRef.current.screenKey
        reset()
        busy = false
        if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
        activeScreen()?.animate(
          [{ transform: `translate3d(${-dir * ENTER_SHIFT * 100}%, 0, 0)` }, { transform: 'none' }],
          { duration: ENTER_MS, easing: EASE },
        )
      })
      routeCommitTimer = setTimeout(() => {
        routeRequested = false
        cancelRouteCommit?.()
        cancelRouteCommit = null
        reset()
        busy = false
      }, 1500)
      requestNavigation(action)
    }

    // Касание отобрала система (входящий звонок, жест iOS) — возвращаем экран
    // на место, а не переходим.
    const onCancel = () => {
      queuedMove = queuedEnd = null
      const wasDragging = g?.axis === 'x'
      g = null
      if (!pan || busy || committing) return
      if (!wasDragging && pan.resume) {
        resumePaused()
        return
      }
      if (!wasDragging && pan.animations) return
      settle(settleMotion(0))
    }

    // Касание у кромки, забранное у системы. preventDefault отменяет и
    // синтетический click, поэтому тап (палец почти не сдвинулся) кликаем
    // сами — по элементу под полосой.
    let edgeTap = null
    let edgeGuard = null
    const elementBelow = (x, y) => document.elementsFromPoint(x, y).find((el) => el !== edgeGuard) || null
    const onEdgeStart = (e) => {
      edgeTap = null
      if (e.touches.length !== 1) return
      const t = e.touches[0]
      e.preventDefault()
      edgeTap = { x: t.clientX, y: t.clientY }
    }
    const onEdgeEnd = (e) => {
      const tap = edgeTap
      edgeTap = null
      const t = e.changedTouches?.[0]
      if (!tap || !t) return
      if (Math.abs(t.clientX - tap.x) > TAP_SLOP_PX || Math.abs(t.clientY - tap.y) > TAP_SLOP_PX) return
      const target = elementBelow(tap.x, tap.y)
      if (!target) return
      target.closest(EDITABLE)?.focus()
      target.click()
    }
    // Edge-guard нужен только на iOS: WebKit в PWA имеет нативный жест «назад»
    // со своей анимацией снапшота. На Android этот guard с e.preventDefault()
    // блокирует касания и ломает системные жесты назад (особенно на Vivo/Funtouch).
    if (isIOS && isStandalone()) {
      edgeGuard = document.createElement('div')
      edgeGuard.className = 'swipe-edge-guard'
      edgeGuard.setAttribute('aria-hidden', 'true')
      edgeGuard.style.width = `${EDGE_PX}px`
      container.appendChild(edgeGuard)
      // Касание всплывает с полосы в контейнер — свайп ведёт его как обычно.
      edgeGuard.addEventListener('touchstart', onEdgeStart, { passive: false })
      edgeGuard.addEventListener('touchend', onEdgeEnd, { passive: true })
    }

    // На iOS pointerup приходит раньше совместимого touchend. Жест и
    // доезд должны передавать друг другу управление при отпускании пальца,
    // без ожидания второй очереди событий WebKit.
    let pointerId = null
    const pointerTouch = (e, ended = false) => ({
      target: e.target,
      timeStamp: e.timeStamp,
      touches: ended ? [] : [e],
      changedTouches: [e],
    })
    const releasePointer = () => {
      const id = pointerId
      pointerId = null
      if (id !== null && container.hasPointerCapture?.(id)) container.releasePointerCapture(id)
    }
    const onPointerStart = (e) => {
      if (e.pointerType === 'mouse') return
      if (!e.isPrimary) {
        onCancel()
        releasePointer()
        return
      }
      pointerId = e.pointerId
      onStart(pointerTouch(e))
    }
    const onPointerMove = (e) => {
      if (e.pointerId !== pointerId) return
      onMove(pointerTouch(e))
      if ((g?.axis === 'x' || g?.waitingForCommit) && !container.hasPointerCapture?.(pointerId)) container.setPointerCapture?.(pointerId)
    }
    const onPointerEnd = (e) => {
      if (e.pointerId !== pointerId) return
      onEnd(pointerTouch(e, true))
      releasePointer()
    }
    const onPointerCancel = (e) => {
      if (e.pointerId !== pointerId) return
      onCancel()
      releasePointer()
    }
    const onLostPointerCapture = (e) => {
      // При захвате контейнером дочерняя кнопка теряет implicit capture.
      // Её всплывшее событие — передача жеста, а не его отмена.
      if (e.target === container) onPointerCancel(e)
    }
    const cancelGesture = () => {
      g = null
      queuedMove = queuedEnd = null
      edgeTap = null
      releasePointer()
      cancelRouteCommit?.()
      cancelRouteCommit = null
      clearTimeout(routeCommitTimer)
      busy = interruptible = committing = routeRequested = false
      reset()
    }
    screenChangeRef.current = (key) => {
      if (key === currentScreenKey) return
      currentScreenKey = key
      // Свой коммит передаёт следующее касание новому экрану. Выбор
      // вкладки другим способом по-прежнему отменяет старый свайп.
      if (routeRequested) {
        routeRequested = false
        return
      }
      cancelGesture()
    }
    const listeners = window.PointerEvent ? {
      pointerdown: onPointerStart,
      pointermove: onPointerMove,
      pointerup: onPointerEnd,
      pointercancel: onPointerCancel,
      lostpointercapture: onLostPointerCapture,
    } : {
      touchstart: onStart,
      touchmove: onMove,
      touchend: onEnd,
      touchcancel: onCancel,
    }
    for (const [name, listener] of Object.entries(listeners)) container.addEventListener(name, listener, { passive: true })
    return () => {
      screenChangeRef.current = null
      edgeGuard?.remove()
      for (const [name, listener] of Object.entries(listeners)) container.removeEventListener(name, listener)
      cancelGesture()
    }
  }, [containerRef, enabled])
}
