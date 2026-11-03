// FLIP-морф обложки мини-плеер ⇄ полноэкранный плеер БЕЗ View Transitions.
// На iOS PWA VT-снапшоты стабильно давали затемнение экрана после закрытия
// плеера (WebKit не применял ни блендинг, ни кастомные анимации групп), а
// чистые CSS-слайды — нет. Поэтому морфим клон <img> поверх обычных
// transition-слайдов плеера: клон непрозрачен, снапшотов нет, затемняться
// нечему. Оригинальные обложки на время морфа скрываются (подписка
// subscribeCoverMorph в FullScreenPlayer), чтобы не было двойной картинки.

let activeCount = 0
const subscribers = new Set()
let flight = null
let pendingOpen = null
const morphNodes = new Set()

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

const animationsDisabled = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
  document.documentElement.classList.contains('lite-mode') ||
  typeof Element.prototype.animate !== 'function'

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

// Тень в координатах клона: он масштабирован, и тень уменьшается вместе с ним.
function scaledShadow(shadow, scale) {
  if (!shadow || shadow === 'none') return 'none'
  return shadow.replace(/(-?[\d.]+)px/g, (_, n) => `${parseFloat(n) / scale}px`)
}

// Внешний вид в экранных координатах. При прерывании полёта img уже
// масштабирован родителем — CSS-радиус и тень нужно умножить на этот масштаб.
function snapshot(img, rect, srcOverride) {
  const style = getComputedStyle(img)
  const scale = img.offsetWidth ? rect.width / img.offsetWidth : 1
  return {
    rect,
    src: srcOverride || img.currentSrc || img.src,
    radius: (parseFloat(style.borderRadius) || 0) * scale,
    shadow: scaledShadow(style.boxShadow, 1 / scale),
  }
}

export function cancelCoverMorph() {
  pendingOpen?.cancel()
  flight?.cancel()
  // Завершившийся клон ещё может ждать кадр с настоящей обложкой.
  for (const node of morphNodes) node.remove()
  morphNodes.clear()
}

function fly(from, to, duration) {
  // Растр сразу в большем размере, а движение — только transform. Два
  // статических варианта скругления и тени проявляются через opacity:
  // анимация border-radius/box-shadow перерисовывала обложку каждый кадр.
  const base = to.rect.width >= from.rect.width ? to.rect : from.rect
  const frame = (rect) => {
    const scale = rect.width / base.width
    return {
      transform: `translate(${rect.left - base.left}px, ${rect.top - base.top}px) scale(${scale})`,
    }
  }
  const node = document.createElement('div')
  node.dataset.coverMorph = ''
  node.setAttribute('aria-hidden', 'true')
  node.style.cssText = [
    'position:fixed',
    `left:${base.left}px`,
    `top:${base.top}px`,
    `width:${base.width}px`,
    `height:${base.height}px`,
    'transform-origin:top left',
    'isolation:isolate',
    'z-index:1300',
    'pointer-events:none',
  ].join(';')
  const images = [from, to].map((appearance, index) => {
    const img = document.createElement('img')
    const scale = appearance.rect.width / base.width
    img.src = from.src
    img.alt = ''
    img.dataset.noFade = ''
    img.style.cssText = [
      'position:absolute', 'inset:0', 'width:100%', 'height:100%',
      'object-fit:cover', 'outline:none', 'mix-blend-mode:plus-lighter',
      `border-radius:${appearance.radius / scale}px`,
      `box-shadow:${scaledShadow(appearance.shadow, scale)}`,
      `opacity:${index ? 0 : 1}`,
    ].join(';')
    node.appendChild(img)
    return img
  })
  const first = frame(from.rect)
  node.style.transform = first.transform
  document.body.appendChild(node)
  morphNodes.add(node)

  const options = { duration, easing: drawerEase(), fill: 'forwards' }
  const anim = node.animate([first, frame(to.rect)], options)
  const fades = images.map((img, index) => img.animate(
    [{ opacity: index ? 0 : 1 }, { opacity: index ? 1 : 0 }], options,
  ))
  return new Promise((resolve) => {
    let finished = false
    const remove = () => {
      node.remove()
      morphNodes.delete(node)
    }
    const finish = (ok) => {
      if (finished) return
      finished = true
      if (flight === current) flight = null
      resolve(ok)
      if (ok) {
        // Настоящую обложку открывает React. Клон убираем после её кадра.
        images.forEach((img) => { img.style.boxShadow = 'none' })
        requestAnimationFrame(() => requestAnimationFrame(remove))
      } else {
        fades.forEach((fade) => fade.cancel())
        remove()
      }
    }
    const current = { images, cancel: () => { anim.cancel(); finish(false) } }
    flight = current
    anim.onfinish = () => finish(true)
    anim.oncancel = () => finish(false)
  })
}

// Открытие: вызывается ДО openFullScreen — морф помечается активным, чтобы
// плеер смонтировался сразу со скрытой обложкой. Через два кадра (плеер
// смонтирован, слайд пошёл) меряем финальный прямоугольник и летим туда.
// 400ms — в такт слайду входа (.fullscreen-player transition transform).
export function beginOpenMorph(miniImg, hiResSrc) {
  cancelCoverMorph()
  const from = usableRect(miniImg)
  if (!from || animationsDisabled()) return Promise.resolve(false)
  const source = snapshot(miniImg, from, hiResSrc)
  setActive(1)
  return new Promise((resolve) => {
    const job = {
      frame: 0,
      cancel: () => {
        if (pendingOpen !== job) return
        pendingOpen = null
        cancelAnimationFrame(job.frame)
        setActive(-1)
        resolve(false)
      },
    }
    pendingOpen = job
    job.frame = requestAnimationFrame(() => {
      job.frame = requestAnimationFrame(() => {
        if (pendingOpen !== job) return
        pendingOpen = null
        const fullImg = document.querySelector('.fullscreen-art img.is-current')
        const to = fullImg ? usable(settledRect(fullImg)) : null
        if (!fullImg || !to) {
          setActive(-1)
          resolve(false)
          return
        }
        fly(source, snapshot(fullImg, to), 400).then((ok) => {
          setActive(-1)
          resolve(ok)
        })
      })
    })
  })
}

// Закрытие: обложка фуллскрина ещё видна, мини-плеер отрендерен под ней —
// меряем оба и летим вниз к мини-плееру. 300ms — в такт .is-closing.
export function beginCloseMorph() {
  const fullImg = document.querySelector('.fullscreen-art img.is-current')
  const miniImg = document.querySelector('.player-cover-wrap .player-cover')
  // Быстрое закрытие продолжает полёт из текущей позиции клона. Старый
  // полёт отменяем: две обложки, летящие в разные стороны, давали скачок.
  const flyingImg = flight?.images.reduce((a, b) =>
    Number(getComputedStyle(a).opacity) >= Number(getComputedStyle(b).opacity) ? a : b,
  )
  const fromImg = flyingImg || fullImg
  const from = usableRect(fromImg)
  const to = usableRect(miniImg)
  const source = from ? snapshot(fromImg, from) : null
  const target = to ? snapshot(miniImg, to) : null
  const waitingForOpen = Boolean(pendingOpen)
  cancelCoverMorph()
  if (!source || !target || waitingForOpen || animationsDisabled()) return false
  setActive(1)
  fly(source, target, 300).then(() => setActive(-1))
  return true
}
