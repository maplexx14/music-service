// FLIP-морф обложки мини-плеер ⇄ полноэкранный плеер БЕЗ View Transitions.
// На iOS PWA VT-снапшоты стабильно давали затемнение экрана после закрытия
// плеера (WebKit не применял ни блендинг, ни кастомные анимации групп), а
// чистые CSS-слайды — нет. Поэтому морфим клон <img> поверх обычных
// transition-слайдов плеера: клон непрозрачен, снапшотов нет, затемняться
// нечему. Оригинальные обложки на время морфа скрываются (подписка
// subscribeCoverMorph в FullScreenPlayer), чтобы не было двойной картинки.

let activeCount = 0
const subscribers = new Set()

// FullScreenPlayer прячет свою обложку, пока морф активен: клон летит
// поверх слайдящегося плеера, и вторая обложка внутри него не нужна.
export function subscribeCoverMorph(fn) {
  subscribers.add(fn)
  fn(activeCount)
  return () => subscribers.delete(fn)
}

export function isCoverMorphActive() {
  return activeCount > 0
}

function setActive(delta) {
  activeCount = Math.max(0, activeCount + delta)
  subscribers.forEach((fn) => fn(activeCount))
}

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

function drawerEase() {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--ease-drawer').trim()
  return value || 'ease'
}

// Прямоугольник элемента в ФИНАЛЬНОЙ позиции. На входе плеера его слайд
// (@starting-style translateY) уже анимируется, и getBoundingClientRect
// вернул бы сдвинутый прямоугольник — компенсируем текущую матрицу
// трансформа игрока (обложка — его потомок, сдвигается вместе с ним).
function settledRect(el) {
  const rect = el.getBoundingClientRect()
  const player = el.closest('.fullscreen-player')
  if (!player) return rect
  const transform = getComputedStyle(player).transform
  if (!transform || transform === 'none') return rect
  try {
    const m = new DOMMatrixReadOnly(transform)
    return new DOMRect(rect.left - m.m41, rect.top - m.m42, rect.width, rect.height)
  } catch {
    return rect
  }
}

// Видимый ненулевой прямоугольник (display:none — мобильный режим с текстом
// песни — даёт нули, морф там не нужен).
function usableRect(el) {
  if (!el) return null
  const r = el.getBoundingClientRect()
  return r.width >= 2 && r.height >= 2 ? r : null
}

function usable(r) {
  return r && r.width >= 2 && r.height >= 2 ? r : null
}

function fly(fromImg, fromRect, toImg, toRect, duration, srcOverride) {
  const fromRadius = getComputedStyle(fromImg).borderRadius
  const toRadius = getComputedStyle(toImg).borderRadius
  const clone = document.createElement('img')
  // srcOverride — hi-res обложка на открытии: мини-плеер показывает
  // уменьшенную, растянутая до размеров фуллскрина она мылилась бы в полёте.
  clone.src = srcOverride || fromImg.currentSrc || fromImg.src
  clone.alt = ''
  clone.style.cssText = [
    'position:fixed',
    `left:${fromRect.left}px`,
    `top:${fromRect.top}px`,
    `width:${fromRect.width}px`,
    `height:${fromRect.height}px`,
    'object-fit:cover',
    'transform-origin:top left',
    `border-radius:${fromRadius}`,
    'z-index:1300',
    'pointer-events:none',
  ].join(';')
  document.body.appendChild(clone)

  const dx = toRect.left - fromRect.left
  const dy = toRect.top - fromRect.top
  const scale = toRect.width / fromRect.width
  const anim = clone.animate(
    [
      { transform: 'translate(0px, 0px) scale(1)', borderRadius: fromRadius },
      { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, borderRadius: toRadius },
    ],
    { duration, easing: drawerEase(), fill: 'forwards' },
  )
  return new Promise((resolve) => {
    anim.onfinish = () => {
      clone.remove()
      resolve(true)
    }
    anim.oncancel = () => {
      clone.remove()
      resolve(false)
    }
  })
}

// Открытие: вызывается ДО openFullScreen — морф помечается активным, чтобы
// плеер смонтировался сразу со скрытой обложкой. Через два кадра (плеер
// смонтирован, слайд пошёл) меряем финальный прямоугольник и летим туда.
// 400ms — в такт слайду входа (.fullscreen-player transition transform).
export function beginOpenMorph(miniImg, hiResSrc) {
  const from = usableRect(miniImg)
  if (!from || reducedMotion()) return Promise.resolve(false)
  setActive(1)
  return new Promise((resolve) => {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const fullImg = document.querySelector('.fullscreen-art img')
        const to = fullImg ? usable(settledRect(fullImg)) : null
        if (!fullImg || !to) {
          setActive(-1)
          resolve(false)
          return
        }
        fly(miniImg, from, fullImg, to, 400, hiResSrc).finally(() => {
          setActive(-1)
          resolve(true)
        })
      }),
    )
  })
}

// Закрытие: обложка фуллскрина ещё видна, мини-плеер отрендерен под ней —
// меряем оба и летим вниз к мини-плееру. 300ms — в такт .is-closing.
export function beginCloseMorph() {
  const fullImg = document.querySelector('.fullscreen-art img')
  const miniImg = document.querySelector('.player-cover')
  const from = fullImg ? usableRect(fullImg) : null
  const to = usableRect(miniImg)
  if (!from || !to || reducedMotion()) return false
  setActive(1)
  fly(fullImg, from, miniImg, to, 300).finally(() => setActive(-1))
  return true
}
