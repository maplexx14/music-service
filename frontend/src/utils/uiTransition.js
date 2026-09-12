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
  // Пока идёт морф, страница нарисована снапшотами и не перерисовывается:
  // клик доходит до живого DOM (pointer-events: none у ::view-transition,
  // см. index.css), но visual feedback отстаёт на длину анимации. Поэтому
  // любой ввод трактуем как «анимацию досмотрели»: снапшоты снимаются
  // сразу, дальше страница живая. Тап, которым закрытие начали, случился
  // до startViewTransition — сам себя он не обрывает.
  const skip = () => {
    try {
      vt.skipTransition()
    } catch {
      /* переход уже завершился */
    }
  }
  window.addEventListener('pointerdown', skip, { capture: true, once: true })
  window.addEventListener('keydown', skip, { capture: true, once: true })
  vt.finished
    .catch(() => {})
    .finally(() => {
      window.removeEventListener('pointerdown', skip, { capture: true })
      window.removeEventListener('keydown', skip, { capture: true })
      document.documentElement.classList.remove('vt-swap')
    })
  return true
}
