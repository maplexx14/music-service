// Быстрый тап по строкам и карточкам треков на таче: действие — на отпускании
// пальца, а не по клику WebKit. Замер на iPhone (utils/frameMeter) показал,
// что внутри прокручиваемых списков WebKit отдаёт клик через ~50-60 мс после
// touchend (вне списков ~30): он сначала разбирается, не начало ли это
// прокрутки. Наши обработчики при этом занимают единицы миллисекунд.
//
// Элемент включается атрибутом data-fast-tap, его обычный onClick остаётся
// единственным обработчиком: на pointerup мы сами зовём el.click(), а
// настоящий клик WebKit, пришедший следом, гасим ещё до React. Мышь и
// клавиатура идут штатным кликом.
//
// Тапом не считается — и всё идёт обычным путём:
// - палец сдвинулся (свайп между вкладками, прокрутка, протяжка) или
//   система отменила касание (pointercancel);
// - палец держали дольше LONG_PRESS_MS — это долгое нажатие с меню;
// - касание внутри вложенной ссылки или кнопки (артист, лайк, «в плейлист»);
// - касание у левой кромки: там его забирает свайп «назад» и кликает сам
//   (useSwipeNavigation, EDGE_PX).
//
// Нельзя менять видимое на pointerdown: WebKit принимает это за меню по
// наведению и не отправляет клик вовсе. Здесь действие идёт на pointerup.

const SLOP_PX = 10
// Меньше LONG_PRESS_MS в TrackContextMenu (450): к этому моменту меню уже
// открылось, и тап поверх него был бы лишним.
const LONG_PRESS_MS = 400
const EDGE_PX = 20
// Сколько ждать клика WebKit, который надо погасить. Он может и не прийти:
// если наше действие изменило экран, WebKit клик не отправляет.
const SUPPRESS_MS = 700
const SUPPRESS_RADIUS_PX = 30
const NESTED = 'a[href], button, input, select, textarea, [role="button"], [role="slider"], [data-no-fast-tap]'

let installed = false
let pending = null
let suppress = null
let dispatching = false

// Клик, который сейчас отправляет быстрый тап (для замера в frameMeter: он
// не isTrusted, но это настоящий тап пользователя).
export const isFastTapClick = () => dispatching

function fastTapTarget(target) {
  if (!(target instanceof Element)) return null
  const el = target.closest('[data-fast-tap]')
  if (!el) return null
  const nested = target.closest(NESTED)
  if (nested && el.contains(nested) && nested !== el) return null
  return el
}

export function installFastTap() {
  if (installed || typeof document === 'undefined') return
  installed = true

  const cancel = () => {
    pending = null
  }

  document.addEventListener(
    'pointerdown',
    (e) => {
      pending = null
      if (e.pointerType !== 'touch' || !e.isPrimary || e.clientX <= EDGE_PX) return
      const el = fastTapTarget(e.target)
      if (el) pending = { el, x: e.clientX, y: e.clientY, at: e.timeStamp }
    },
    { capture: true, passive: true },
  )

  document.addEventListener(
    'pointermove',
    (e) => {
      if (!pending || !e.isPrimary) return
      if (Math.abs(e.clientX - pending.x) > SLOP_PX || Math.abs(e.clientY - pending.y) > SLOP_PX) cancel()
    },
    { capture: true, passive: true },
  )

  document.addEventListener('pointercancel', cancel, { capture: true, passive: true })
  // Прокрутка на таче гасит pointer-события не везде сразу — страхуемся самим
  // скроллом (в том числе вложенных контейнеров: scroll не всплывает).
  document.addEventListener('scroll', cancel, { capture: true, passive: true })

  document.addEventListener(
    'pointerup',
    (e) => {
      const tap = pending
      pending = null
      if (!tap || !e.isPrimary) return
      if (e.timeStamp - tap.at > LONG_PRESS_MS) return
      if (Math.abs(e.clientX - tap.x) > SLOP_PX || Math.abs(e.clientY - tap.y) > SLOP_PX) return
      if (!tap.el.isConnected || fastTapTarget(e.target) !== tap.el) return
      suppress = { x: e.clientX, y: e.clientY, until: performance.now() + SUPPRESS_MS }
      dispatching = true
      try {
        tap.el.click()
      } finally {
        dispatching = false
      }
    },
    { capture: true, passive: true },
  )

  // Клик WebKit после быстрого тапа — дубль. Гасим на window в фазе захвата,
  // до корня React, и по месту касания, а не по элементу: экран под пальцем
  // уже мог смениться, и клик ушёл бы в чужую кнопку.
  window.addEventListener(
    'click',
    (e) => {
      const s = suppress
      if (!s || !e.isTrusted) return
      suppress = null
      if (performance.now() > s.until) return
      if (Math.abs(e.clientX - s.x) > SUPPRESS_RADIUS_PX || Math.abs(e.clientY - s.y) > SUPPRESS_RADIUS_PX) return
      e.preventDefault()
      e.stopPropagation()
    },
    { capture: true },
  )
}
