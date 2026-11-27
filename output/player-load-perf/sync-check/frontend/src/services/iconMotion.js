import { isFastTapClick } from './fastTap'

const CONTROLS = 'button, a[href], [role="button"], [data-fast-tap]'
const icons = new WeakMap()
const active = new Map()
let installed = false

export function canAnimateIcons() {
  return typeof window !== 'undefined' &&
    !document.documentElement.classList.contains('lite-mode') &&
    !window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function registerAnimatedIcon(element, handle) {
  icons.set(element, handle)
  return () => {
    handle.stopAnimation()
    active.delete(handle)
    icons.delete(element)
  }
}

export function animateIcon(icon) {
  const handle = icons.get(icon)
  if (!handle || !canAnimateIcons()) return
  const playback = Symbol()
  active.set(handle, playback)
  Promise.resolve(handle.startAnimation()).finally(() => {
    if (active.get(handle) === playback) active.delete(handle)
  })
}

function controlAt(target) {
  const control = target instanceof Element ? target.closest(CONTROLS) : null
  if (!control || control.closest(':disabled, [aria-disabled="true"], .disabled')) return null
  return control
}

function animateControl(control) {
  if (!control) return
  for (const icon of control.querySelectorAll('[data-lucide-animated]')) {
    // A track row can contain several independent buttons.
    if (icon.closest(CONTROLS) === control && !icon.classList.contains('lucide-loader-2')) animateIcon(icon)
  }
}

export function installIconMotion() {
  if (installed || typeof document === 'undefined') return
  installed = true
  document.addEventListener('click', (event) => {
    // Fast tap dispatches detail=0; keyboard activation stays instant.
    if (event.detail === 0 && !isFastTapClick()) return
    animateControl(controlAt(event.target))
  }, { capture: true, passive: true })
  const stopActive = () => {
    if (canAnimateIcons()) return
    for (const handle of active.keys()) handle.stopAnimation()
    active.clear()
  }
  window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', stopActive)
  new MutationObserver(stopActive).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
}
