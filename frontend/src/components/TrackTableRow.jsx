import { memo } from 'react'
import { Plus } from 'lucide-react'
import LikeHeart from './LikeHeart'
import { trackIntentHandlers } from '../store/playerStore'
import { openAddToPlaylist } from '../store/addToPlaylistStore'
import ArtistLink from './ArtistLink'
import defaultCover from '../assets/default-cover.webp'
import { resolveCoverUrl, handleCoverError } from '../utils/media'
import { formatDuration } from '../utils/format'

// Сколько верхних строк грузят обложку без ленивой загрузки.
const EAGER_ROWS = 12

// Строка таблицы треков — общая для плейлиста, «Понравившихся», альбома,
// исполнителя и внешнего плейлиста.
//
// Вынесена в memo-компонент ради плавности: раньше вся таблица рисовалась
// инлайном в странице, и любая смена трека, пауза или лайк перерисовывали
// КАЖДУЮ строку с её SVG-иконками — в «Понравившихся» после догрузки это
// сотни строк на одно нажатие. Теперь пропсы строки — примитивы и стабильные
// ссылки, и перерисовываются только строки, чьё состояние реально сменилось
// (старый и новый текущий трек, лайкнутая строка).
//
// Обработчики приходят через actionsRef (ref со свежими функциями страницы),
// а не пропсами: страница пересоздаёт их на каждом рендере, и прямая передача
// обнулила бы весь выигрыш от memo.
//
// isPlaying страница передаёт уже умноженным на isCurrent — иначе пауза
// задевала бы все строки, хотя эквалайзер нарисован только в текущей.
// «В плейлист» открывает общее окно (AddToPlaylistDialog); excludePlaylistId —
// плейлист, который в нём не предлагать (страница самого плейлиста).
function TrackTableRow({
  track,
  index,
  isCurrent,
  isPlaying,
  isLiked,
  excludePlaylistId,
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
      // Тап на таче срабатывает на отпускании, без задержки клика WebKit
      // (services/fastTap).
      data-fast-tap=""
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
          src={resolveCoverUrl(track.cover_url, 'thumb') || defaultCover}
          alt={track.title}
          className="track-table-cover"
          // Первый экран строк — сразу: ленивую загрузку WebKit запускает
          // только у самой кромки вьюпорта, и верх списка на iOS открывался
          // с пустыми квадратами.
          loading={index < EAGER_ROWS ? 'eager' : 'lazy'}
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
          <LikeHeart size={18} liked={!!isLiked} />
        </button>
        <button
          type="button"
          className="track-action-btn"
          onClick={(e) => {
            // Строка целиком — «играть»; кнопка внутри её не запускает.
            e.stopPropagation()
            // resolveId страницы — её ensureDbId: он заодно проставляет db_id
            // в списке, чтобы лайк у той же строки не импортировал трек снова.
            const { resolveId } = actionsRef.current
            openAddToPlaylist(track, {
              excludePlaylistId,
              resolveId: resolveId ? () => resolveId(track) : undefined,
            })
          }}
          title="Добавить в плейлист"
          aria-label="Добавить в плейлист"
          aria-haspopup="dialog"
        >
          <Plus size={18} />
        </button>
      </td>
    </tr>
  )
}

export default memo(TrackTableRow)
