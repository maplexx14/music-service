// Отклик нажатия как у нативных контролов. Раньше это было глобальное
// правило `button:active, a:active { transform: scale(.96) }`, и оно дёргало
// интерфейс дважды:
//   * на таче :active включается в момент касания, поэтому при прокрутке
//     списка каждая строка и карточка под пальцем на миг «проваливалась»;
//   * transition был только у :active — отпущенный элемент возвращался к
//     scale(1) одним кадром, скачком.
// Здесь нажатие проявляется с короткой задержкой (начавшийся скролл его
// отменяет), глубина зависит от размера (крупная карточка сжимается едва
// заметно, иконка — ощутимо), а возврат анимирован. Анимируется отдельное
// свойство `scale`, поэтому собственные transform'ы компонентов не
// затираются, а через Web Animations — их transition'ы тоже.

const PRESSABLE = 'button, a[href], [role="button"], .track-card, [data-press]'
const TOUCH_DELAY_MS = 70
const MOVE_CANCEL_PX = 8

let installed = false

function pressedScale(el) {
  const { width, height } = el.getBoundingClientRect()
  const size = Math.max(width, height)
  if (!size) return null
  // ~5px «вдавливания» по большей стороне, но не глубже 4% (мелкие иконки).
  return Math.max(0.96, 1 - 5 / size)
}

function canPress(el) {
  if (!el.isConnected || el.matches(':disabled, [aria-disabled="true"]')) return false
  // Облегчённый режим отключает анимации — и эту тоже.
  if (document.documentElement.classList.contains('lite-mode')) return false
  // Свой transform в нажатом состоянии (компонентные :active-правила,
  // слайдеры) — поверх него второй scale был бы двойным.
  const style = getComputedStyle(el)
  return style.transform === 'none' && (!style.scale || style.scale === 'none')
}

export function installPressFeedback() {
  if (installed || typeof document === 'undefined' || typeof Element.prototype.animate !== 'function') return
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
  installed = true

  let current = null

  const release = (e) => {
    const c = current
    current = null
    if (!c) return
    clearTimeout(c.timer)
    if (!c.animation) {
      // Тап короче задержки: нажатие не успело проявиться — даём короткий
      // «пульс», иначе быстрые тапы остались бы вовсе без отклика.
      if (e?.type === 'pointerup') {
        const scale = canPress(c.el) && pressedScale(c.el)
        if (scale) {
          c.el
            .animate([{ scale: '1' }, { scale: String(scale), offset: 0.35 }, { scale: '1' }], {
              duration: 240,
              easing: 'cubic-bezier(0.23, 1, 0.32, 1)',
            })
            .finished.catch(() => {})
        }
      }
      return
    }
    const from = getComputedStyle(c.el).scale
    c.animation.cancel()
    c.el
      .animate([{ scale: from === 'none' ? '1' : from }, { scale: '1' }], {
        duration: 220,
        easing: 'cubic-bezier(0.23, 1, 0.32, 1)',
      })
      .finished.catch(() => {})
  }

  const press = (c) => {
    if (current !== c) return
    const el = c.el
    if (!canPress(el)) return
    const scale = pressedScale(el)
    if (!scale) return
    c.animation = el.animate([{ scale: '1' }, { scale: String(scale) }], {
      duration: 90,
      easing: 'cubic-bezier(0.23, 1, 0.32, 1)',
      fill: 'forwards',
    })
  }

  document.addEventListener(
    'pointerdown',
    (e) => {
      if (e.button !== 0 || !e.isPrimary) return
      release()
      const el = e.target instanceof Element ? e.target.closest(PRESSABLE) : null
      if (!el || el.closest('[data-no-press], input[type="range"]')) return
      const c = { el, x: e.clientX, y: e.clientY, timer: 0, animation: null }
      current = c
      if (e.pointerType === 'mouse') press(c)
      else c.timer = setTimeout(() => press(c), TOUCH_DELAY_MS)
    },
    { passive: true, capture: true },
  )

  document.addEventListener(
    'pointermove',
    (e) => {
      if (!current || !e.isPrimary) return
      if (Math.abs(e.clientX - current.x) > MOVE_CANCEL_PX || Math.abs(e.clientY - current.y) > MOVE_CANCEL_PX) {
        release()
      }
    },
    { passive: true, capture: true },
  )

  for (const type of ['pointerup', 'pointercancel', 'dragstart']) {
    document.addEventListener(type, release, { passive: true, capture: true })
  }
  // Прокрутка на таче гасит pointer-события (pointercancel), но не везде
  // сразу — страхуемся самим скроллом.
  document.addEventListener('scroll', release, { passive: true, capture: true })
  window.addEventListener('blur', release)
}
