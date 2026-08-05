import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Play, Plus, Heart } from 'lucide-react'
import { usePlayerStore, trackIntentHandlers } from '../store/playerStore'
import api from '../services/api'
import Spinner from '../components/Spinner'
import ArtistLink from '../components/ArtistLink'
import { toast } from '../store/toastStore'
import defaultCover from '../assets/default-cover.png'
import { resolveCoverUrl, handleCoverError } from '../utils/media'
import './PlaylistDetail.css'
import './Artist.css'

// Лейбл источника для внешних треков (у сохранённых в библиотеке его не
// показываем — там и так всё своё).
const SOURCE_LABEL = {
  ytmusic: 'YouTube Music',
  soundcloud: 'SoundCloud',
  soulseek: 'FLAC',
}

// Страница исполнителя: его треки одним плейлистом. Сначала то, что уже в
// библиотеке, затем каталог YouTube Music, затем SoundCloud — порядок задаёт
// бэк (см. routers/artists.py), фронт только склеивает списки в одну очередь.
function Artist() {
  const { name } = useParams()
  const navigate = useNavigate()
  const [artist, setArtist] = useState(null)
  const [tracks, setTracks] = useState([])
  const [loading, setLoading] = useState(true)
  const [liking, setLiking] = useState(false)
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

  useEffect(() => {
    fetchArtist()
    fetchLikedTracks()
  }, [name])

  useEffect(() => {
    if (menuTrackId === null) return
    const close = () => setMenuTrackId(null)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [menuTrackId])

  const fetchArtist = async () => {
    setLoading(true)
    try {
      const { data } = await api.get('/artists', { params: { name } })
      setArtist(data)
      // Библиотека и внешние источники — одна очередь: пользователь видит
      // «все треки исполнителя» и слушает их подряд, не думая об источнике.
      const all = [...(data.tracks || []), ...(data.external || [])]
      setTracks(all)
      // Прогреваем резолв верхушки — старт воспроизведения без паузы.
      usePlayerStore.getState().prefetchTracks(all, 6)
    } catch (error) {
      console.error('Error fetching artist:', error)
      toast.error('Не удалось загрузить страницу исполнителя')
      navigate(-1)
    } finally {
      setLoading(false)
    }
  }

  const handlePlay = () => {
    if (tracks.length > 0) playPlaylist(tracks, 0, 'artist')
  }

  // Лайк артиста пишется в явные предпочтения пользователя (те же, что в
  // онбординге) — оттуда его читают волна и рекомендации.
  const handleToggleArtistLike = async () => {
    if (liking) return
    setLiking(true)
    try {
      const { data } = await api.post('/artists/like', { name: artist.name })
      setArtist((prev) => ({ ...prev, is_liked: data.liked }))
      toast.success(
        data.liked
          ? `«${artist.name}» в понравившихся исполнителях`
          : `«${artist.name}» убран из понравившихся`,
      )
    } catch (error) {
      console.error('Error toggling artist like:', error)
      toast.error('Не удалось обновить понравившихся исполнителей')
    } finally {
      setLiking(false)
    }
  }

  // Сохранение плейлиста артиста в медиатеку: внешние треки при этом
  // материализуются в БД на бэке (см. routers/artists.py).
  const handleSaveToLibrary = async () => {
    if (saving) return
    if (artist.playlist_id) {
      navigate(`/playlists/${artist.playlist_id}`)
      return
    }
    setSaving(true)
    try {
      const { data } = await api.post('/artists/library', { name: artist.name })
      setArtist((prev) => ({ ...prev, playlist_id: data.playlist_id }))
      toast.success(
        data.created
          ? `Плейлист «${data.name}» добавлен в медиатеку (${data.total} треков)`
          : `В «${data.name}» добавлено треков: ${data.added}`,
      )
    } catch (error) {
      console.error('Error saving artist playlist:', error)
      toast.error('Не удалось добавить плейлист в медиатеку')
    } finally {
      setSaving(false)
    }
  }

  const handlePlayTrack = (index) => {
    playPlaylist(tracks, index, 'artist')
  }

  // Внешний трек нужно сначала материализовать в БД — только у записи с
  // числовым id есть лайк и добавление в плейлист. У треков из библиотеки id
  // уже числовой, и лишнего запроса не будет.
  const ensureDbId = async (track) => {
    if (typeof track.id === 'number') return track.id
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

  if (!artist) return null

  const libraryCount = artist.tracks?.length || 0

  return (
    <div className="page-container">
      <div className="playlist-header">
        <img
          src={resolveCoverUrl(artist.cover_url) || defaultCover}
          alt={artist.name}
          className="playlist-header-cover artist-header-cover"
          onError={handleCoverError}
        />
        <div className="playlist-header-info">
          <div className="playlist-type">Исполнитель</div>
          <h1 className="playlist-title">{artist.name}</h1>
          <div className="playlist-meta">
            <span>{tracks.length} треков</span>
            {libraryCount > 0 && (
              <>
                <span>•</span>
                <span>{libraryCount} в медиатеке</span>
              </>
            )}
          </div>
          <div className="playlist-actions">
            <button className="play-button-large" onClick={handlePlay} disabled={tracks.length === 0}>
              <Play size={24} fill="currentColor" />
              Воспроизвести
            </button>
            <button
              className="play-button-large secondary"
              onClick={handleSaveToLibrary}
              disabled={saving || tracks.length === 0}
              title={
                artist.playlist_id
                  ? 'Плейлист исполнителя уже в медиатеке — открыть'
                  : 'Сохранить все треки исполнителя плейлистом'
              }
            >
              <Plus size={20} />
              {saving
                ? 'Добавление...'
                : artist.playlist_id
                  ? 'Открыть в медиатеке'
                  : 'Добавить в медиатеку'}
            </button>
            <button
              type="button"
              className={`action-button${artist.is_liked ? ' liked' : ''}`}
              onClick={handleToggleArtistLike}
              disabled={liking}
              title={
                artist.is_liked
                  ? 'Убрать исполнителя из понравившихся'
                  : 'Добавить исполнителя в понравившиеся'
              }
              aria-label={
                artist.is_liked
                  ? 'Убрать исполнителя из понравившихся'
                  : 'Добавить исполнителя в понравившиеся'
              }
              aria-pressed={!!artist.is_liked}
            >
              <Heart size={20} fill={artist.is_liked ? 'currentColor' : 'none'} />
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
                <th>Альбом</th>
                <th>Длительность</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {tracks.map((track, index) => {
                const isCurrent = currentTrack?.id === track.id
                const dbId =
                  typeof track.id === 'number'
                    ? track.id
                    : typeof track.db_id === 'number'
                      ? track.db_id
                      : null
                const isLiked = dbId !== null && likedTrackIds.includes(dbId)
                const sourceLabel = SOURCE_LABEL[track.source]
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
                    <td className="track-album">
                      {track.album || (sourceLabel ? (
                        <span className="artist-track-source">{sourceLabel}</span>
                      ) : '-')}
                    </td>
                    <td className="track-duration">
                      {Math.floor(track.duration / 60)}:{(track.duration % 60).toString().padStart(2, '0')}
                    </td>
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
            <p>Треков этого исполнителя не нашлось</p>
          </div>
        )}
      </div>
    </div>
  )
}

export default Artist
