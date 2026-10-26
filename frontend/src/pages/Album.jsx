import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Play, Plus, Shuffle } from 'lucide-react'
import { usePlayerStore, trackLikeKey } from '../store/playerStore'
import api from '../services/api'
import { peekCache, writeCache, patchCache, cacheAge } from '../services/pageCache'
import Spinner from '../components/Spinner'
import ArtistLink from '../components/ArtistLink'
import TrackTableRow from '../components/TrackTableRow'
import { useLazyBatch } from '../hooks/useLazyBatch'
import { toast } from '../store/toastStore'
import defaultCover from '../assets/default-cover.webp'
import { handleCoverError, resolveCoverUrl } from '../utils/media'
import { titleFitStyle } from '../utils/titleFit'
import CoverBackdrop, { useCoverBackdrop } from '../components/CoverBackdrop'
import './PlaylistDetail.css'
// Шапка и фон в тон обложки (CoverBackdrop) — как у исполнителя.
import './Artist.css'

// Тип релиза от провайдера — по-русски. Незнакомый оставляем как пришёл: это
// лучше, чем звать сингл альбомом.
const TYPE_LABEL = {
  album: 'Альбом',
  single: 'Сингл',
  ep: 'EP',
}

const SOURCE_LABEL = {
  ytmusic: 'YouTube Music',
  soundcloud: 'SoundCloud',
}

// Страница альбома: релиз внешнего источника как плейлист. Открывается из
// карусели на странице исполнителя. Слушать можно сразу, в медиатеку альбом
// попадает только по явному «Добавить в медиатеку» (см. routers/albums.py).
// Релиз внешнего источника не меняется: кэш этого возраста не перепроверяем.
const ALBUM_FRESH_MS = 10 * 60 * 1000

