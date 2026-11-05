// Фаза живого свайпа для замера на устройстве. Меняется на границах жеста,
// без чтения стилей, обхода анимаций и дополнительных кадров.
let phase = null
const listeners = new Set()

export const getSwipePhase = () => phase

export function setSwipePhase(next) {
  if (next === phase) return
  phase = next
  listeners.forEach((listener) => listener(next))
}

export function onSwipePhase(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
