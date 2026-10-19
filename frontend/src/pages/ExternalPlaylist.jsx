import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { usePlayerStore, trackLikeKey } from '../store/playerStore'
import { Play, Plus } from 'lucide-react'
import api from '../services/api'
import { peekCache, writeCache, patchCache, cacheAge } from '../services/pageCache'
import Spinner from '../components/Spinner'
import TrackTableRow from '../components/TrackTableRow'
import { useLazyBatch } from '../hooks/useLazyBatch'
import { toast } from '../store/toastStore'
import defaultCover from '../assets/default-cover.webp'
import { handleCoverError, resolveCoverUrl } from '../utils/media'
import { titleFitStyle } from '../utils/titleFit'
import { useCoverColors } from '../hooks/useCoverColors'
import { DEFAULT_HERO_COLORS } from '../utils/coverColor'
import './PlaylistDetail.css'
// Шапка — та же hero-карточка в тон обложки, что у исполнителя.
import './Artist.css'

// Просмотр внешнего (SoundCloud) плейлиста: слушать можно сразу, в библиотеку
// добавляется только по явному нажатию «Добавить в медиатеку».
const EXTERNAL_FRESH_MS = 10 * 60 * 1000

function ExternalPlaylist() {
  const { id } = useParams()
  const navigate = useNavigate()
  // Внешний плейлист меняется редко, а грузится через SoundCloud (секунды):
  // из кэша страница рисуется сразу, без спиннера.
  const cacheKey = `external-playlist:${id}`
  const [playlist, setPlaylist] = useState(() => peekCache(cacheKey)?.playlist ?? null)
  const [tracks, setTracks] = useState(() => peekCache(cacheKey)?.tracks ?? [])
  const [loading, setLoading] = useState(() => !peekCache(cacheKey))
  const [importing, setImporting] = useState(false)
  const heroColors = useCoverColors(playlist?.cover_url) || DEFAULT_HERO_COLORS
  // Атомарные селекторы вместо подписки на весь store: страница со списком
  // треков больше не перерисовывается на каждом тике currentTime (~4/сек).
  const playPlaylist = usePlayerStore((s) => s.playPlaylist)
  // Только id: страница отмечает текущую строку, а подписка на весь объект
  // перерисовывала её и тогда, когда трек тот же, а объект новый.
  const currentTrackId = usePlayerStore((s) => s.currentTrack?.id)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const likedTrackIds = usePlayerStore((s) => s.likedTrackIds)
  const pendingLikeKeys = usePlayerStore((s) => s.pendingLikeKeys)
  const toggleLikeForTrack = usePlayerStore((s) => s.toggleLikeForTrack)
  const fetchLikedTracks = usePlayerStore((s) => s.fetchLikedTracks)
  const materializeTrack = usePlayerStore((s) => s.materializeTrack)

  // Внешний плейлист приходит целиком, одним ответом — постранично его тянуть
  // неоткуда. Зато рисовать сразу все строки незачем: у каждой своя обложка,
  // и на плейлисте в пару сотен треков это залп запросов за картинками,
  // которых никто не увидит. Рисуем партиями по мере прокрутки. Сброс по id
  // плейлиста, а не по списку: материализация внешнего трека правит список на
  // месте, и лишний раз схлопывать отрисованное не нужно.
  const { visibleItems: visibleTracks, sentinelRef: tracksSentinelRef } = useLazyBatch(tracks, {
    batchSize: 30,
    resetKey: id,
  })

  useEffect(() => {
    fetchPlaylist()
    fetchLikedTracks()
  }, [id])

  // Материализация трека (db_id) правит список на месте — кэш следует за ним.
  useEffect(() => {
    if (!loading) patchCache(cacheKey, { tracks })
  }, [tracks, loading])

  const fetchPlaylist = async () => {
    const cached = peekCache(cacheKey)
    if (cached) {
      setPlaylist(cached.playlist)
      setTracks(cached.tracks)
      setLoading(false)
      usePlayerStore.getState().prefetchTracks(cached.tracks, 8)
      if (cacheAge(cacheKey) < EXTERNAL_FRESH_MS) return
    } else {
      setLoading(true)
    }
    try {
      const response = await api.get(`/soundcloud/playlists/${id}`)
      writeCache(cacheKey, { playlist: response.data.playlist, tracks: response.data.tracks })
      setPlaylist(response.data.playlist)
      setTracks(response.data.tracks)
      // Прогреваем резолв первых треков — старт воспроизведения без паузы.
      if (!cached) usePlayerStore.getState().prefetchTracks(response.data.tracks, 8)
    } catch (error) {
      console.error('Error fetching external playlist:', error)
      if (!cached) {
        toast.error('Не удалось загрузить плейлист')
        navigate('/search')
      }
    } finally {
      setLoading(false)
    }
  }

  const handlePlay = () => {
    if (tracks.length > 0) {
      playPlaylist(tracks, 0, 'external')
    }
  }

  const handlePlayTrack = (track, index) => {
    playPlaylist(tracks, index, 'external')
  }

  const handleImport = async () => {
    if (importing || !playlist) return
    setImporting(true)
    try {
      // Без таймаута: большой плейлист импортируется дольше глобальных 60 с.
      const { data } = await api.post(
        '/import',
        { url: playlist.permalink_url },
        { timeout: 0 },
      )
      toast.success(`Плейлист «${data.playlist.name}» добавлен в медиатеку`)
      navigate(`/playlists/${data.playlist.id}`)
    } catch (error) {
      console.error('Playlist import error:', error)
      toast.error('Не удалось добавить плейлист в медиатеку')
    } finally {
      setImporting(false)
    }
  }

  // Материализует внешний трек в БД и запоминает db_id в списке, чтобы
  // индикация лайка работала после действия.
  const ensureDbId = async (track) => {
    if (typeof track.db_id === 'number') return track.db_id
    const dbId = await materializeTrack(track)
    setTracks((prev) => prev.map((t) => (t.id === track.id ? { ...t, db_id: dbId } : t)))
    return dbId
  }

  const handleToggleLike = async (track, e) => {
    e.stopPropagation()
    try {
      // Сердечко зальётся сразу (pendingLikeKeys в сторе), материализация
      // внешнего трека и сам лайк летят в фоне.
      await toggleLikeForTrack(track, (id) => {
        setTracks((prev) => prev.map((t) => (t.id === track.id ? { ...t, db_id: id } : t)))
      })
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
    resolveId: ensureDbId,
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
            alt={playlist.title}
            decoding="async"
            className="artist-avatar playlist-hero-cover"
            onError={handleCoverError}
          />
          <div className="artist-hero-info">
            <div className="artist-kicker">Плейлист · SoundCloud</div>
            <h1 className="artist-name" style={titleFitStyle(playlist.title)}>{playlist.title}</h1>
            <ul className="artist-stats">
              <li>{playlist.owner || 'SoundCloud'}</li>
              {tracks.length > 0 && <li>{tracks.length} треков</li>}
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
            className="btn btn--secondary btn--lg play-button-large round-actions__icon"
            onClick={handleImport}
            disabled={importing}
            aria-label="Добавить в медиатеку"
          >
            <Plus size={20} />
            <span className="round-actions__label">{importing ? 'Добавление...' : 'Добавить в медиатеку'}</span>
          </button>
        </div>
      </div>

      <div className="playlist-tracks hero-page-sheet">
        {tracks.length > 0 ? (
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
              {visibleTracks.map((track, index) => {
                const isCurrent = currentTrackId === track.id
                const dbId = typeof track.db_id === 'number' ? track.db_id : null
                const isLiked =
                  (dbId ? likedSet.has(dbId) : false) ||
                  pendingLikeKeys.includes(trackLikeKey(track))
                return (
                  <TrackTableRow
                    key={track.id}
                    track={track}
                    index={index}
                    isCurrent={isCurrent}
                    isPlaying={isCurrent && isPlaying}
                    isLiked={isLiked}
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
        {/* Маячок догрузки — после таблицы: внутри <tbody> лежать может только
            строка, произвольный div туда браузер не пустит. */}
        <div ref={tracksSentinelRef} aria-hidden="true" />
      </div>
    </div>
  )
}

export default ExternalPlaylist
