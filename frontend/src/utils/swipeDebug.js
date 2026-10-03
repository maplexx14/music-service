// Замер свайпа между экранами на устройстве: включается и выключается
// тапом тремя пальцами (в установленном PWA адресной строки нет) или
// ссылкой с ?swipedebug=1 / ?swipedebug=0, дальше помнится. После
// каждой протяжки на 5 секунд показывает, сколько касаний и кадров в
// секунду было на самом деле и самую длинную паузу между кадрами — по ним
// видно, где теряется плавность: iOS шлёт касания редко или кадр долго
// рисуется.

const KEY = 'swipe-debug'

function readFlag() {
  try {
    const param = new URLSearchParams(window.location.search).get('swipedebug')
    if (param === '1') localStorage.setItem(KEY, '1')
    if (param === '0') localStorage.removeItem(KEY)
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

let enabled = typeof window !== 'undefined' && readFlag()

let box = null
let hideTimer = 0

function show(text) {
  if (!box) {
    box = document.createElement('div')
    box.style.cssText =
      'position:fixed;left:8px;right:8px;top:calc(env(safe-area-inset-top,0px) + 8px);z-index:99999;' +
      'padding:8px 10px;border-radius:10px;background:rgba(0,0,0,.85);color:#7CFC9A;' +
      'font:12px/1.4 ui-monospace,monospace;pointer-events:none;white-space:pre'
    document.body.appendChild(box)
  }
  box.textContent = text
  box.style.display = 'block'
  clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    box.style.display = 'none'
  }, 5000)
}

// Начало протяжки. Возвращает { move(handlerMs), end() } или null, если замер выключен.
export function startSwipeDebug() {
  if (!enabled) return null
  const t0 = performance.now()
  let moves = 0
  let handlerMax = 0
  let frames = 0
  let maxGap = 0
  let last = t0
  let raf = requestAnimationFrame(function tick(now) {
    frames += 1
    maxGap = Math.max(maxGap, now - last)
    last = now
    raf = requestAnimationFrame(tick)
  })
  return {
    move(handlerMs) {
      moves += 1
      handlerMax = Math.max(handlerMax, handlerMs)
    },
    end() {
      cancelAnimationFrame(raf)
      const sec = Math.max(0.001, (performance.now() - t0) / 1000)
      show(
        `касаний ${Math.round(moves / sec)}/с · кадров ${Math.round(frames / sec)}/с\n` +
          `макс. пауза кадра ${Math.round(maxGap)} мс · обработчик ≤${handlerMax.toFixed(1)} мс\n` +
          `длительность ${Math.round(sec * 1000)} мс`,
      )
    },
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length !== 3) return
      enabled = !enabled
      try {
        if (enabled) localStorage.setItem(KEY, '1')
        else localStorage.removeItem(KEY)
      } catch {
        // без хранилища замер живёт до перезапуска
      }
      show(enabled ? 'замер свайпа включён' : 'замер свайпа выключен')
    },
    { passive: true },
  )
}
