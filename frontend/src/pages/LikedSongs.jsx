import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePlayerStore } from '../store/playerStore'
import { Play, Share, Shuffle } from 'lucide-react'
import api from '../services/api'
import { peekCache, writeCache, PLAYLIST_PAGE_SIZE, LIKED_CACHE_KEY } from '../services/pageCache'
import Spinner from '../components/Spinner'
import TrackTableRow from '../components/TrackTableRow'
import { useInfiniteScroll } from '../hooks/useInfiniteScroll'
import { toast } from '../store/toastStore'
import defaultCover from '../assets/default-cover.webp'
// Сердце из логотипа (public/logoBoltwo.png), выровненное (в логотипе оно
// наклонено на 19,5°), 271px: loader-heart всего 128px
// и на весь верх экрана мылился.
import logoHeart from '../assets/liked-hero-heart.webp'
import { resolveCoverUrl, handleCoverError } from '../utils/media'
import { titleFitStyle } from '../utils/titleFit'
import { shareLink } from '../utils/shareLink'
import CoverBackdrop, { useCoverBackdrop } from '../components/CoverBackdrop'
import { useScreen } from '../hooks/useScreen'
import './PlaylistDetail.css'
// Шапка и фон в тон обложки (CoverBackdrop) — как у исполнителя.
import './Artist.css'

const TRACKS_PAGE_SIZE = PLAYLIST_PAGE_SIZE
// Тёмный край градиента сердца (--hero-c3, Artist.css).
const LIKED_TINT = '#440f85'
// Молнии, что вылетают из сердца при открытии, — как у BoltLoader, но
// веером только вверх и в стороны: вниз они летели бы по названию.
// a — направление (0 — вверх), spin — доворот в полёте, v — форма спрайта,
// k — масштаб.
const LIKED_BOLTS = [
  { a: -80, spin: -15, v: 1, k: 0.9 },
  { a: -40, spin: 20, v: 2, k: 1.1 },
  { a: 0, spin: -10, v: 3, k: 0.85 },
  { a: 40, spin: 25, v: 1, k: 1 },
  { a: 80, spin: -20, v: 2, k: 1.05 },
]

