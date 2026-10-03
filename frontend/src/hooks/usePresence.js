import { useEffect, useRef, useState } from 'react'

// Анимация закрытия для условно рендеримых окон. Без неё шторка, меню или
// диалог исчезали одним кадром, хотя появлялись плавно, — в нативном
// приложении закрытие всегда зеркалит открытие (только быстрее).
//
// usePresence(value, exitMs) возвращает [shown, leaving]: пока value есть —
// [value, false]; когда value стал пустым — ещё exitMs держит последнее
// значение с leaving = true (CSS вешает анимацию ухода), затем [null, false].
// Новое значение во время ухода отменяет его сразу.
//
// Таймер, а не animationend: при выключенных анимациях (reduced motion,
// облегчённый режим) события не будет, и окно зависло бы на экране.
export function usePresence(value, exitMs) {
  const [shown, setShown] = useState(value)
  const [leaving, setLeaving] = useState(false)
  const timer = useRef(0)

  useEffect(() => {
    clearTimeout(timer.current)
    if (value) {
      setShown(value)
      setLeaving(false)
      return undefined
    }
    if (!exitMs || skipExit()) {
      setShown(null)
      setLeaving(false)
      return undefined
    }
    setLeaving(true)
    timer.current = setTimeout(() => {
      setShown(null)
      setLeaving(false)
    }, exitMs)
    return () => clearTimeout(timer.current)
  }, [value, exitMs])

  // Открытие рендерится в том же кадре, что и value, — без лишнего прохода
  // через эффект с пустым первым кадром.
  if (value) return [value, false]
  return [shown, leaving && Boolean(shown)]
}

function skipExit() {
  if (typeof window === 'undefined') return true
  if (document.documentElement.classList.contains('lite-mode')) return true
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}
