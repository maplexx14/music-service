import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { usePlayerStore } from '../store/playerStore'
import { Play, Share, Shuffle } from 'lucide-react'
import api from '../services/api'
import {
  peekCache,
  writeCache,
  invalidateCache,
  playlistCacheKey,
  PLAYLIST_PAGE_SIZE,
} from '../services/pageCache'
import Spinner from '../components/Spinner'
import TrackTableRow from '../components/TrackTableRow'
import { useInfiniteScroll } from '../hooks/useInfiniteScroll'
import { toast } from '../store/toastStore'
import defaultCover from '../assets/default-cover.webp'
import { resolveCoverUrl, handleCoverError } from '../utils/media'
import { titleFitStyle } from '../utils/titleFit'
import { useCoverColors } from '../hooks/useCoverColors'
import { shareLink } from '../utils/shareLink'
import { DEFAULT_HERO_COLORS } from '../utils/coverColor'
import './PlaylistDetail.css'
// Шапка — та же hero-карточка в тон обложки, что у исполнителя.
import './Artist.css'

const TRACKS_PAGE_SIZE = PLAYLIST_PAGE_SIZE

function PlaylistDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  // Первая страница из кэша (прошлый заход или прогрев по наведению) рисуется
  // сразу, без спиннера; свежая версия приезжает фоном (см. fetchPlaylist).
  const [playlist, setPlaylist] = useState(() => peekCache(playlistCacheKey(id))?.playlist ?? null)
  const [loading, setLoading] = useState(() => !peekCache(playlistCacheKey(id)))
  const [totalTracks, setTotalTracks] = useState(() => peekCache(playlistCacheKey(id))?.total ?? 0)
  const [loadingMore, setLoadingMore] = useState(false)
  // Упавший запрос гасит автоподгрузку и возвращает кнопку: иначе наблюдатель
  // пересоберётся, снова упрётся в видимый маячок и страница уйдёт в цикл
  // падающих запросов.
  const [loadError, setLoadError] = useState(false)
  // Взведён, пока «Перемешать» добирает окно треков перед стартом (см.
  // shufflePlaylist в store) — иначе нажатие ничем не отвечает.
  const [shuffling, setShuffling] = useState(false)
  // Атомарные селекторы вместо подписки на весь store: страница со списком
  // треков больше не перерисовывается на каждом тике currentTime (~4/сек).
  const playPlaylist = usePlayerStore((s) => s.playPlaylist)
  const shufflePlaylist = usePlayerStore((s) => s.shufflePlaylist)
  // Только id: страница отмечает текущую строку, а подписка на весь объект
  // перерисовывала её и тогда, когда трек тот же, а объект новый.
  const currentTrackId = usePlayerStore((s) => s.currentTrack?.id)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const likedTrackIds = usePlayerStore((s) => s.likedTrackIds)
  const toggleTrackLike = usePlayerStore((s) => s.toggleTrackLike)
  const fetchLikedTracks = usePlayerStore((s) => s.fetchLikedTracks)
  const heroColors = useCoverColors(playlist?.cover_url) || DEFAULT_HERO_COLORS

  useEffect(() => {
    // Смена id без размонтирования: подставляем кэш нового плейлиста, а не
    // показываем старый до ответа сети.
    const cached = peekCache(playlistCacheKey(id))
    if (cached) {
      setPlaylist(cached.playlist)
      setTotalTracks(cached.total)
      setLoading(false)
    } else if (!playlist || String(playlist.id) !== String(id)) {
      setLoading(true)
    }
    fetchPlaylist()
    fetchLikedTracks()
  }, [id])

  // Кэш следует за списком, но хранит только первую страницу — остальное
  // догружается прокруткой.
  useEffect(() => {
    if (loading || !playlist || String(playlist.id) !== String(id)) return
    writeCache(playlistCacheKey(id), {
      playlist: { ...playlist, tracks: playlist.tracks.slice(0, TRACKS_PAGE_SIZE) },
      total: totalTracks,
    })
  }, [playlist, totalTracks, loading, id])

  const fetchPlaylist = async () => {
    try {
      const response = await api.get(`/playlists/${id}`, {
        params: { skip: 0, limit: TRACKS_PAGE_SIZE },
      })
      const fresh = response.data
      const total = Number(response.headers['x-total-count']) || fresh.tracks.length
      // Фоновое обновление не должно схлопывать уже догруженные страницы:
      // свежая голова, дальше то, что пользователь успел домотать.
      setPlaylist((prev) =>
        prev && String(prev.id) === String(fresh.id) && prev.tracks.length > fresh.tracks.length
          ? { ...fresh, tracks: [...fresh.tracks, ...prev.tracks.slice(fresh.tracks.length)] }
          : fresh
      )
      setTotalTracks(total)
    } catch (error) {
      console.error('Error fetching playlist:', error)
      // Упавшее фоновое обновление оставляет на экране кэш — кроме случая,
      // когда плейлиста больше нет.
      if (error.response?.status === 404 || !peekCache(playlistCacheKey(id))) {
        invalidateCache(playlistCacheKey(id))
        navigate('/playlists')
      }
    } finally {
      setLoading(false)
    }
  }

  const handleLoadMore = async () => {
    if (loadingMore) return
    setLoadingMore(true)
    setLoadError(false)
    try {
      const response = await api.get(`/playlists/${id}`, {
        params: { skip: playlist.tracks.length, limit: TRACKS_PAGE_SIZE },
      })
      setPlaylist((prev) => ({ ...prev, tracks: [...prev.tracks, ...response.data.tracks] }))
      setTotalTracks(Number(response.headers['x-total-count']) || totalTracks)
    } catch (error) {
      console.error('Error loading more tracks:', error)
      setLoadError(true)
      toast.error('Не удалось загрузить ещё треки')
    } finally {
      setLoadingMore(false)
    }
  }

  const hasMoreTracks = !!playlist && playlist.tracks.length < totalTracks
  // Следующая страница тянется сама, когда пользователь доскроллил до низа
  // списка. Кнопка остаётся только как способ повторить упавший запрос.
  const loadMoreRef = useInfiniteScroll(handleLoadMore, {
    enabled: hasMoreTracks && !loadingMore && !loadError,
  })

  // Очередь плеера — это то, что успела загрузить страница, а грузит она
  // постранично. Без пейджера воспроизведение вставало на последнем
  // загруженном треке: для плеера это выглядело как конец плейлиста. Пейджер
  // говорит плееру, откуда дотянуть хвост самому, не дожидаясь прокрутки.
  const queuePager = () => ({ url: `/playlists/${id}`, total: totalTracks })

  const handlePlay = () => {
    if (playlist.tracks && playlist.tracks.length > 0) {
      playPlaylist(playlist.tracks, 0, null, queuePager())
    }
  }

  const handleShuffle = async () => {
    if (shuffling || !playlist.tracks || playlist.tracks.length === 0) return
    setShuffling(true)
    try {
      await shufflePlaylist(playlist.tracks, null, queuePager())
    } finally {
      setShuffling(false)
    }
  }

  const handlePlayTrack = (track, index) => {
    playPlaylist(playlist.tracks, index, null, queuePager())
  }

  const handleToggleLike = async (track, e) => {
    e.stopPropagation()
    try {
      await toggleTrackLike(track.id)
    } catch (error) {
      console.error('Error toggling like:', error)
      toast.error('Не удалось обновить понравившиеся')
    }
  }

  // Свежие обработчики для мемоизированных строк (см. TrackTableRow):
  // ref стабилен, поэтому пересоздание функций на рендере строки не задевает.
  const rowActions = useRef(null)
  rowActions.current = {
    play: handlePlayTrack,
    toggleLike: handleToggleLike,
  }
  const likedSet = useMemo(() => new Set(likedTrackIds), [likedTrackIds])

  if (loading) {
    return (
      <Spinner page />
    )
  }

  if (!playlist) {
    return null
  }

  // Цвета нужны и шапке, и фону страницы (.hero-page::before, Artist.css): у
  // шапки в CSS свои дефолты, унаследованные она бы перекрыла.
  const heroStyle = {
    '--hero-c1': heroColors[0],
    '--hero-c2': heroColors[1],
    '--hero-c3': heroColors[2],
  }

  return (
    <div className="page-container hero-page" style={heroStyle}>
      <header className="artist-hero" style={heroStyle}>
        {/* Размытая обложка — фактура под градиентом, как у исполнителя. */}
        {playlist.cover_url && (
          <img
            src={resolveCoverUrl(playlist.cover_url, 'thumb') || resolveCoverUrl(playlist.cover_url)}
            alt=""
            aria-hidden="true"
            decoding="async"
            className="artist-hero-backdrop"
            onError={(e) => {
              e.currentTarget.style.display = 'none'
            }}
          />
        )}
        <div className="artist-hero-content">
          <img
            src={resolveCoverUrl(playlist.cover_url) || defaultCover}
            alt={playlist.name}
            decoding="async"
            className="artist-avatar playlist-hero-cover"
            onError={handleCoverError}
          />
          <div className="artist-hero-info">
            <div className="artist-kicker">Плейлист</div>
            <h1 className="artist-name" style={titleFitStyle(playlist.name)}>{playlist.name}</h1>
            {playlist.description && (
              <p className="playlist-hero-description">{playlist.description}</p>
            )}
            <ul className="artist-stats">
              <li>{playlist.owner?.username || 'Пользователь'}</li>
              {totalTracks > 0 && <li>{totalTracks} треков</li>}
            </ul>
          </div>
        </div>
      </header>

      <div className="artist-toolbar">
        <div className="playlist-actions round-actions">
          <button
            className="btn btn--primary btn--lg play-button-large round-actions__play"
            onClick={handlePlay}
            aria-label="Воспроизвести"
          >
            <Play size={24} fill="currentColor" />
            <span className="round-actions__label">Воспроизвести</span>
          </button>
          <button
            className="btn btn--secondary btn--lg play-button-large round-actions__icon round-actions__near-play"
            onClick={handleShuffle}
            disabled={shuffling}
            title="Перемешать и воспроизвести"
            aria-label="Перемешать"
          >
            <Shuffle size={20} />
            <span className="round-actions__label">{shuffling ? 'Загрузка…' : 'Перемешать'}</span>
          </button>
          <button
            className="btn btn--secondary btn--lg play-button-large round-actions__icon"
            onClick={() =>
              shareLink({
                title: playlist.name,
                text: playlist.name,
                url: `${window.location.origin}/playlists/${playlist.id}`,
              })
            }
            aria-label="Поделиться"
            title="Поделиться"
          >
            <Share size={20} />
            <span className="round-actions__label">Поделиться</span>
          </button>
        </div>
      </div>

      <div className="playlist-tracks hero-page-sheet">
        {playlist.tracks && playlist.tracks.length > 0 ? (
          <table className="tracks-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Название</th>
                <th>Альбом</th>
                <th>Длительность</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {playlist.tracks.map((track, index) => {
                const isCurrent = currentTrackId === track.id
                const isLiked = likedSet.has(track.id)
                return (
                  <TrackTableRow
                    key={track.id}
                    track={track}
                    index={index}
                    isCurrent={isCurrent}
                    isPlaying={isCurrent && isPlaying}
                    isLiked={isLiked}
                    excludePlaylistId={id}
                    actionsRef={rowActions}
                  />
                )
              })}
            </tbody>
          </table>
        ) : (
          <div className="empty-playlist">
            <p>В этом плейлисте пока нет треков</p>
          </div>
        )}
        {hasMoreTracks && (
          <div className="load-more-wrapper" ref={loadMoreRef}>
            {loadError ? (
              <button
                type="button"
                className="btn btn--secondary load-more-btn"
                onClick={handleLoadMore}
                disabled={loadingMore}
              >
                {loadingMore ? 'Загрузка…' : 'Показать ещё'}
              </button>
            ) : (
              <Spinner label="Загрузка треков…" />
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default PlaylistDetail
