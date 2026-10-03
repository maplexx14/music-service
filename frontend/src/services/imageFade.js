// Обложки проявляются, а не выпрыгивают. В нативных плеерах картинка,
// приехавшая из сети, растворяется за долю секунды; у нас она возникала
// одним кадром посреди уже нарисованной карточки — особенно заметно в
// длинных списках и на lazy-картинках при прокрутке.
//
// Анимируются только картинки, которые на момент вставки в DOM ещё не
// загружены: до load они ничего не рисуют, и проявление с нуля стыкуется
// без мигания. Уже готовые (кэш, возврат на экран) показываются сразу, а
// смена src у живого <img> (следующий трек) не анимируется — там под
// старой картинкой нет пустоты, и фейд из нуля мигнул бы.
//
// Ключевой кадр один — opacity: 0, конечный берётся из стилей элемента:
// скрытая компонентом картинка (opacity: 0) так и останется скрытой.

const FADE_MS = 200
// После error картинка остаётся в pending: заглушка (utils/media,
// handleCoverError) тоже ещё грузится и проявится так же.
const pending = new WeakSet()

function mark(img) {
  if (img.complete || img.dataset.noFade !== undefined) return
  pending.add(img)
}

function scan(node) {
  if (node.nodeType !== 1) return
  if (node.tagName === 'IMG') mark(node)
  else if (node.firstElementChild) node.querySelectorAll('img').forEach(mark)
}

function onLoad(e) {
  const img = e.target
  if (img.tagName !== 'IMG' || !pending.has(img)) return
  pending.delete(img)
  if (document.documentElement.classList.contains('lite-mode')) return
  img.animate([{ opacity: 0 }], { duration: FADE_MS, easing: 'ease-out' })
}

export function installImageFade() {
  if (typeof document === 'undefined' || typeof Element.prototype.animate !== 'function') return
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
  // load/error не всплывают — ловим на погружении.
  document.addEventListener('load', onLoad, true)
  new MutationObserver((records) => {
    for (const record of records) record.addedNodes.forEach(scan)
  }).observe(document.body, { childList: true, subtree: true })
}
