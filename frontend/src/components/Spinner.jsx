import { useLayoutEffect } from 'react'
import BoltLoader from './BoltLoader'
import { markScreenLoading } from '../services/navigation'
import { useScreen } from '../hooks/useScreen'
import './Spinner.css'

// page — загрузка всего экрана: индикатор по центру видимой области
// (main в Layout или #root вне его), а не прижат к верху страницы.
// Экранный спиннер заодно задерживает анимированный переход, пока экран не
// загрузится (services/navigation.js, markScreenLoading). Только на видимом
// экране: скрытая вкладка, догружающаяся в фоне, переход не держит.
function Spinner({ label, page = false }) {
  const { active, pathname = '' } = useScreen()
  const pageLabel = pathname.startsWith('/artists/') ? 'Загрузка исполнителя…'
    : pathname.startsWith('/albums/') ? 'Загрузка альбома…'
      : pathname.startsWith('/playlists/') || pathname.startsWith('/external/') ? 'Загрузка плейлиста…'
        : pathname === '/playlists' ? 'Загрузка медиатеки…'
          : pathname === '/liked' ? 'Загрузка любимых треков…'
            : pathname === '/search' ? 'Загрузка поиска…'
              : pathname.startsWith('/track/') ? 'Загрузка трека…'
                : pathname.startsWith('/settings') ? 'Загрузка настроек…' : 'Загрузка…'
  const shownLabel = label ?? (page ? pageLabel : 'Загрузка…')
  useLayoutEffect(() => (page && active ? markScreenLoading() : undefined), [page, active])
  return (
    <div className={`spinner-wrap${page ? ' spinner-wrap--page' : ''}`} role="status" aria-label={shownLabel}>
      <BoltLoader size={40} frame={104} />
      <span className="spinner-label">{shownLabel}</span>
    </div>
  )
}

export default Spinner
