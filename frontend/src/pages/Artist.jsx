import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { Play, Plus, Heart } from 'lucide-react'
import { usePlayerStore, trackLikeKey } from '../store/playerStore'
import api from '../services/api'
import { peekCache, writeCache, patchCache, cacheAge, artistCacheKey } from '../services/pageCache'
import Spinner from '../components/Spinner'
import TrackTableRow from '../components/TrackTableRow'
import Carousel from '../components/Carousel'
import { useLazyBatch } from '../hooks/useLazyBatch'
import { toast } from '../store/toastStore'
import defaultCover from '../assets/default-cover.webp'
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

// Тип релиза от провайдера — по-русски, для подписи под обложкой.
const ALBUM_TYPE_LABEL = {
  album: 'Альбом',
  single: 'Сингл',
  ep: 'EP',
}

const albumTypeLabel = (album) =>
  ALBUM_TYPE_LABEL[(album.album_type || '').toLowerCase()] || album.album_type || null

// Карусель релизов: карточка та же по смыслу, что у плейлистов на главной, но
// со своими классами — на страницу артиста заходят по прямой ссылке, и CSS
// главной в этот момент не загружен (страницы грузятся lazy).
function AlbumsRow({ title, albums }) {
  if (albums.length === 0) return null

  return (
    <div className="artist-albums">
      <h2 className="artist-section-title">{title}</h2>
      <Carousel
        items={albums}
        label={title}
        renderItem={(album) => {
          const meta = [album.year, albumTypeLabel(album)].filter(Boolean).join(' · ')
          return (
            <Link
              key={album.id}
              className="album-card"
              to={`/albums/${album.source}/${album.external_id}`}
            >
              <img
                src={resolveCoverUrl(album.cover_url) || defaultCover}
                alt={album.title}
                className="album-cover"
                loading="lazy"
                decoding="async"
                onError={handleCoverError}
              />
              <div className="album-name">{album.title}</div>
              {meta && <div className="album-meta">{meta}</div>}
            </Link>
          )
        }}
      />
    </div>
  )
}

// Страница собирается из внешних источников (секунды на холодную), поэтому
// кэш свежее этого возраста считаем достаточным и сеть не трогаем вовсе.
const ARTIST_FRESH_MS = 5 * 60 * 1000

// Страница исполнителя: его треки одним плейлистом. Сначала то, что уже в
// библиотеке, затем каталог YouTube Music, затем SoundCloud — порядок задаёт
// бэк (см. routers/artists.py), фронт только склеивает списки в одну очередь.
// Библиотека и внешние источники — одна очередь: пользователь видит «все
// треки исполнителя» и слушает их подряд, не думая об источнике.
const artistTracks = (data) => (data ? [...(data.tracks || []), ...(data.external || [])] : [])

