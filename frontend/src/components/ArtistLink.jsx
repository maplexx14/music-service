import { memo } from 'react'
import { Link } from 'react-router-dom'
import { splitArtists, artistPath } from '../utils/artists'
import './ArtistLink.css'

// Имя исполнителя как ссылка на его страницу — «своя вкладка у каждого
// исполнителя». Строка с несколькими участниками («A, B», «A feat. B»)
// разбирается на отдельные ссылки: у каждого своя страница, а не общая на
// склеенную строку (см. utils/artists.js).
//
// stopPropagation обязателен: имя почти всегда лежит внутри кликабельной
// строки трека, и без него клик по ссылке заодно запускал бы воспроизведение.
// onNavigate — для мест, которые нужно закрыть при переходе (полноэкранный
// плеер: иначе страница артиста откроется под оверлеем).
function ArtistLink({ artist, className = '', onNavigate }) {
  const names = splitArtists(artist)
  if (names.length === 0) return null

  const handleClick = (e) => {
    e.stopPropagation()
    onNavigate?.()
  }

  return (
    <span className={className}>
      {names.map((name, index) => (
        <span key={`${name}-${index}`}>
          {index > 0 && <span className="artist-link-sep">, </span>}
          <Link
            to={artistPath(name)}
            className="artist-link"
            onClick={handleClick}
            title={`Открыть страницу «${name}»`}
          >
            {name}
          </Link>
        </span>
      ))}
    </span>
  )
}

export default memo(ArtistLink)
