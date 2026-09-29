import { memo } from 'react'
import { Heart, Plus } from 'lucide-react'
import { trackIntentHandlers } from '../store/playerStore'
import ArtistLink from './ArtistLink'
import defaultCover from '../assets/default-cover.webp'
import { resolveCoverUrl, handleCoverError } from '../utils/media'
import { formatDuration } from '../utils/format'

// Строка таблицы треков — общая для плейлиста, «Понравившихся», альбома,
// исполнителя и внешнего плейлиста.
//
// Вынесена в memo-компонент ради плавности: раньше вся таблица рисовалась
// инлайном в странице, и любая смена трека, пауза или лайк перерисовывали
// КАЖДУЮ строку с её SVG-иконками — в «Понравившихся» после догрузки это
// сотни строк на одно нажатие. Теперь пропсы строки — примитивы и стабильные
// ссылки, и перерисовываются только строки, чьё состояние реально сменилось
// (старый и новый текущий трек, лайкнутая строка, строка с открытым меню).
//
// Обработчики приходят через actionsRef (ref со свежими функциями страницы),
// а не пропсами: страница пересоздаёт их на каждом рендере, и прямая передача
// обнулила бы весь выигрыш от memo.
//
// isPlaying страница передаёт уже умноженным на isCurrent — иначе пауза
// задевала бы все строки, хотя эквалайзер нарисован только в текущей.
// menuPlaylists — список для открытого меню, у остальных строк null.
function TrackTableRow({
  track,
  index,
  isCurrent,
  isPlaying,
  isLiked,
  menuOpen,
  menuPlaylists,
  menuEmptyText = 'Нет плейлистов',
  showAlbum = true,
  sourceLabel,
  showBadges = false,
  showInlineMeta = false,
  actionsRef,
}) {
  const duration = formatDuration(track.duration)
  return (
    <tr
      className={`track-row${isCurrent ? ' playing' : ''}`}
      onClick={() => actionsRef.current.play(track, index)}
      {...trackIntentHandlers(track)}
    >
      <td className="track-number">
        {isCurrent ? (
          <span className={`now-playing-bars${isPlaying ? '' : ' paused'}`}>
            <span /><span /><span />
          </span>
        ) : (
          index + 1
        )}
      </td>
      <td className="track-name-cell">
        <img
          src={resolveCoverUrl(track.cover_url) || defaultCover}
          alt={track.title}
          className="track-table-cover"
          loading="lazy"
          decoding="async"
          onError={handleCoverError}
        />
        <div>
          <div className="track-name">
            {track.title}
            {showBadges && track.is_explicit && <span className="track-badge track-badge-e">E</span>}
            {showBadges && track.is_clean && <span className="track-badge track-badge-clean">CLEAN</span>}
          </div>
          <ArtistLink artist={track.artist} className="track-artist" />
          {/* Колонки «Альбом» и «Длительность» на узких экранах скрыты —
              источник и хронометраж возвращаем сюда строкой, иначе на
              мобильном о треке не видно ничего, кроме названия. */}
          {showInlineMeta && (
            <div className="track-inline-meta">
              {sourceLabel && <span>{sourceLabel}</span>}
              {sourceLabel && duration && <span>·</span>}
              {duration && <span>{duration}</span>}
            </div>
          )}
        </div>
      </td>
      {showAlbum && (
        <td className="track-album">
          {track.album || (sourceLabel ? (
            <span className="artist-track-source">{sourceLabel}</span>
          ) : '-')}
        </td>
      )}
      <td className="track-duration">{duration}</td>
      <td className="track-actions-cell">
        <button
          type="button"
          className={`track-action-btn${isLiked ? ' liked' : ''}`}
          onClick={(e) => actionsRef.current.toggleLike(track, e)}
          title={isLiked ? 'Убрать из понравившихся' : 'В понравившиеся'}
          aria-label={isLiked ? 'Убрать из понравившихся' : 'В понравившиеся'}
        >
          <Heart size={18} fill={isLiked ? 'currentColor' : 'none'} />
        </button>
        <div className="add-to-playlist">
          <button
            type="button"
            className="track-action-btn"
            onClick={(e) => actionsRef.current.openMenu(track, e)}
            title="Добавить в плейлист"
            aria-label="Добавить в плейлист"
          >
            <Plus size={18} />
          </button>
          {menuOpen && (
            <div className="add-to-playlist-menu" onClick={(e) => e.stopPropagation()}>
              {menuPlaylists?.length > 0 ? (
                menuPlaylists.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="add-to-playlist-option"
                    onClick={(e) => actionsRef.current.addToPlaylist(track, p, e)}
                  >
                    {p.name}
                  </button>
                ))
              ) : (
                <div className="add-to-playlist-empty">{menuEmptyText}</div>
              )}
            </div>
          )}
        </div>
      </td>
    </tr>
  )
}

export default memo(TrackTableRow)
