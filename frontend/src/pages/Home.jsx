import { lazy, memo, Suspense, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Play, Pause, Settings, Shield, LogOut, Home as HomeIcon, History } from 'lucide-react'
import {
  recordRecommendationImpression,
  usePlayerStore,
  trackIntentHandlers,
} from '../store/playerStore'
import { useAuthStore } from '../store/authStore'
import { useWaveSettingsStore } from '../store/waveSettingsStore'
import { useUiSettingsStore } from '../store/uiSettingsStore'
import api from '../services/api'
import defaultCover from '../assets/default-cover.webp'
import { resolveCoverUrl, handleCoverError } from '../utils/media'
import { splitArtists } from '../utils/artists'
import Spinner from '../components/Spinner'
import ArtistLink from '../components/ArtistLink'
import Carousel from '../components/Carousel'
import { toast } from '../store/toastStore'
import './Home.css'

// Lazy-load Grainient (ogl WebGL ~150KB) — не блокирует LCP.
const Grainient = lazy(() => import('../components/Grainient'))
const SOUNDCLOUD_PLAYLIST_LIMIT = 12
const SOUNDCLOUD_SEED_LIMIT = 3
const homeRecommendationImpressions = new Set()

function getSoundCloudPlaylistSeeds(user, tracks) {
  const candidates = [
    ...(user?.preferred_artists || []),
    ...tracks.slice(0, 8).flatMap((track) => splitArtists(track.artist)),
    ...(user?.preferred_genres || []),
  ]
  const seen = new Set()

  return candidates
    .map((value) => String(value || '').trim())
    .filter((value) => {
      const key = value.toLocaleLowerCase()
      if (!value || key === 'unknown artist' || seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, SOUNDCLOUD_SEED_LIMIT)
}

// Не зависит от состояния компонента — вынесено на уровень модуля, чтобы
// ссылка была стабильной и не ломала мемоизацию TrackCard.
function handlePlayTrack(track, queue) {
  usePlayerStore.getState().playTrack(track, queue, 'wave')
}

// Мемоизированная карточка трека: при перерисовках Home (смена
// isPlaying/source и т.д.) карточки со стабильными пропсами не
// пересобираются. intent-префетч (hover/pointerdown) прогревает резолв
// на бэке до клика — старт воспроизведения почти мгновенный.
const TrackCard = memo(function TrackCard({ track, queue }) {
  const cardRef = useRef(null)
  useEffect(() => {
    if (!track?.recommendation_id || typeof IntersectionObserver === 'undefined') return undefined
    const key = `${track.recommendation_id}:${track.recommendation_position}:${track.id}`
    if (homeRecommendationImpressions.has(key)) return undefined
    const node = cardRef.current
    if (!node) return undefined
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting && entry.intersectionRatio >= 0.5)) return
        if (homeRecommendationImpressions.has(key)) return
        homeRecommendationImpressions.add(key)
        recordRecommendationImpression(track, { trigger: 'intersection' })
        observer.disconnect()
      },
      { threshold: [0.5] },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [track])

  return (
    <div
      ref={cardRef}
      className="track-card"
      onClick={() => handlePlayTrack(track, queue)}
      {...trackIntentHandlers(track)}
    >
      <img
        src={resolveCoverUrl(track.cover_url) || defaultCover}
        alt={track.title}
        className="track-cover"
        loading="lazy"
        decoding="async"
        onError={handleCoverError}
      />
      <div className="track-info">
        <div className="track-title">{track.title}</div>
        <ArtistLink artist={track.artist} className="track-artist" />
      </div>
    </div>
  )
})

