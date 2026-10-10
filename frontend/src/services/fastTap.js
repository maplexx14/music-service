// Быстрый тап на таче: действие — на отпускании пальца, а не по клику WebKit.
// Замер на iPhone (utils/frameMeter) показал, что клик WebKit отдаёт через
// ~50-60 мс после touchend (вне списков ~30): он сначала разбирается, не
// начало ли это прокрутки и не меню ли по наведению. Наши обработчики при
// этом занимают единицы миллисекунд. Нативная кнопка срабатывает на
// отпускании, в следующем же кадре.
//
// Работает для кнопок, ссылок и всего с data-fast-tap (строки и карточки
// треков). Их обычный onClick остаётся единственным обработчиком: на
// pointerup мы сами зовём el.click(), а настоящий клик WebKit, пришедший
// следом, гасим ещё до React. Вместе с ним гасим и совместимые mousedown/
// mouseup, которые WebKit шлёт в ту же точку: если тап открыл диалог или
// меню, они попали бы в его подложку и закрыли его (подложки закрываются по
// mousedown). Действие по умолчанию у них остаётся — фокус уходит как обычно.
// Мышь и клавиатура идут штатным кликом.
//
// Тапом не считается — и всё идёт обычным путём:
// - палец сдвинулся (свайп между вкладками, прокрутка, протяжка) или
//   система отменила касание (pointercancel);
// - палец держали дольше LONG_PRESS_MS — это долгое нажатие с меню;
// - поля ввода, подписи к ним, ползунки, ссылки в новое окно и на скачивание,
//   а также всё с data-no-fast-tap;
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
// Сколько ждать событий WebKit, которые надо погасить. Они могут и не прийти:
// если наше действие изменило экран, WebKit клик не отправляет.
const SUPPRESS_MS = 700
const SUPPRESS_RADIUS_PX = 30
const FAST = '[data-fast-tap], button, [role="button"], a[href]'
const NEVER =
  'input, select, textarea, label, [contenteditable="true"], [role="slider"], [data-no-fast-tap], a[target], a[download]'
// Совместимые события мыши после тапа — в порядке, в каком их шлёт WebKit.
const COMPAT_EVENTS = ['mousedown', 'mouseup', 'click']

let installed = false
let pending = null
let suppress = null
let dispatching = false

// Клик, который сейчас отправляет быстрый тап (для замера в frameMeter: он
// не isTrusted, но это настоящий тап пользователя).
export const isFastTapClick = () => dispatching

function fastTapTarget(target) {
  if (!(target instanceof Element) || target.closest(NEVER)) return null
  const el = target.closest(FAST)
  if (!el || el.matches(':disabled, [aria-disabled="true"]')) return null
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

  // События WebKit после быстрого тапа — дубли. Гасим на window в фазе
  // захвата, до корня React, и по месту касания, а не по элементу: экран под
  // пальцем уже мог смениться, и клик ушёл бы в чужую кнопку. Клику отменяем
  // и действие по умолчанию, mousedown/mouseup — только доставку.
  const swallow = (e) => {
    const s = suppress
    if (!s || !e.isTrusted) return
    if (performance.now() > s.until) {
      suppress = null
      return
    }
    if (Math.abs(e.clientX - s.x) > SUPPRESS_RADIUS_PX || Math.abs(e.clientY - s.y) > SUPPRESS_RADIUS_PX) return
    if (e.type === 'click') {
      suppress = null
      e.preventDefault()
    }
    e.stopPropagation()
  }
  for (const type of COMPAT_EVENTS) window.addEventListener(type, swallow, { capture: true })
}
