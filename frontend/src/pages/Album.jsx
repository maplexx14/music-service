import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Play, Plus, Heart } from 'lucide-react'
import { usePlayerStore, trackIntentHandlers } from '../store/playerStore'
import api from '../services/api'
import Spinner from '../components/Spinner'
import ArtistLink from '../components/ArtistLink'
import { useLazyBatch } from '../hooks/useLazyBatch'
import { toast } from '../store/toastStore'
import defaultCover from '../assets/default-cover.webp'
import { handleCoverError, resolveCoverUrl } from '../utils/media'
import { formatDuration } from '../utils/format'
import './PlaylistDetail.css'

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
function Album() {
  const { source, id } = useParams()
  const navigate = useNavigate()
  const [album, setAlbum] = useState(null)
  const [tracks, setTracks] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [myPlaylists, setMyPlaylists] = useState([])
  const [menuTrackId, setMenuTrackId] = useState(null)
  // Атомарные селекторы вместо подписки на весь store: страница со списком
  // треков не должна перерисовываться на каждом тике currentTime (~4/сек).
  const playPlaylist = usePlayerStore((s) => s.playPlaylist)
  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const likedTrackIds = usePlayerStore((s) => s.likedTrackIds)
  const toggleTrackLike = usePlayerStore((s) => s.toggleTrackLike)
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

  useEffect(() => {
    if (menuTrackId === null) return
    const close = () => setMenuTrackId(null)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [menuTrackId])

  const fetchAlbum = async () => {
    setLoading(true)
    try {
      const { data } = await api.get(`/albums/${source}/${id}`)
      setAlbum(data.album)
      setTracks(data.tracks || [])
      // Прогреваем резолв верхушки — старт воспроизведения без паузы.
      usePlayerStore.getState().prefetchTracks(data.tracks || [], 6)
    } catch (error) {
      console.error('Error fetching album:', error)
      toast.error('Не удалось загрузить альбом')
      navigate(-1)
    } finally {
      setLoading(false)
    }
  }

  const handlePlay = () => {
    if (tracks.length > 0) playPlaylist(tracks, 0, 'album')
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
      await toggleTrackLike(await ensureDbId(track))
    } catch (error) {
      console.error('Error toggling like:', error)
      toast.error('Не удалось обновить понравившиеся')
    }
  }

  const handleOpenMenu = async (track, e) => {
    e.stopPropagation()
    if (menuTrackId === track.id) {
      setMenuTrackId(null)
      return
    }
    setMenuTrackId(track.id)
    if (myPlaylists.length === 0) {
      try {
        const { data } = await api.get('/playlists/me')
        setMyPlaylists(data)
      } catch (error) {
        console.error('Error fetching my playlists:', error)
      }
    }
  }

  const handleAddToPlaylist = async (track, target, e) => {
    e.stopPropagation()
    setMenuTrackId(null)
    try {
      const dbId = await ensureDbId(track)
      await api.post(`/playlists/${target.id}/tracks/${dbId}`, null, { skipErrorToast: true })
      toast.success(`Добавлено в «${target.name}»`)
    } catch (error) {
      if (error.response?.status === 400) {
        toast.error('Трек уже есть в этом плейлисте')
      } else {
        console.error('Error adding track to playlist:', error)
        toast.error('Не удалось добавить трек')
      }
    }
  }

  if (loading) {
    return (
      <div className="page-container">
        <Spinner />
      </div>
    )
  }

  if (!album) return null

  const typeLabel = TYPE_LABEL[(album.album_type || '').toLowerCase()] || album.album_type || 'Альбом'
  const sourceLabel = SOURCE_LABEL[album.source]

  return (
    <div className="page-container">
      <div className="playlist-header">
        <img
          src={resolveCoverUrl(album.cover_url) || defaultCover}
          alt={album.title}
          className="playlist-header-cover"
          onError={handleCoverError}
        />
        <div className="playlist-header-info">
          <div className="playlist-type">
            {typeLabel}
            {sourceLabel ? ` · ${sourceLabel}` : ''}
          </div>
          <h1 className="playlist-title">{album.title}</h1>
          <div className="playlist-meta">
            {album.artist && <ArtistLink artist={album.artist} />}
            {album.year && (
              <>
                <span>•</span>
                <span>{album.year}</span>
              </>
            )}
            {tracks.length > 0 && (
              <>
                <span>•</span>
                <span>{tracks.length} треков</span>
              </>
            )}
          </div>
          <div className="playlist-actions">
            <button
              className="play-button-large"
              onClick={handlePlay}
              disabled={tracks.length === 0}
            >
              <Play size={24} fill="currentColor" />
              Воспроизвести
            </button>
            <button
              className="play-button-large secondary"
              onClick={handleSaveToLibrary}
              disabled={saving || tracks.length === 0}
              title="Сохранить альбом плейлистом в медиатеку"
            >
              <Plus size={20} />
              {saving ? 'Добавление...' : 'Добавить в медиатеку'}
            </button>
          </div>
        </div>
      </div>

      <div className="playlist-tracks">
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
                const isCurrent = currentTrack?.id === track.id
                const dbId = typeof track.db_id === 'number' ? track.db_id : null
                const isLiked = dbId !== null && likedTrackIds.includes(dbId)
                return (
                  <tr
                    key={track.id}
                    className={`track-row${isCurrent ? ' playing' : ''}`}
                    onClick={() => handlePlayTrack(index)}
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
                        <div className="track-name">{track.title}</div>
                        <ArtistLink artist={track.artist} className="track-artist" />
                      </div>
                    </td>
                    <td className="track-duration">{formatDuration(track.duration)}</td>
                    <td className="track-actions-cell">
                      <button
                        type="button"
                        className={`track-action-btn${isLiked ? ' liked' : ''}`}
                        onClick={(e) => handleToggleLike(track, e)}
                        title={isLiked ? 'Убрать из понравившихся' : 'В понравившиеся'}
                        aria-label={isLiked ? 'Убрать из понравившихся' : 'В понравившиеся'}
                      >
                        <Heart size={18} fill={isLiked ? 'currentColor' : 'none'} />
                      </button>
                      <div className="add-to-playlist">
                        <button
                          type="button"
                          className="track-action-btn"
                          onClick={(e) => handleOpenMenu(track, e)}
                          title="Добавить в плейлист"
                          aria-label="Добавить в плейлист"
                        >
                          <Plus size={18} />
                        </button>
                        {menuTrackId === track.id && (
                          <div className="add-to-playlist-menu" onClick={(e) => e.stopPropagation()}>
                            {myPlaylists.length > 0 ? (
                              myPlaylists.map((p) => (
                                <button
                                  key={p.id}
                                  type="button"
                                  className="add-to-playlist-option"
                                  onClick={(e) => handleAddToPlaylist(track, p, e)}
                                >
                                  {p.name}
                                </button>
                              ))
                            ) : (
                              <div className="add-to-playlist-empty">Нет плейлистов</div>
                            )}
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
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