function Home() {
  const [recommendations, setRecommendations] = useState({ tracks: [], playlists: [] })
  const [soundCloudPlaylists, setSoundCloudPlaylists] = useState([])
  const [history, setHistory] = useState([])
  const [loading, setLoading] = useState(true)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [activeTab, setActiveTab] = useState('home')
  // Атомарные селекторы: подписка на весь store перерисовывала всю главную
  // (со всеми списками карточек) на каждом тике currentTime — 4 раза/сек
  // всё время воспроизведения.
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const source = usePlayerStore((s) => s.source)
  const togglePlayPause = usePlayerStore((s) => s.togglePlayPause)
  const waveGif = useWaveSettingsStore((s) => s.waveGif)
  const liteMode = useUiSettingsStore((s) => s.liteMode)
  const [isProfileMenuOpen, setIsProfileMenuOpen] = useState(false)
  // Профиль в верхней шапке — единственное место выхода из аккаунта
  // на мобильных (сайдбар скрыт, в нижней навигации профиля нет).
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)

  const handleLogout = () => {
    setIsProfileMenuOpen(false)
    logout()
    window.location.href = '/login'
  }

  useEffect(() => {
    fetchData()
    // Предзагружаем поток рекомендаций при открытии главной: к клику по
    // «потоку» список уже получен, а резолв первых треков прогрет на бэке —
    // старт воспроизведения почти мгновенный.
    // Через idle, а не сразу: этот запрос ничего не рисует, и в момент
    // монтирования он отбирал полосу у /recommendations и /tracks, от которых
    // зависит первый экран.
    const idle = window.requestIdleCallback ?? ((fn) => setTimeout(fn, 1500))
    const cancel = window.cancelIdleCallback ?? clearTimeout
    const handle = idle(() => usePlayerStore.getState().preloadFlow())
    return () => cancel(handle)
  }, [])

  const fetchData = () => {
    api
      // Локальный час клиента — для контекста времени суток в рекомендациях
      // (таймзона юзера бэку неизвестна): утренняя выдача тяготеет к
      // «утреннему» вкусу, вечерняя — к вечернему.
      .get('/recommendations', { params: { hour: new Date().getHours() } })
      .then((res) => {
        const data = {
          tracks: res.data?.tracks || [],
          playlists: res.data?.playlists || [],
        }
        setRecommendations(data)
        fetchSoundCloudPlaylists(data.tracks)
      })
      .catch((error) => console.error('Error fetching recommendations:', error))
      .finally(() => setLoading(false))
  }

  const fetchSoundCloudPlaylists = async (tracks) => {
    const seeds = getSoundCloudPlaylistSeeds(user, tracks)
    if (seeds.length === 0) return

    const results = await Promise.allSettled(
      seeds.map((seed) =>
        api.get('/search/external/playlists', {
          params: { q: seed, limit: 6 },
          skipErrorToast: true,
        }),
      ),
    )
    const seen = new Set()
    const playlists = []

    for (const result of results) {
      if (result.status !== 'fulfilled') continue
      for (const playlist of result.value.data || []) {
        const key = playlist.external_id || playlist.id
        if (!key || seen.has(key)) continue
        seen.add(key)
        playlists.push(playlist)
        if (playlists.length >= SOUNDCLOUD_PLAYLIST_LIMIT) break
      }
      if (playlists.length >= SOUNDCLOUD_PLAYLIST_LIMIT) break
    }

    setSoundCloudPlaylists(playlists)
  }

  const fetchHistory = async () => {
    setHistoryLoading(true)
    try {
      const response = await api.get('/tracks/me/history', { params: { limit: 30 } })
      setHistory(response.data)
    } catch (error) {
      console.error('Error fetching history:', error)
    } finally {
      setHistoryLoading(false)
    }
  }

  // Кнопка потока управляет ТОЛЬКО потоком. Раньше сюда входил и source
  // 'wave' (клик по карточке трека/плейлиста) — из-за этого после любого
  // проигрывания карточки кнопка вместо запуска потока просто ставила ту
  // очередь на паузу, и пользователь бесконечно слушал одну цепочку.
  const isWavePlaying = isPlaying && source === 'flow'
  // Страховка на случай долгого пребывания на странице (TTL предзагрузки
  // истёк): наведение/касание кнопки обновляет предзагрузку за секунды
  // до клика. Внутри preloadFlow есть дедуп — повторные вызовы бесплатны.
  const waveIntentHandlers = {
    onMouseEnter: () => usePlayerStore.getState().preloadFlow(),
    onPointerDown: () => usePlayerStore.getState().preloadFlow(),
  }

  const handleWaveClick = async () => {
    if (isWavePlaying) {
      togglePlayPause()
      return
    }
    // Пауза потока — возобновляем, не пересоздавая очередь.
    const st = usePlayerStore.getState()
    if (st.flowActive && st.currentTrack) {
      togglePlayPause()
      return
    }
    // Персональный поток.
    try {
      const started = await st.startFlow()
      if (started) return
    } catch (error) {
      console.error('Flow start error:', error)
    }
    // Раньше здесь был фолбэк на статичную выдачу /recommendations (список
    // бывшего раздела «Рекомендуем новинки»). Он играл под source 'wave',
    // поток при этом не активировался — extendFlowIfNeeded молчал, очередь
    // не росла, и каждое нажатие давало одну и ту же цепочку треков.
    // Пустой поток — это ошибка бэка, а не повод подменять его чем-то другим.
    // flowLoading — параллельный запуск/подгрузка потока (двойной клик):
    // это не ошибка, тост не показываем.
    const stAfter = usePlayerStore.getState()
    if (!stAfter.flowActive && !stAfter.flowLoading) {
      toast.error('Поток пока недоступен, попробуйте ещё раз')
    }
  }

  if (loading) {
    return (
      <div className="page-container">
        <Spinner />
      </div>
    )
  }

  return (
    <div className="page-container">
      <div className="mobile-header">
        
        <span href = "">
          <img src="/logoBolt1.webp" alt="BoltMusic" className="mobile-logo-img" />
        </span>
        <div className="mobile-profile">
          <button
            className="mobile-avatar"
            type="button"
            aria-label="Меню профиля"
            aria-expanded={isProfileMenuOpen}
            aria-haspopup="true"
            onClick={() => setIsProfileMenuOpen((prev) => !prev)}
          >
            {user?.avatar_url ? (
              <img src={user.avatar_url} alt="" className="mobile-avatar-img" />
            ) : (
              <span>{(user?.username || 'U').charAt(0).toUpperCase()}</span>
            )}
          </button>
          <div
            className="mobile-profile-menu"
            role="menu"
            data-open={isProfileMenuOpen}
            // React 18 не знает boolean-атрибут inert: true он просто
            // выкинет с warning. Пустая строка попадает в DOM как inert="".
            inert={!isProfileMenuOpen ? '' : undefined}
          >
            <Link
              to="/settings"
              className="mobile-profile-item"
              role="menuitem"
              onClick={() => setIsProfileMenuOpen(false)}
            >
              <Settings size={20} />
              Настройки
            </Link>
            <Link
              to="/admin"
              className="mobile-profile-item"
              role="menuitem"
              onClick={() => setIsProfileMenuOpen(false)}
            >
              <Shield size={20} />
              Админ
            </Link>
            <button
              type="button"
              className="mobile-profile-item"
              role="menuitem"
              onClick={handleLogout}
            >
              <LogOut size={20} />
              Выйти
            </button>
          </div>
        </div>
      </div>
      <div className="hero-section">
        <div className="hero-grainient">
          {liteMode ? (
            <div className="hero-grainient-static" />
          ) : (
            <Suspense fallback={<div className="hero-grainient-static" />}>
              <Grainient
                color1="#e0c3ff"
                color2="#a259ff"
                color3="#6a3093"
                timeSpeed={5}
                colorBalance={-0.32}
                warpStrength={1.4}
                warpFrequency={5}
                warpSpeed={2}
                warpAmplitude={50}
                blendAngle={-49}
                blendSoftness={0.05}
                rotationAmount={500}
                noiseScale={1.95}
                grainAmount={0}
                grainScale={0.2}
                grainAnimated={false}
                contrast={1.5}
                gamma={1}
                saturation={1}
                centerX={0}
                centerY={0}
                zoom={0.9}
                active={isWavePlaying}
              />
            </Suspense>
          )}
        </div>
        <div className={`wave-widget ${isWavePlaying ? 'is-playing' : ''}`}>
          <div className="wave-center">
            {waveGif ? (
              <button
                type="button"
                onClick={handleWaveClick}
                className="wave-gif-button"
                aria-label="поток рекомендаций"
                {...waveIntentHandlers}
              >
                <img
                  src={isWavePlaying ? waveGif : `${waveGif}${waveGif.includes('#') ? '&' : '#'}paused`}
                  alt="поток рекомендаций"
                />
                <span className="wave-gif-icon">
                  {isWavePlaying ? <Pause size={20} /> : <Play size={20} />}
                </span>
              </button>
            ) : (
              <button
                type="button"
                onClick={handleWaveClick}
                className="wave-title"
                {...waveIntentHandlers}
              >
                {isWavePlaying ? <Pause size={20} /> : <Play size={20} />}
                <span>поток</span>
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="home-tabs">
        <button
          type="button"
          className={`home-tab-card ${activeTab === 'home' ? 'active' : ''}`}
          onClick={() => setActiveTab('home')}
        >
          <span className="home-tab-icon">
            <HomeIcon size={20} />
          </span>
          <span className="home-tab-text">
            <span className="home-tab-title">Главная</span>
            <span className="home-tab-subtitle">Рекомендации и подборки</span>
          </span>
        </button>
        <button
          type="button"
          className={`home-tab-card ${activeTab === 'history' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('history')
            if (history.length === 0 && !historyLoading) {
              fetchHistory()
            }
          }}
        >
          <span className="home-tab-icon">
            <History size={20} />
          </span>
          <span className="home-tab-text">
            <span className="home-tab-title">История</span>
            <span className="home-tab-subtitle">Недавно слушали</span>
          </span>
        </button>
      </div>

      {activeTab === 'home' ? (
        <>
          <div className="content-section content-section--tab-fade">
            <h2 className="section-title">Рекомендуемые треки</h2>
            <Carousel
              items={recommendations.tracks}
              label="Рекомендуемые треки"
              renderItem={(track) => (
                <TrackCard
                  key={track.id}
                  track={track}
                  queue={recommendations.tracks}
                />
              )}
            />
          </div>

          {soundCloudPlaylists.length > 0 && (
            <div className="content-section content-section--tab-fade">
              <h2 className="section-title">Плейлисты для вас</h2>
              <Carousel
                items={soundCloudPlaylists}
                label="Рекомендуемые плейлисты SoundCloud"
                renderItem={(playlist) => (
                  <Link
                    key={playlist.id}
                    className="playlist-card"
                    to={`/external/soundcloud/playlists/${playlist.external_id}`}
                  >
                    <img
                      src={playlist.cover_url || defaultCover}
                      alt={playlist.title}
                      className="playlist-cover"
                      loading="lazy"
                      decoding="async"
                      onError={handleCoverError}
                    />
                    <div className="playlist-info">
                      <div className="playlist-name">{playlist.title}</div>
                      <div className="playlist-description">
                        {playlist.owner ? `${playlist.owner} · ` : ''}
                        {playlist.track_count} треков · SoundCloud
                      </div>
                    </div>
                  </Link>
                )}
              />
            </div>
          )}

          {/* {recommendations.playlists.length > 0 && (
            <div className="content-section">
              <h2 className="section-title">Добавленные в сервис</h2>
              <Carousel
                items={recommendations.playlists}
                label="Добавленные в сервис плейлисты"
                renderItem={(playlist) => (
                  <Link
                    key={playlist.id}
                    className="playlist-card"
                    to={`/playlists/${playlist.id}`}
                  >
                    <img
                      src={resolveCoverUrl(playlist.cover_url) || defaultCover}
                      alt={playlist.name}
                      className="playlist-cover"
                      loading="lazy"
                      decoding="async"
                      onError={handleCoverError}
                    />
                    <div className="playlist-info">
                      <div className="playlist-name">{playlist.name}</div>
                      {playlist.description && (
                        <div className="playlist-description">{playlist.description}</div>
                      )}
                    </div>
                  </Link>
                )}
              />
            </div>
          )} */}
        </>
      ) : (
        <div className="content-section content-section--tab-fade">
          <h2 className="section-title">История прослушиваний</h2>
          {historyLoading ? (
            <Spinner />
          ) : history.length === 0 ? (
            <div className="home-empty">Пока нет истории прослушивания</div>
          ) : (
            <div className="tracks-grid">
              {history.map((track) => (
                <TrackCard key={track.id} track={track} queue={history} />
              ))}
            </div>
          )}
        </div>
      )}

    
    </div>
  )
}

export default Home
