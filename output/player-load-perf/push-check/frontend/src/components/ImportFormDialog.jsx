import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useScreen } from '../hooks/useScreen'
import { useImportStore } from '../store/importStore'
import './ImportFormDialog.css'

const DESKTOP_QUERY = '(min-width: 769px)'

// На телефоне форма остаётся частью медиатеки; на ПК открывается над ней.
function ImportFormDialog({ children, onClose, triggerRef }) {
  const [desktop, setDesktop] = useState(() => window.matchMedia(DESKTOP_QUERY).matches)
  const { active } = useScreen()
  const progressOpen = useImportStore((state) => Boolean(state.openId))
  const dialogRef = useRef(null)
  const visible = desktop && active && !progressOpen

  useEffect(() => {
    const media = window.matchMedia(DESKTOP_QUERY)
    const onChange = () => setDesktop(media.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    if (!visible) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const dialog = dialogRef.current
    const input = dialog?.querySelector('input:not(:disabled)')
    ;(input || dialog)?.focus({ preventScroll: true })

    return () => {
      document.body.style.overflow = previousOverflow
      // Окно прогресса заменяет форму сразу после запуска импорта.
      // При переходе к нему фокус не должен возвращаться на страницу.
      const trigger = triggerRef.current
      if (trigger?.isConnected && !trigger.closest('[inert]') && !document.querySelector('[aria-modal="true"]')) {
        trigger.focus({ preventScroll: true })
      }
    }
  }, [visible, triggerRef])

  if (!desktop) return children
  if (!visible) return null

  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = [...dialogRef.current.querySelectorAll('button:not(:disabled), input:not(:disabled), summary, a[href], [tabindex="0"]')]
      .filter((element) => element.getClientRects().length > 0)
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const current = document.activeElement
    if (!first) {
      event.preventDefault()
      dialogRef.current.focus()
    } else if (event.shiftKey && (current === first || current === dialogRef.current)) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (current === last || current === dialogRef.current)) {
      event.preventDefault()
      first.focus()
    }
  }

  return createPortal(
    <div
      className="import-form-backdrop"
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return
        event.preventDefault()
        onClose()
      }}
    >
      <div
        ref={dialogRef}
        className="import-form-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="playlist-import-title"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </div>,
    document.body,
  )
}

export default ImportFormDialog
