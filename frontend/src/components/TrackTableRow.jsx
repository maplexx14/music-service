import { memo } from 'react'
import { Download, MoreHorizontal, Plus } from '@/components/icons'
import LikeHeart from './LikeHeart'
import { openAddToPlaylist } from '../store/addToPlaylistStore'
import { trackIntentHandlers } from '../store/playerStore'
import ArtistLink from './ArtistLink'
import SourceIcon from './SourceIcon'
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
// Пункт «В плейлист» открывает общее окно (AddToPlaylistDialog); excludePlaylistId —
// плейлист, который в нём не предлагать (страница самого плейлиста).
function TrackTableRow({
  track,
  index,
  isCurrent,
  isPlaying,
  isLiked,
  excludePlaylistId,
  showNumber = true,
  showAlbum = true,
  sourceLabel,
  showBadges = false,
  showInlineMeta = false,
  showSource = false,
  showDownload = false,
  contextProps,
  actionsRef,
}) {
  const duration = formatDuration(track.duration)
  const cover = (
    <img
      src={resolveCoverUrl(track.cover_url, 'thumb') || defaultCover}
      alt={track.title}
      className="track-table-cover"
      loading={index < EAGER_ROWS ? 'eager' : 'lazy'}
      decoding="async"
      onError={handleCoverError}
    />
  )
  return (
    <tr
      className={`track-row${showInlineMeta && sourceLabel ? ' track-row--with-meta' : ''}${isCurrent ? ' playing' : ''}`}
      // Тап на таче срабатывает на отпускании, без задержки клика WebKit
      // (services/fastTap).
      data-fast-tap=""
      onClick={() => actionsRef.current.play(track, index)}
      {...trackIntentHandlers(track)}
      {...contextProps}
    >
      {showNumber && (
        <td className="track-number">
          {isCurrent ? (
            <span className={`now-playing-bars${isPlaying ? '' : ' paused'}`}>
              <span /><span /><span />
            </span>
          ) : (
            index + 1
          )}
        </td>
      )}
      <td className="track-name-cell">
        <div className="track-name-content">
          {showSource ? (
            <span className="source-cover">
              {cover}
              <SourceIcon source={track.provider || track.source} />
            </span>
          ) : cover}
          <div>
            <div className="track-name" title={track.title}>
              {track.title}
              {showBadges && track.is_explicit && <span className="track-badge track-badge-e">E</span>}
              {showBadges && track.is_clean && <span className="track-badge track-badge-clean">CLEAN</span>}
            </div>
            <ArtistLink artist={track.artist} className="track-artist track-artist--inline" />
            {/* Источник возвращаем под название на узких экранах. */}
            {showInlineMeta && sourceLabel && (
              <div className="track-inline-meta">
                <span>{sourceLabel}</span>
              </div>
            )}
          </div>
        </div>
      </td>
      <td className="track-artist-cell">
        <ArtistLink artist={track.artist} className="track-artist" />
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
        {showDownload && track.download_allowed && track.download_url && (
          <a
            className="track-action-btn track-action-btn--desktop"
            href={track.download_url}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => event.stopPropagation()}
            aria-label={`Скачать ${track.title}`}
          >
            <Download size={18} />
          </a>
        )}
        <button
          type="button"
          className={`track-action-btn track-action-btn--desktop${isLiked ? ' liked' : ''}`}
          onClick={(e) => actionsRef.current.toggleLike(track, e)}
          title={isLiked ? 'Убрать из понравившихся' : 'В понравившиеся'}
          aria-label={isLiked ? 'Убрать из понравившихся' : 'В понравившиеся'}
        >
          <LikeHeart size={18} liked={!!isLiked} />
        </button>
        <button
          type="button"
          className="track-action-btn track-action-btn--desktop"
          onClick={(e) => {
            e.stopPropagation()
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
        <button
          type="button"
          className="track-action-btn track-action-btn--menu"
          onClick={(e) => {
            const { resolveId } = actionsRef.current
            actionsRef.current.openMenu(track, e, {
              onLike: (event) => actionsRef.current.toggleLike(track, event),
              excludePlaylistId,
              resolveId: resolveId ? () => resolveId(track) : undefined,
            })
          }}
          title="Действия с треком"
          aria-label={`Действия с треком ${track.title}`}
          aria-haspopup="menu"
        >
          <MoreHorizontal size={18} />
        </button>
      </td>
    </tr>
  )
}

export default memo(TrackTableRow)