function Artist() {
  const { name } = useParams()
  const navigate = useNavigate()
  // Из кэша (прошлый заход или прогрев по наведению на имя) страница
  // рисуется сразу, без спиннера.
  const [artist, setArtist] = useState(() => peekCache(artistCacheKey(name)) ?? null)
  const [tracks, setTracks] = useState(() => artistTracks(peekCache(artistCacheKey(name))))
  const [albums, setAlbums] = useState(() => peekCache(artistCacheKey(name))?.albums ?? [])
  const [loading, setLoading] = useState(() => !peekCache(artistCacheKey(name)))
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
  const pendingLikeKeys = usePlayerStore((s) => s.pendingLikeKeys)
  const toggleLikeForTrack = usePlayerStore((s) => s.toggleLikeForTrack)
  const fetchLikedTracks = usePlayerStore((s) => s.fetchLikedTracks)
  const materializeTrack = usePlayerStore((s) => s.materializeTrack)

  // Каталог исполнителя (библиотека + оба внешних источника) приходит одним
  // ответом и легко переваливает за сотню строк — рисуем партиями по мере
  // прокрутки, чтобы не тянуть сразу все обложки. Сброс по имени, а не по
  // списку: материализация внешнего трека правит список на месте, и лишний раз
  // схлопывать отрисованное не нужно.
  const { visibleItems: visibleTracks, sentinelRef: tracksSentinelRef } = useLazyBatch(tracks, {
    batchSize: 30,
    resetKey: name,
  })

  useEffect(() => {
    fetchArtist()
    fetchLikedTracks()
  }, [name])

  // Лайк и сохранение в медиатеку правят шапку на месте — кэш следует за
  // ними, иначе возврат на страницу показал бы прошлое состояние кнопок.
  useEffect(() => {
    if (!artist) return
    patchCache(artistCacheKey(name), {
      is_liked: artist.is_liked,
      playlist_id: artist.playlist_id,
    })
  }, [artist?.is_liked, artist?.playlist_id])

  useEffect(() => {
    if (menuTrackId === null) return
    const close = () => setMenuTrackId(null)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [menuTrackId])

  const applyArtist = (data) => {
    setArtist(data)
    const all = artistTracks(data)
    setTracks(all)
    setAlbums(data.albums || [])
    // Прогреваем резолв верхушки — старт воспроизведения без паузы. Немного:
    // каждый ytmusic-прогрев — резолв в YouTube (лимит на IP, bot-check).
    usePlayerStore.getState().prefetchTracks(all, 2)
  }

  const fetchArtist = async () => {
    const key = artistCacheKey(name)
    const cached = peekCache(key)
    if (cached) {
      applyArtist(cached)
      setLoading(false)
      if (cacheAge(key) < ARTIST_FRESH_MS) return
    } else {
      setLoading(true)
    }
    try {
      const { data } = await api.get('/artists', { params: { name } })
      writeCache(key, data)
      applyArtist(data)
    } catch (error) {
      console.error('Error fetching artist:', error)
      // Фоновое обновление упало — на экране остаётся кэш, уходить некуда.
      if (!cached) {
        toast.error('Не удалось загрузить страницу исполнителя')
        navigate(-1)
      }
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
    // Оптимистично: сердечко переключается сразу, сеть подтверждает в фоне.
    const nextLiked = !artist.is_liked
    setArtist((prev) => ({ ...prev, is_liked: nextLiked }))
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
      // Откат оптимистичного состояния.
      setArtist((prev) => ({ ...prev, is_liked: !nextLiked }))
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

  // Свежие обработчики для мемоизированных строк (см. TrackTableRow):
  // ref стабилен, поэтому пересоздание функций на рендере строки не задевает.
  const rowActions = useRef(null)
  rowActions.current = {
    play: (track, index) => handlePlayTrack(index),
    toggleLike: handleToggleLike,
    openMenu: handleOpenMenu,
    addToPlaylist: handleAddToPlaylist,
  }
  const likedSet = useMemo(() => new Set(likedTrackIds), [likedTrackIds])

  if (loading) {
    return (
      <div className="page-container">
        <Spinner />
      </div>
    )
  }

  if (!artist) return null

  const libraryCount = artist.tracks?.length || 0
  // Альбомы и всё остальное (синглы, EP) — двумя каруселями: в одной ленте
  // сингл выглядит таким же релизом, как двойной альбом.
  const fullAlbums = albums.filter((a) => (a.album_type || '').toLowerCase() === 'album')
  const shortReleases = albums.filter((a) => (a.album_type || '').toLowerCase() !== 'album')

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
          <div className="playlist-actions artist-actions">
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

      <AlbumsRow title="Альбомы" albums={fullAlbums} />
      <AlbumsRow title="Синглы и Альбомы" albums={shortReleases} />

      <div className="playlist-tracks">
        {/* Заголовок нужен только когда выше есть карусели: иначе таблица и так
            единственный блок страницы, и подписывать её нечем. */}
        {albums.length > 0 && <h2 className="artist-section-title">Треки</h2>}
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
                const isCurrent = currentTrack?.id === track.id
                const dbId =
                  typeof track.id === 'number'
                    ? track.id
                    : typeof track.db_id === 'number'
                      ? track.db_id
                      : null
                const isLiked =
                  (dbId !== null && likedSet.has(dbId)) ||
                  pendingLikeKeys.includes(trackLikeKey(track))
                const menuOpen = menuTrackId === track.id
                return (
                  <TrackTableRow
                    key={track.id}
                    track={track}
                    index={index}
                    isCurrent={isCurrent}
                    isPlaying={isCurrent && isPlaying}
                    isLiked={isLiked}
                    menuOpen={menuOpen}
                    menuPlaylists={menuOpen ? myPlaylists : null}
                    sourceLabel={SOURCE_LABEL[track.source]}
                    showBadges
                    showInlineMeta
                    actionsRef={rowActions}
                  />
                )
              })}
            </tbody>
          </table>
        ) : (
          <div className="empty-playlist">
            <p>Треков этого исполнителя не нашлось</p>
          </div>
        )}
        {/* Маячок догрузки — после таблицы: внутри <tbody> лежать может только
            строка, произвольный div туда браузер не пустит. */}
        <div ref={tracksSentinelRef} aria-hidden="true" />
      </div>
    </div>
  )
}

export default Artist
