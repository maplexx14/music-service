// Защита от случайных тапов на таче. Глобальный фильтр click в фазе
// перехвата на document: срабатывает раньше обработчиков React (они висят на
// корне) и гасит клик, который пользователь не имел в виду.
//
// 1. Тап-«стоппер». Палец, остановивший инерционную прокрутку или доводку
//    scroll-snap карусели, хочет остановить ленту, а не запустить трек под
//    собой. WebKit не всегда сам глушит такой клик (особенно во вложенных
//    overflow-контейнерах и после snap), поэтому: если в момент касания
//    что-то прокручивалось последние SCROLL_GUARD_MS — клик отменяем. Только
//    тап ВНУТРИ прокручивавшегося контейнера: нижнее меню, мини-плеер и всё,
//    что не едет вместе с лентой, нажимается сразу (раньше тап по меню во
//    время инерции глушился).
// 2. Края экрана. Держа телефон одной рукой, основание ладони и пальцы хвата
//    задевают самые края. Касание, начатое ближе EDGE_PX к левой/правой
//    кромке, кликом не считаем. Поля ввода и ползунки не трогаем — там
//    касание у края осознанное и клик не нужен.
//
// Блокируется только click: свои pointer/touch-жесты (перемотка, свайпы
// плеера, смахивание тоста) работают как раньше.

const SCROLL_GUARD_MS = 120
// Прокрутку считаем пользовательской только пока палец на экране и пока
// длится инерция после него. Программная (автоскролл текста песни, scrollTo
// наверх) иначе гасила бы осознанные тапы.
const MOMENTUM_MS = 2500
const EDGE_PX = 10
const EXEMPT = 'input, textarea, select, [contenteditable="true"], [data-touch-guard="off"]'

let installed = false

export function installTouchGuard() {
  if (installed || typeof document === 'undefined') return
  if (!window.matchMedia?.('(pointer: coarse)').matches) return
  installed = true

  let lastScrollAt = 0
  let lastScrollTarget = null
  let touching = false
  let lastTouchEndAt = -Infinity
  let blockClick = false
  let blockUntil = 0

  document.addEventListener(
    'scroll',
    (e) => {
      const now = performance.now()
      if (touching || now - lastTouchEndAt < MOMENTUM_MS) {
        lastScrollAt = now
        lastScrollTarget = e.target
      }
    },
    { passive: true, capture: true },
  )

  const touchEnd = (e) => {
    if (e.pointerType !== 'touch' || !e.isPrimary) return
    touching = false
    lastTouchEndAt = performance.now()
  }
  document.addEventListener('pointerup', touchEnd, { passive: true, capture: true })
  document.addEventListener('pointercancel', touchEnd, { passive: true, capture: true })

  document.addEventListener(
    'pointerdown',
    (e) => {
      if (e.pointerType !== 'touch' || !e.isPrimary) return
      touching = true
      const target = e.target instanceof Element ? e.target : null
      const exempt = !!target?.closest(EXEMPT)
      // Прокрутка документа (target — сам document) задела бы всё; у нас
      // лента — .main-content, так что это редкий случай. Меню исключаем явно:
      // оно fixed и не едет, даже если формально лежит внутри скроллера.
      const scroller = lastScrollTarget === document ? document.scrollingElement : lastScrollTarget
      const stopper =
        performance.now() - lastScrollAt < SCROLL_GUARD_MS &&
        !!target &&
        scroller instanceof Element &&
        scroller.contains(target) &&
        !target.closest('.mobile-nav-global')
      const edge = e.clientX < EDGE_PX || e.clientX > window.innerWidth - EDGE_PX
      blockClick = !exempt && (stopper || edge)
      // Клик приходит после pointerup; если его не будет (жест стал
      // скроллом), флаг не должен дожить до следующего касания.
      blockUntil = blockClick ? performance.now() + 1000 : 0
    },
    { passive: true, capture: true },
  )

  document.addEventListener(
    'click',
    (e) => {
      if (!blockClick) return
      blockClick = false
      if (performance.now() > blockUntil) return
      e.preventDefault()
      e.stopImmediatePropagation()
    },
    { capture: true },
  )
}
