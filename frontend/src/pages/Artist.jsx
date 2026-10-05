import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { Play, Pause, ListPlus, ListChecks } from 'lucide-react'
import LikeHeart from '../components/LikeHeart'
import { usePlayerStore, trackLikeKey } from '../store/playerStore'
import api from '../services/api'
import { peekCache, writeCache, patchCache, cacheAge, artistCacheKey } from '../services/pageCache'
import Spinner from '../components/Spinner'
import TrackTableRow from '../components/TrackTableRow'
import Carousel from '../components/Carousel'
import { useLazyBatch } from '../hooks/useLazyBatch'
import { toast } from '../store/toastStore'
import { haptic, HAPTIC } from '../utils/haptics'
import { plural } from '../utils/format'
import defaultCover from '../assets/default-cover.webp'
import { resolveCoverUrl, handleCoverError } from '../utils/media'
import { useCoverColors } from '../hooks/useCoverColors'
import { DEFAULT_HERO_COLORS } from '../utils/coverColor'
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
    <section className="artist-albums">
      <SectionTitle count={albums.length}>{title}</SectionTitle>
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
    </section>
  )
}

function SectionTitle({ count, children }) {
  return (
    <h2 className="artist-section-title">
      {children}
      {count > 0 && <span className="artist-section-count">{count}</span>}
    </h2>
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
  // Атомарные селекторы вместо подписки на весь store: страница со списком
  // треков не должна перерисовываться на каждом тике currentTime (~4/сек).
  const playPlaylist = usePlayerStore((s) => s.playPlaylist)
  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const queueSource = usePlayerStore((s) => s.source)
  const togglePlayPause = usePlayerStore((s) => s.togglePlayPause)
  const likedTrackIds = usePlayerStore((s) => s.likedTrackIds)
  const pendingLikeKeys = usePlayerStore((s) => s.pendingLikeKeys)
  const toggleLikeForTrack = usePlayerStore((s) => s.toggleLikeForTrack)
  const fetchLikedTracks = usePlayerStore((s) => s.fetchLikedTracks)
  const materializeTrack = usePlayerStore((s) => s.materializeTrack)
  // Шапка красится в тон аватара — как hero на главной по обложке трека. До
  // разбора (и без аватара) — фирменная палитра, чтобы не мигать серым.
  const heroColors = useCoverColors(artist?.cover_url) || DEFAULT_HERO_COLORS
  // Имя в шапке ушло под верхнюю панель — на мобильном показываем компактную
  // полосу с именем и кнопкой воспроизведения (см. .artist-compact-bar).
  // Элемент в state, а не в ref: имя появляется только после загрузки, и
  // наблюдатель должен подписаться именно тогда.
  const [nameEl, setNameEl] = useState(null)
  const [nameHidden, setNameHidden] = useState(false)

  useEffect(() => {
    if (!nameEl || typeof IntersectionObserver === 'undefined') return undefined
    // Отступ сверху ≈ высота мобильной верхней панели (Layout.css, 52px +
    // safe-area). Считаем имя скрытым, только когда оно ушло ВВЕРХ — ниже
    // экрана оно не бывает, но на всякий случай не путаем стороны.
    const observer = new IntersectionObserver(
      ([entry]) => {
        const above = entry.rootBounds
          ? entry.boundingClientRect.bottom < entry.rootBounds.top
          : false
        setNameHidden(!entry.isIntersecting && above)
      },
      { rootMargin: '-64px 0px 0px 0px' },
    )
    observer.observe(nameEl)
    return () => observer.disconnect()
  }, [nameEl])

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

  // Очередь уже из треков этого исполнителя — кнопка становится паузой, а не
  // перезапуском с первого трека (на телефоне это главная кнопка страницы).
  const isArtistCurrent =
    queueSource === 'artist' && !!currentTrack && tracks.some((t) => t.id === currentTrack.id)
  const isArtistPlaying = isArtistCurrent && isPlaying

  const handlePlayToggle = () => {
    haptic(HAPTIC.selection)
    if (isArtistCurrent) togglePlayPause()
    else handlePlay()
  }

  // Лайк артиста пишется в явные предпочтения пользователя (те же, что в
  // онбординге) — оттуда его читают волна и рекомендации.
  const handleToggleArtistLike = async () => {
    if (liking) return
    haptic(HAPTIC.selection)
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

  if (!artist) return null

  const libraryCount = artist.tracks?.length || 0
  // Альбомы и всё остальное (синглы, EP) — двумя каруселями: в одной ленте
  // сингл выглядит таким же релизом, как двойной альбом.
  const fullAlbums = albums.filter((a) => (a.album_type || '').toLowerCase() === 'album')
  const shortReleases = albums.filter((a) => (a.album_type || '').toLowerCase() !== 'album')
  const playLabel = isArtistPlaying ? 'Пауза' : 'Воспроизвести'
  const saveLabel = saving
    ? 'Добавление...'
    : artist.playlist_id
      ? 'Открыть в медиатеке'
      : 'Добавить в медиатеку'

  return (
    <div className="page-container">
      <header
        className="artist-hero"
        style={{
          '--hero-c1': heroColors[0],
          '--hero-c2': heroColors[1],
          '--hero-c3': heroColors[2],
        }}
      >
        {/* Размытый аватар — фактура под градиентом: сплошная заливка тоном
            смотрится плоско. Декоративный, поэтому alt пустой. */}
        {artist.cover_url && (
          <img
            src={resolveCoverUrl(artist.cover_url)}
            alt=""
            aria-hidden="true"
            className="artist-hero-backdrop"
            onError={(e) => {
              e.currentTarget.style.display = 'none'
            }}
          />
        )}
        <div className="artist-hero-content">
          <img
            src={resolveCoverUrl(artist.cover_url) || defaultCover}
            alt={artist.name}
            className="artist-avatar"
            onError={handleCoverError}
          />
          <div className="artist-hero-info">
            <div className="artist-kicker">Исполнитель</div>
            <h1 className="artist-name" ref={setNameEl}>
              {artist.name}
            </h1>
            <ul className="artist-stats">
              <li>{tracks.length} {plural(tracks.length, 'трек', 'трека', 'треков')}</li>
              {albums.length > 0 && (
                <li>{albums.length} {plural(albums.length, 'релиз', 'релиза', 'релизов')}</li>
              )}
              {libraryCount > 0 && <li>{libraryCount} в медиатеке</li>}
            </ul>
          </div>
        </div>
      </header>

      {/* Компактная полоса поверх мобильной верхней панели: имя и play, пока
          шапка прокручена. На десктопе скрыта стилями. */}
      <div
        className={`artist-compact-bar${nameHidden ? ' visible' : ''}`}
        aria-hidden={!nameHidden}
      >
        <span className="artist-compact-name">{artist.name}</span>
        <button
          type="button"
          className="artist-compact-play"
          onClick={handlePlayToggle}
          disabled={tracks.length === 0}
          tabIndex={nameHidden ? 0 : -1}
          aria-label={playLabel}
        >
          {isArtistPlaying ? (
            <Pause size={18} fill="currentColor" />
          ) : (
            <Play size={18} fill="currentColor" />
          )}
        </button>
      </div>

      <div className="artist-toolbar">
        <div className="playlist-actions artist-actions">
          <button
            className="play-button-large artist-play"
            onClick={handlePlayToggle}
            disabled={tracks.length === 0}
            aria-label={playLabel}
          >
            {isArtistPlaying ? (
              <Pause size={24} fill="currentColor" />
            ) : (
              <Play size={24} fill="currentColor" />
            )}
            <span className="artist-action-label">{playLabel}</span>
          </button>
          <button
            className="play-button-large secondary artist-save"
            onClick={handleSaveToLibrary}
            disabled={saving || tracks.length === 0}
            aria-label={saveLabel}
            title={
              artist.playlist_id
                ? 'Плейлист исполнителя уже в медиатеке — открыть'
                : 'Сохранить все треки исполнителя плейлистом'
            }
          >
            {artist.playlist_id ? <ListChecks size={20} /> : <ListPlus size={20} />}
            <span className="artist-action-label">{saveLabel}</span>
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
            <LikeHeart size={20} liked={!!artist.is_liked} />
          </button>
        </div>
      </div>

      <AlbumsRow title="Альбомы" albums={fullAlbums} />
      <AlbumsRow title="Синглы и EP" albums={shortReleases} />

      <div className="playlist-tracks">
        {/* Заголовок нужен только когда выше есть карусели: иначе таблица и так
            единственный блок страницы, и подписывать её нечем. */}
        {albums.length > 0 && <SectionTitle count={tracks.length}>Треки</SectionTitle>}
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
                return (
                  <TrackTableRow
                    key={track.id}
                    track={track}
                    index={index}
                    isCurrent={isCurrent}
                    isPlaying={isCurrent && isPlaying}
                    isLiked={isLiked}
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
