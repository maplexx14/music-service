// Единая точка «следующий трек» для всех кнопок и жестов.
//
// Быстрый переход (подмена на заранее прогретый <audio>, см. audioEngine.swapTo)
// умеет делать только Player: у него элементы, слушатели и handoff. Фуллскрин и
// дизлайк раньше звали store.nextTrack() напрямую — трек менялся через эффект,
// src ставился на активный элемент с нуля, а готовый буфер следующего трека
// выбрасывался (clearStalePreload). Отсюда «то мгновенно, то ~6 секунд»:
// зависело от того, какой кнопкой переключили.
//
// Player регистрирует здесь свой обработчик; остальные зовут skipForward и
// передают фолбэк на случай, когда Player не смонтирован.

let handler = null

export function registerSkipForward(fn) {
  handler = fn
  return () => {
    if (handler === fn) handler = null
  }
}

export function skipForward(fallback) {
  if (handler) return handler()
  return fallback?.()
}
