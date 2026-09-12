import { flushSync } from 'react-dom'

// Обёртка «незаметных» DOM-переключений через View Transitions API:
// мини-плеер ⇄ фуллскрин. Браузер снапшотит старое состояние, мы атомарно
// применяем React-обновление (без flushSync снапшот нового состояния
// поймал бы пустоту — React ещё не закоммитился), и морфит старое в новое.
// Обложка с view-transition-name: player-cover (инлайн-стили в Player и
// FullScreenPlayer) морфится как shared element: маленькая квадратная
// обложка мини-плеера «вырастает» в большую обложку фуллскрина и обратно.
//
// Возвращает true, если переход пошёл через VT; false — API нет или
// reduced-motion (обновление применено напрямую, вызывающий может
// показать свою fallback-анимацию).
export function uiTransition(update) {
  if (
    typeof document === 'undefined' ||
    typeof document.startViewTransition !== 'function' ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ) {
    update()
    return false
  }
  // Собственные анимации входа/выхода плеера (@starting-style-слайд и
  // .is-closing) на время свапа гасим классом .vt-swap: реальный DOM
  // скрыт под снапшотами, и анимация «в столе» выстрелила бы скачком
  // на финише перехода.
  document.documentElement.classList.add('vt-swap')
  const vt = document.startViewTransition(() => {
    flushSync(update)
  })
  vt.finished
    .catch(() => {})
    .finally(() => document.documentElement.classList.remove('vt-swap'))
  return true
}