// «Понравившиеся» — это обычный плейлист (is_liked=true на бэке), поэтому
// интерфейс страницы полностью повторяет PlaylistDetail.
function LikedSongs() {
  const navigate = useNavigate()
  // На мобиле вкладка монтируется скрытой в фоне (ScreenStack warmTabs) —
  // упавший запрос не должен уводить юзера с экрана, на котором он стоит.
  const { active } = useScreen()
  const activeRef = useRef(active)
  activeRef.current = active
  // Первая страница из прошлого захода рисуется сразу, свежая — фоном.
  const [playlist, setPlaylist] = useState(() => peekCache(LIKED_CACHE_KEY)?.playlist ?? null)
  const coverBackdrop = useCoverBackdrop(playlist?.cover_url)
  // Своей обложки у «Понравившихся» обычно нет — тогда обложка во весь верх
  // это сердце логотипа на фирменном градиенте (как квадрат в шапке), а
  // фон — тёмный край этого градиента, в который оно растворяется.
  const backdrop = playlist?.cover_url
    ? coverBackdrop
    : {
        tint: LIKED_TINT,
        art: (
          <div className="liked-hero-cover liked-hero-art">
            {/* Ключ по active: вылет молний проигрывается при каждом
                открытии вкладки, а не один раз, пока она висела скрытой. */}
            <span key={active ? 'on' : 'off'} className="liked-hero-heart">
              {LIKED_BOLTS.map((b, i) => (
                <i
                  key={i}
                  className={`liked-hero-bolt v${b.v}`}
                  style={{ '--a': `${b.a}deg`, '--spin': `${b.spin}deg`, '--k': b.k, '--i': i }}
                />
              ))}
              <img className="liked-heart-beat" src={logoHeart} alt="" decoding="async" />
            </span>
          </div>
        ),
      }
  const [loading, setLoading] = useState(() => !peekCache(LIKED_CACHE_KEY))
  const [totalTracks, setTotalTracks] = useState(() => peekCache(LIKED_CACHE_KEY)?.total ?? 0)
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
  const likedTracksLoaded = usePlayerStore((s) => s.likedTracksLoaded)
  const likeConfirmedAt = usePlayerStore((s) => s.likeConfirmedAt)
  const toggleTrackLike = usePlayerStore((s) => s.toggleTrackLike)
  const fetchLikedTracks = usePlayerStore((s) => s.fetchLikedTracks)

  useEffect(() => {
    fetchPlaylist()
    fetchLikedTracks()
  }, [])

  // Лайки меняются и мимо этой страницы — сердцем в плеере, дизлайком. Снятый
  // убираем из списка сразу, а новый тянем свежей первой страницей, когда бэк
  // его подтвердил: данных трека тут нет, а встаёт он в начало.
  // null — id ещё не загружены: их первая загрузка не изменение лайков.
  const prevLikedIds = useRef(likedTracksLoaded ? likedTrackIds : null)
  useEffect(() => {
    if (!likedTracksLoaded) return
    const prevIds = prevLikedIds.current
    prevLikedIds.current = likedTrackIds
    if (!prevIds || prevIds === likedTrackIds) return
    const next = new Set(likedTrackIds)
    const removed = prevIds.filter((id) => !next.has(id))
    if (removed.length) {
      const gone = new Set(removed)
      setPlaylist((p) => (p ? { ...p, tracks: p.tracks.filter((t) => !gone.has(t.id)) } : p))
      setTotalTracks((n) => Math.max(0, n - removed.length))
    }
  }, [likedTrackIds, likedTracksLoaded])

  // Скрытой вкладке запрос упал молча — повторяем, когда её открыли.
  useEffect(() => {
    if (active && !loading && !playlist) {
      setLoading(true)
      fetchPlaylist()
    }
  }, [active])

  const mountLikeConfirmedAt = useRef(likeConfirmedAt)
  useEffect(() => {
    if (likeConfirmedAt !== mountLikeConfirmedAt.current) fetchPlaylist()
  }, [likeConfirmedAt])

  // Кэш следует за списком (в том числе за снятыми здесь лайками), но хранит
  // только первую страницу — остальное догружается прокруткой.
  useEffect(() => {
    if (loading || !playlist) return
    writeCache(LIKED_CACHE_KEY, {
      playlist: { ...playlist, tracks: playlist.tracks.slice(0, TRACKS_PAGE_SIZE) },
      total: totalTracks,
    })
  }, [playlist, totalTracks, loading])

  const fetchPlaylist = async () => {
    try {
      const response = await api.get('/playlists/me/liked', {
        params: { skip: 0, limit: TRACKS_PAGE_SIZE },
      })
      const fresh = response.data
      // Фоновое обновление не схлопывает уже догруженные страницы. Хвост —
      // всё, чего нет в свежей странице: новые лайки сдвигают список, и срез
      // по длине терял треки с конца первой страницы.
      setPlaylist((prev) => {
        if (!prev || prev.tracks.length <= fresh.tracks.length) return fresh
        const freshIds = new Set(fresh.tracks.map((t) => t.id))
        const tail = prev.tracks.filter((t) => !freshIds.has(t.id))
        return { ...fresh, tracks: [...fresh.tracks, ...tail] }
      })
      setTotalTracks(Number(response.headers['x-total-count']) || fresh.tracks.length)
    } catch (error) {
      console.error('Error fetching liked playlist:', error)
      if (!peekCache(LIKED_CACHE_KEY) && activeRef.current) navigate('/playlists')
    } finally {
      setLoading(false)
    }
  }

  const handleLoadMore = async () => {
    if (loadingMore) return
    setLoadingMore(true)
    setLoadError(false)
    try {
      const response = await api.get('/playlists/me/liked', {
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
  // загруженном треке: для плеера это выглядело как конец списка. Пейджер
  // говорит плееру, откуда дотянуть хвост самому, не дожидаясь прокрутки.
  const queuePager = () => ({ url: '/playlists/me/liked', total: totalTracks })

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
      // Строку убирает подписка на likedTrackIds выше — сразу, до ответа сети.
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

  // «Понравившиеся» создаются приватными — по ссылке их открывает только
  // владелец. Делиться — значит открыть доступ, но только у того, кто нажал.
  // Шторку открываем сразу, не дожидаясь запроса: Safari пускает share()
  // только прямо из тапа (см. utils/shareLink).
  const handleShare = () => {
    shareLink({
      title: playlist.name,
      text: playlist.name,
      url: `${window.location.origin}/playlists/${playlist.id}`,
    })
    if (playlist.is_public) return
    api.put(`/playlists/${playlist.id}`, { is_public: true }, { skipErrorToast: true })
      .then(() => setPlaylist((prev) => (prev ? { ...prev, is_public: true } : prev)))
      .catch((error) => {
        console.error('Error making liked playlist public:', error)
        toast.error('Не удалось открыть доступ по ссылке')
      })
  }

  return (
    <div className={`page-container hero-page${backdrop.hero || backdrop.art ? ' has-cover-hero' : ''}`}>
      <CoverBackdrop {...backdrop} />
      <header className="artist-hero">
        <div className="artist-hero-content">
          {/* Своей обложки у «Понравившихся» обычно нет, а заглушка с нотой —
              чёрный квадрат. Вместо неё — сердце из логотипа на градиенте
              шапки. */}
          {playlist.cover_url ? (
            <img
              src={resolveCoverUrl(playlist.cover_url) || defaultCover}
              alt={playlist.name}
              decoding="async"
              className="artist-avatar playlist-hero-cover"
              onError={handleCoverError}
            />
          ) : (
            <div className="artist-avatar playlist-hero-cover liked-hero-cover" aria-hidden="true">
              <img className="liked-heart-beat" src={logoHeart} alt="" decoding="async" />
            </div>
          )}
          <div className="artist-hero-info">
            <div className="artist-kicker">Плейлист</div>
            <h1 className="artist-name" style={titleFitStyle(playlist.name)}>{playlist.name}</h1>
            {playlist.description && (
              <p className="playlist-hero-description">{playlist.description}</p>
            )}
            <ul className="artist-stats">
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
            onClick={handleShare}
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

export default LikedSongs
