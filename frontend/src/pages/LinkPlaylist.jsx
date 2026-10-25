import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { usePlayerStore, trackLikeKey } from '../store/playerStore'
import { useImportStore } from '../store/importStore'
import { Play, Plus } from 'lucide-react'
import api from '../services/api'
import { peekCache, writeCache } from '../services/pageCache'
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
import './Artist.css'

// Ссылка Spotify/Deezer/Яндекс Музыки или плейлист YouTube Music: слушать
// сразу, без импорта. Треки
// подбираются в YouTube Music на бэке страницами (секунды на страницу), поэтому
// хвост длинной коллекции догружается по мере прокрутки, а очередь плеера
// дотягивает его сама по курсору (playerStore.extendQueueIfNeeded).
const PAGE_SIZE = 50
const LISTEN_URL = '/import/listen'

const SOURCE_LABELS = {
  spotify: 'Spotify',
  deezer: 'Deezer',
  yandex: 'Яндекс Музыка',
  ytmusic: 'YouTube Music',
}
const KIND_LABELS = {
  track: 'Трек',
  album: 'Альбом',
  playlist: 'Плейлист',
  artist: 'Популярное исполнителя',
  likes: 'Мне нравится',
}

function LinkPlaylist() {
  const [searchParams] = useSearchParams()
  const url = searchParams.get('url') || ''
  const navigate = useNavigate()
  const cacheKey = `link:${url}`
  const [info, setInfo] = useState(() => peekCache(cacheKey)?.info ?? null)
  const [tracks, setTracks] = useState(() => peekCache(cacheKey)?.tracks ?? [])
  const [nextOffset, setNextOffset] = useState(() => peekCache(cacheKey)?.nextOffset ?? null)
  const [skipped, setSkipped] = useState(() => peekCache(cacheKey)?.skipped ?? 0)
  const [loading, setLoading] = useState(() => !peekCache(cacheKey))
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState(null)
  const [importing, setImporting] = useState(false)
  const heroColors = useCoverColors(info?.cover_url) || DEFAULT_HERO_COLORS

  const playPlaylist = usePlayerStore((s) => s.playPlaylist)
  const currentTrackId = usePlayerStore((s) => s.currentTrack?.id)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const likedTrackIds = usePlayerStore((s) => s.likedTrackIds)
  const pendingLikeKeys = usePlayerStore((s) => s.pendingLikeKeys)
  const toggleLikeForTrack = usePlayerStore((s) => s.toggleLikeForTrack)
  const fetchLikedTracks = usePlayerStore((s) => s.fetchLikedTracks)
  const materializeTrack = usePlayerStore((s) => s.materializeTrack)

  const { visibleItems: visibleTracks, sentinelRef: tracksSentinelRef } = useLazyBatch(tracks, {
    batchSize: 30,
    resetKey: url,
  })

  const fetchPage = (skip) =>
    api.get(LISTEN_URL, {
      params: { url, skip, limit: PAGE_SIZE },
      // Холодный подбор страницы — секунды, дольше глобального таймаута на
      // больших коллекциях не бывает, но и обрывать его незачем.
      timeout: 0,
      skipErrorToast: true,
    })

  useEffect(() => {
    if (!url) {
      navigate('/search', { replace: true })
      return
    }
    fetchLikedTracks()
    if (peekCache(cacheKey)) return
    let cancelled = false
    setLoading(true)
    setError(null)
    fetchPage(0)
      .then(({ data }) => {
        if (cancelled) return
        const nextInfo = { source: data.source, kind: data.kind, title: data.title, cover_url: data.cover_url, total: data.total }
        setInfo(nextInfo)
        setTracks(data.tracks)
        setNextOffset(data.next_offset)
        setSkipped(data.skipped)
        usePlayerStore.getState().prefetchTracks(data.tracks, 3)
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.detail || 'Не удалось открыть ссылку')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [url])

  // Кэш страницы: возврат назад не должен заново подбирать треки.
  useEffect(() => {
    if (!loading && info) writeCache(cacheKey, { info, tracks, nextOffset, skipped })
  }, [info, tracks, nextOffset, skipped, loading])

  // Хвост коллекции — когда до конца отрисованного списка доскроллили.
  const [moreSentinel, setMoreSentinel] = useState(null)
  const loadMoreRef = useRef(null)
  loadMoreRef.current = async () => {
    if (loadingMore || nextOffset == null) return
    setLoadingMore(true)
    try {
      const { data } = await fetchPage(nextOffset)
      setTracks((prev) => {
        const known = new Set(prev.map((t) => t.id))
        return [...prev, ...data.tracks.filter((t) => !known.has(t.id))]
      })
      setNextOffset(data.next_offset)
      setSkipped((n) => n + data.skipped)
    } catch (err) {
      console.error('Link page load error:', err)
      toast.error('Не удалось догрузить треки')
      setNextOffset(null)
    } finally {
      setLoadingMore(false)
    }
  }
  const allVisible = visibleTracks.length >= tracks.length
  useEffect(() => {
    if (!moreSentinel || !allVisible || nextOffset == null || loadingMore) return
    // Новый наблюдатель на каждую догрузку: он сразу сообщает текущее
    // состояние, и короткая страница, не вытолкнувшая маячок из вида, тянет
    // следующую без прокрутки.
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMoreRef.current()
      },
      { rootMargin: '600px' },
    )
    observer.observe(moreSentinel)
    return () => observer.disconnect()
  }, [moreSentinel, allVisible, nextOffset, loadingMore])

  const queuePager = () =>
    nextOffset != null
      ? { url: LISTEN_URL, params: { url }, total: info?.total || 0, cursor: nextOffset }
      : null

  const handlePlay = () => {
    if (tracks.length > 0) playPlaylist(tracks, 0, 'external', queuePager())
  }

  const handlePlayTrack = (track, index) => {
    playPlaylist(tracks, index, 'external', queuePager())
  }

  const handleImport = async () => {
    if (importing || !info) return
    setImporting(true)
    // Ход и итог — в окне импорта, как у импорта со страницы медиатеки.
    await useImportStore.getState().start({ url, title: info.title })
    setImporting(false)
  }

  const handleToggleLike = async (track, e) => {
    e.stopPropagation()
    try {
      await toggleLikeForTrack(track, (id) => {
        setTracks((prev) => prev.map((t) => (t.id === track.id ? { ...t, db_id: id } : t)))
      })
    } catch (err) {
      console.error('Error toggling like:', err)
      toast.error('Не удалось обновить понравившиеся')
    }
  }

  const ensureDbId = async (track) => {
    if (typeof track.db_id === 'number') return track.db_id
    const dbId = await materializeTrack(track)
    setTracks((prev) => prev.map((t) => (t.id === track.id ? { ...t, db_id: dbId } : t)))
    return dbId
  }

  const rowActions = useRef(null)
  rowActions.current = {
    play: handlePlayTrack,
    toggleLike: handleToggleLike,
    resolveId: ensureDbId,
  }
  const likedSet = useMemo(() => new Set(likedTrackIds), [likedTrackIds])

  if (loading) {
    return <Spinner page label="Подбираем треки..." />
  }

  if (error || !info) {
    return (
      <div className="page-container">
        <div className="empty-playlist">
          <p>{error || 'Не удалось открыть ссылку'}</p>
        </div>
      </div>
    )
  }

  const heroStyle = {
    '--hero-c1': heroColors[0],
    '--hero-c2': heroColors[1],
    '--hero-c3': heroColors[2],
  }
  const sourceLabel = SOURCE_LABELS[info.source] || info.source
  const title = info.title || sourceLabel

  return (
    <div className="page-container hero-page" style={heroStyle}>
      <header className="artist-hero" style={heroStyle}>
        {info.cover_url && (
          <img
            src={resolveCoverUrl(info.cover_url, 'thumb') || resolveCoverUrl(info.cover_url)}
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
            src={resolveCoverUrl(info.cover_url) || defaultCover}
            alt={title}
            decoding="async"
            className="artist-avatar playlist-hero-cover"
            onError={handleCoverError}
          />
          <div className="artist-hero-info">
            <div className="artist-kicker">{KIND_LABELS[info.kind] || 'Подборка'} · {sourceLabel}</div>
            <h1 className="artist-name" style={titleFitStyle(title)}>{title}</h1>
            <ul className="artist-stats">
              <li>{info.total} треков</li>
              {skipped > 0 && <li>{skipped} не нашлось</li>}
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
          {/* Импорт ссылок YouTube Music бэк не умеет. */}
          {info.kind !== 'track' && info.source !== 'ytmusic' && (
            <button
              className="btn btn--secondary btn--lg play-button-large round-actions__icon"
              onClick={handleImport}
              disabled={importing}
              aria-label="Добавить в медиатеку"
            >
              <Plus size={20} />
              <span className="round-actions__label">{importing ? 'Добавление...' : 'Добавить в медиатеку'}</span>
            </button>
          )}
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
          !loadingMore && nextOffset == null && (
            <div className="empty-playlist">
              <p>{info.source === 'ytmusic' ? 'В плейлисте нет треков' : 'Ни один трек не нашёлся в YouTube Music'}</p>
            </div>
          )
        )}
        <div ref={tracksSentinelRef} aria-hidden="true" />
        <div ref={setMoreSentinel} aria-hidden="true" />
        {loadingMore && <Spinner label="Подбираем треки..." />}
      </div>
    </div>
  )
}

export default LinkPlaylist
