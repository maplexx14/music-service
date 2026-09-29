import { useEffect, useLayoutEffect, useRef } from 'react'
import { useLocation, useNavigationType } from 'react-router-dom'
import { isTabRoot } from '../services/navigation'

// Скролл экрана живёт в .main-content, который Layout не размонтирует: без
// этого хука новый экран открывался на той же высоте, что и прошлый (артист
// посреди списка), а «Назад» возвращал в начало длинного плейлиста, а не туда,
// откуда ушёл. Как в нативном стеке экранов: вперёд — сверху, назад — ровно
// на прежнем месте.
//
// Позиция пишется по ключу записи истории (location.key), поэтому два захода
// на один и тот же плейлист помнят каждый свою. Корни вкладок дополнительно
// помнят позицию по пути: переключение вкладок в таб-баре возвращает туда,
// где вкладку оставили, а не наверх.

// Сколько ждём, пока возвращённый экран дорастёт до сохранённой высоты
// (подгрузка данных без кэша, картинки без размеров).
const RESTORE_WINDOW_MS = 1200
const MAX_POSITIONS = 100

const positions = new Map()

function remember(key, top) {
  positions.delete(key)
  positions.set(key, top)
  if (positions.size > MAX_POSITIONS) positions.delete(positions.keys().next().value)
}

export function useScrollRestoration(scrollerRef) {
  const location = useLocation()
  const navigationType = useNavigationType()
  const keyRef = useRef(location.key)
  const pathRef = useRef(location.pathname)
  const cancelRestoreRef = useRef(null)

  // Позиция текущего экрана — непрерывно, по событию скролла: к моменту
  // смены роута DOM уже новый и scrollTop прошлого экрана не прочитать.
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return undefined
    const onScroll = () => {
      remember(keyRef.current, el.scrollTop)
      if (isTabRoot(pathRef.current)) remember(`tab:${pathRef.current}`, el.scrollTop)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [scrollerRef])

  // Layout-эффект: срабатывает в том же коммите, что и новый экран, до
  // снапшота view transition — анимация сразу едет с правильной позиции.
  useLayoutEffect(() => {
    const el = scrollerRef.current
    const samePath = pathRef.current === location.pathname
    keyRef.current = location.key
    pathRef.current = location.pathname
    cancelRestoreRef.current?.()
    cancelRestoreRef.current = null

    // Смена query/hash на том же экране (фильтры, поиск) скролл не трогает.
    if (el && !samePath) {
      const saved =
        navigationType === 'POP'
          ? positions.get(location.key)
          : isTabRoot(location.pathname)
            ? positions.get(`tab:${location.pathname}`)
            : undefined
      if (!saved) {
        el.scrollTop = 0
      } else {
        el.scrollTop = saved
        if (Math.abs(el.scrollTop - saved) > 1) {
          cancelRestoreRef.current = restoreWhenTallEnough(el, saved)
        }
      }
    }
  }, [location.key])

  useEffect(() => () => cancelRestoreRef.current?.(), [])
}

// Экран без кэша дорастает до прежней высоты не сразу: докручиваем позицию
// по мере роста, пока пользователь сам не взялся за скролл.
function restoreWhenTallEnough(el, target) {
  let frame = 0
  const deadline = performance.now() + RESTORE_WINDOW_MS
  const stop = () => {
    cancelAnimationFrame(frame)
    el.removeEventListener('touchstart', stop)
    el.removeEventListener('wheel', stop)
  }
  const tick = () => {
    el.scrollTop = target
    if (Math.abs(el.scrollTop - target) <= 1 || performance.now() > deadline) {
      stop()
      return
    }
    frame = requestAnimationFrame(tick)
  }
  el.addEventListener('touchstart', stop, { passive: true })
  el.addEventListener('wheel', stop, { passive: true })
  frame = requestAnimationFrame(tick)
  return stop
}
