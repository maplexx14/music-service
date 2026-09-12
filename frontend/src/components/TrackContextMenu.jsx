import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Heart, ListPlus, X } from 'lucide-react'
import { usePlayerStore, trackLikeKey } from '../store/playerStore'
import { haptic, HAPTIC } from '../utils/haptics'
import './TrackContextMenu.css'

const LONG_PRESS_MS = 450
const LONG_PRESS_MOVE_TOLERANCE = 10

// Контекстное меню трека по long-press — как в нативных музыкальных
// приложениях. useTrackContextMenu() возвращает { getProps(track), menu,
// menuRef, close }; пропсы из getProps(track) кладутся на строку/карточку
// трека рядом с существующими, меню рендерится ОДИН раз на страницу —
// <TrackContextMenu menu={menu} ... /> в корне страницы.
//
// Действия переиспользуют логику playerStore: лайк здесь тот же, что у
// кнопки мини-плеера (включая материализацию внешних треков через
// pendingLikeKeys — сердечко зальётся мгновенно, сеть догонит).
export function useTrackContextMenu() {
  const [menu, setMenu] = useState(null) // { track, x, y }
  const pressTimer = useRef(null)
  const startPoint = useRef(null)
  const menuRef = useRef(null)

  const close = useCallback(() => setMenu(null), [])

  const clearPress = useCallback(() => {
    if (pressTimer.current) {
      clearTimeout(pressTimer.current)
      pressTimer.current = null
    }
    startPoint.current = null
  }, [])

  useEffect(() => clearPress, [clearPress])

  // Тап/клик мимо меню и Esc — закрыть. Слушатели вешаются на document
  // только пока меню открыто (иначе каждый touchstart на странице шёл бы
  // через этот хук). stopPropagation на самом меню не нужен: contains()
  // проверяет и все дочерние узлы.
  useEffect(() => {
    if (!menu) return undefined
    const onDocTouch = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) close()
    }
    const onKey = (e) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('touchstart', onDocTouch, { passive: true })
    document.addEventListener('mousedown', onDocTouch)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('touchstart', onDocTouch)
      document.removeEventListener('mousedown', onDocTouch)
      document.removeEventListener('keydown', onKey)
    }
  }, [menu, close])

  // Пропсы для элемента трека. Переданный track замыкается в таймере —
  // на каждую строку получается свой набор, ссылки не мемоизируем: тач-
  // обработчики на ре-рендере списка дешевле лишнего кэша пропсов.
  const getProps = useCallback(
    (track) => ({
      onContextMenu: (e) => {
        // Десктоп: правая кнопка — тот же маршрут, что и long-press.
        e.preventDefault()
        haptic(HAPTIC.light)
        setMenu({ track, x: e.clientX, y: e.clientY })
      },
      onTouchStart: (e) => {
        if (e.touches.length !== 1) return clearPress()
        const t = e.touches[0]
        startPoint.current = { x: t.clientX, y: t.clientY }
        pressTimer.current = setTimeout(() => {
          pressTimer.current = null
          const p = startPoint.current
          startPoint.current = null
          if (!p) return
          haptic(HAPTIC.light)
          setMenu({ track, x: p.x, y: p.y })
        }, LONG_PRESS_MS)
      },
      onTouchMove: (e) => {
        // Палец ушёл со строки — это скролл, а не long-press.
        const p = startPoint.current
        if (!p) return
        const t = e.touches[0]
        if (
          Math.abs(t.clientX - p.x) > LONG_PRESS_MOVE_TOLERANCE ||
          Math.abs(t.clientY - p.y) > LONG_PRESS_MOVE_TOLERANCE
        ) {
          clearPress()
        }
      },
      onTouchEnd: clearPress,
      onTouchCancel: clearPress,
    }),
    [clearPress],
  )

  return { menu, menuRef, close, getProps }
}

// Само меню: fixed через портал, координаты у пальца/курсора с клампом
// к краям вьюпорта. Ширина известна из CSS (230px), высота оценивается
// по числу пунктов — этого хватает, чтобы меню не вылезало за экран.
const MENU_W = 230
const MENU_H = 150

export function TrackContextMenu({ menu, menuRef, onClose }) {
  const toggleLikeForTrack = usePlayerStore((s) => s.toggleLikeForTrack)
  const likedTrackIds = usePlayerStore((s) => s.likedTrackIds)
  const pendingLikeKeys = usePlayerStore((s) => s.pendingLikeKeys)

  if (!menu) return null
  const { track } = menu

  const dbId =
    typeof track.id === 'number' ? track.id : typeof track.db_id === 'number' ? track.db_id : null
  const isLiked =
    (dbId ? likedTrackIds.includes(dbId) : false) || pendingLikeKeys.includes(trackLikeKey(track))

  const vw = window.innerWidth
  const vh = window.innerHeight
  const left = Math.min(Math.max(menu.x - MENU_W / 2, 12), vw - MENU_W - 12)
  const top = Math.min(Math.max(menu.y - 16, 12), vh - MENU_H - 12)

  const like = () => {
    onClose()
    haptic(HAPTIC.success)
    toggleLikeForTrack(track).catch((error) => console.error('Context like failed:', error))
  }

  return createPortal(
    <div className="track-ctx-backdrop" onTouchStart={onClose} onMouseDown={onClose}>
      <div
        ref={menuRef}
        className="track-ctx-menu"
        style={{ left, top }}
        role="menu"
        aria-label={`Действия с треком ${track.title}`}
      >
        <div className="track-ctx-header">
          <span className="track-ctx-title">{track.title}</span>
          <button type="button" className="track-ctx-close" onClick={onClose} aria-label="Закрыть">
            <X size={16} />
          </button>
        </div>
        <button type="button" className="track-ctx-item" role="menuitem" onClick={like}>
          <Heart size={18} fill={isLiked ? 'currentColor' : 'none'} />
          <span>{isLiked ? 'Убрать из понравившихся' : 'В понравившиеся'}</span>
        </button>
        <button type="button" className="track-ctx-item" role="menuitem" disabled>
          <ListPlus size={18} />
          <span>Добавить в плейлист…</span>
        </button>
      </div>
    </div>,
    document.body,
  )
}