function Album() {
  const { source, id } = useParams()
  const navigate = useNavigate()
  // Из кэша (прошлый заход) страница рисуется сразу, без спиннера.
  const cacheKey = `album:${source}:${id}`
  const [album, setAlbum] = useState(() => peekCache(cacheKey)?.album ?? null)
  const [tracks, setTracks] = useState(() => peekCache(cacheKey)?.tracks ?? [])
  const [loading, setLoading] = useState(() => !peekCache(cacheKey))
  const [saving, setSaving] = useState(false)
  const [shuffling, setShuffling] = useState(false)
  const backdrop = useCoverBackdrop(album?.cover_url)
  // Атомарные селекторы вместо подписки на весь store: страница со списком
  // треков не должна перерисовываться на каждом тике currentTime (~4/сек).
  const playPlaylist = usePlayerStore((s) => s.playPlaylist)
  const shufflePlaylist = usePlayerStore((s) => s.shufflePlaylist)
  // Только id: страница отмечает текущую строку, а подписка на весь объект
  // перерисовывала её и тогда, когда трек тот же, а объект новый.
  const currentTrackId = usePlayerStore((s) => s.currentTrack?.id)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const likedTrackIds = usePlayerStore((s) => s.likedTrackIds)
  const pendingLikeKeys = usePlayerStore((s) => s.pendingLikeKeys)
  const toggleLikeForTrack = usePlayerStore((s) => s.toggleLikeForTrack)
  const fetchLikedTracks = usePlayerStore((s) => s.fetchLikedTracks)
  const materializeTrack = usePlayerStore((s) => s.materializeTrack)

  // Альбом короткий, но правило то же, что у плейлиста: рисуем партиями, а не
  // залпом запросов за обложками. Сброс по id, а не по списку — материализация
  // трека правит список на месте.
  const { visibleItems: visibleTracks, sentinelRef: tracksSentinelRef } = useLazyBatch(tracks, {
    batchSize: 30,
    resetKey: id,
  })

  useEffect(() => {
    fetchAlbum()
    fetchLikedTracks()
  }, [source, id])

  // Материализация трека (db_id) правит список на месте — кэш следует за ним.
  useEffect(() => {
    if (!loading) patchCache(cacheKey, { tracks })
  }, [tracks, loading])

  const fetchAlbum = async () => {
    const cached = peekCache(cacheKey)
    if (cached) {
      setAlbum(cached.album)
      setTracks(cached.tracks)
      setLoading(false)
      usePlayerStore.getState().prefetchTracks(cached.tracks, 6)
      if (cacheAge(cacheKey) < ALBUM_FRESH_MS) return
    } else {
      setLoading(true)
    }
    try {
      const { data } = await api.get(`/albums/${source}/${id}`)
      writeCache(cacheKey, { album: data.album, tracks: data.tracks || [] })
      setAlbum(data.album)
      setTracks(data.tracks || [])
      // Прогреваем резолв верхушки — старт воспроизведения без паузы.
      if (!cached) usePlayerStore.getState().prefetchTracks(data.tracks || [], 6)
    } catch (error) {
      console.error('Error fetching album:', error)
      if (!cached) {
        toast.error('Не удалось загрузить альбом')
        navigate(-1)
      }
    } finally {
      setLoading(false)
    }
  }

  const handlePlay = () => {
    if (tracks.length > 0) playPlaylist(tracks, 0, 'album')
  }

  const handleShuffle = async () => {
    if (shuffling || tracks.length === 0) return
    setShuffling(true)
    try {
      await shufflePlaylist(tracks, 'album')
    } finally {
      setShuffling(false)
    }
  }

  const handlePlayTrack = (index) => {
    playPlaylist(tracks, index, 'album')
  }

  // Альбом в медиатеку: треки материализуются в БД на бэке, поэтому одним
  // запросом, а не построчно с фронта (см. routers/albums.py).
  const handleSaveToLibrary = async () => {
    if (saving || !album) return
    setSaving(true)
    try {
      const { data } = await api.post('/albums/library', {
        source: album.source,
        external_id: album.external_id,
      })
      toast.success(
        data.created
          ? `Альбом «${data.name}» добавлен в медиатеку (${data.total} треков)`
          : `В «${data.name}» добавлено треков: ${data.added}`,
      )
      navigate(`/playlists/${data.playlist_id}`)
    } catch (error) {
      console.error('Error saving album:', error)
      toast.error('Не удалось добавить альбом в медиатеку')
    } finally {
      setSaving(false)
    }
  }

  // Внешний трек нужно сначала материализовать в БД — только у записи с
  // числовым id есть лайк и добавление в плейлист.
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
    play: (track, index) => handlePlayTrack(index),
    toggleLike: handleToggleLike,
    resolveId: ensureDbId,
  }
  const likedSet = useMemo(() => new Set(likedTrackIds), [likedTrackIds])

  if (loading) {
    return (
      <Spinner page />
    )
  }

  if (!album) return null

  const typeLabel = TYPE_LABEL[(album.album_type || '').toLowerCase()] || album.album_type || 'Альбом'
  const sourceLabel = SOURCE_LABEL[album.source]

  return (
    <div className={`page-container hero-page${backdrop.hero ? ' has-cover-hero' : ''}`}>
      <CoverBackdrop {...backdrop} />
      <header className="artist-hero">
        <div className="artist-hero-content">
          <img
            src={resolveCoverUrl(album.cover_url) || defaultCover}
            alt={album.title}
            decoding="async"
            className="artist-avatar playlist-hero-cover"
            onError={handleCoverError}
          />
          <div className="artist-hero-info">
            <div className="artist-kicker">
              {typeLabel}
              {sourceLabel ? ` · ${sourceLabel}` : ''}
            </div>
            <h1 className="artist-name" style={titleFitStyle(album.title)}>{album.title}</h1>
            <ul className="artist-stats">
              {album.artist && (
                <li>
                  <ArtistLink artist={album.artist} />
                </li>
              )}
              {album.year && <li>{album.year}</li>}
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
            disabled={tracks.length === 0}
            aria-label="Воспроизвести"
          >
            <Play size={24} fill="currentColor" />
            <span className="round-actions__label">Воспроизвести</span>
          </button>
          <button
            className="btn btn--secondary btn--lg play-button-large round-actions__icon round-actions__near-play"
            onClick={handleShuffle}
            disabled={shuffling || tracks.length === 0}
            title="Перемешать и воспроизвести"
            aria-label="Перемешать"
          >
            <Shuffle size={20} />
            <span className="round-actions__label">{shuffling ? 'Загрузка…' : 'Перемешать'}</span>
          </button>
          <button
            className="btn btn--secondary btn--lg playlist-action-icon round-actions__icon"
            onClick={handleSaveToLibrary}
            disabled={saving || tracks.length === 0}
            title="Добавить в медиатеку"
            aria-label="Добавить в медиатеку"
          >
            <Plus size={20} />
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
                <th>Длительность</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visibleTracks.map((track, index) => {
                const isCurrent = currentTrackId === track.id
                const dbId = typeof track.db_id === 'number' ? track.db_id : null
                const isLiked =
                  (dbId !== null && likedSet.has(dbId)) ||
                  pendingLikeKeys.includes(trackLikeKey(track))
                return (
                  <TrackTableRow
                    key={track.id}
                    track={track}
                    index={index}
                    isCurrent={isCurrent}
                    isPlaying={isCurrent && isPlaying}
                    isLiked={isLiked}
                    showAlbum={false}
                    actionsRef={rowActions}
                  />
                )
              })}
            </tbody>
          </table>
        ) : (
          <div className="empty-playlist">
            <p>В этом альбоме нет треков</p>
          </div>
        )}
        {/* Маячок догрузки — после таблицы: внутри <tbody> лежать может только
            строка, произвольный div туда браузер не пустит. */}
        <div ref={tracksSentinelRef} aria-hidden="true" />
      </div>
    </div>
  )
}

export default Album
