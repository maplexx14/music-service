import { lazy, memo, Suspense, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Play, Pause, Settings, Shield, LogOut, Home as HomeIcon, History } from 'lucide-react'
import { usePlayerStore, trackIntentHandlers } from '../store/playerStore'
import { useAuthStore } from '../store/authStore'
import { useWaveSettingsStore } from '../store/waveSettingsStore'
import { useUiSettingsStore } from '../store/uiSettingsStore'
import { useLazyBatch } from '../hooks/useLazyBatch'
import api from '../services/api'
import defaultCover from '../assets/default-cover.png'
import { resolveCoverUrl, handleCoverError } from '../utils/media'
import Spinner from '../components/Spinner'
import ArtistLink from '../components/ArtistLink'
import { toast } from '../store/toastStore'
import './Home.css'

// Lazy-load Grainient (ogl WebGL ~150KB) — не блокирует LCP.
const Grainient = lazy(() => import('../components/Grainient'))

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
  return (
    <div
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
  const [trending, setTrending] = useState([])
  const [history, setHistory] = useState([])
  const [loading, setLoading] = useState(true)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [activeTab, setActiveTab] = useState('home')
  // Атомарные селекторы: подписка на весь store перерисовывала всю главную
  // (со всеми списками карточек) на каждом тике currentTime — 4 раза/сек
  // всё время воспроизведения.
  const playPlaylist = usePlayerStore((s) => s.playPlaylist)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const source = usePlayerStore((s) => s.source)
  const togglePlayPause = usePlayerStore((s) => s.togglePlayPause)
  const waveGif = useWaveSettingsStore((s) => s.waveGif)
  const liteMode = useUiSettingsStore((s) => s.liteMode)
  const [isProfileMenuOpen, setIsProfileMenuOpen] = useState(false)
  // Подборок с бэка может прийти много, а обложка у каждой своя — рисуем их
  // партиями по мере прокрутки.
  const { visibleItems: visiblePlaylists, sentinelRef: playlistsSentinelRef } = useLazyBatch(
    recommendations.playlists,
  )
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
    // Предзагружаем поток рекомендаций сразу при открытии главной:
    // к клику по «потоку» список уже получен, а резолв первых треков
    // прогрет на бэке — старт воспроизведения почти мгновенный.
    usePlayerStore.getState().preloadFlow()
  }, [])

  const fetchData = async () => {
    try {
      const [recResponse, tracksResponse] = await Promise.all([
        // Локальный час клиента — для контекста времени суток в рекомендациях
        // (таймзона юзера бэку неизвестна): утренняя выдача тяготеет к
        // «утреннему» вкусу, вечерняя — к вечернему.
        api.get('/recommendations', { params: { hour: new Date().getHours() } }),
        api.get('/tracks?limit=20'),
      ])
      setRecommendations(recResponse.data)
      setTrending(tracksResponse.data)
    } catch (error) {
      console.error('Error fetching data:', error)
    } finally {
      setLoading(false)
    }
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

  const handlePlayPlaylist = (playlist) => {
    if (playlist.tracks && playlist.tracks.length > 0) {
      playPlaylist(playlist.tracks, 0, 'wave')
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
          <img src="/logoBolt1.PNG" alt="BoltMusic" className="mobile-logo-img" />
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
          {isProfileMenuOpen && (
            <div className="mobile-profile-menu" role="menu">
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
          )}
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
          <div className="content-section">
            <h2 className="section-title">Тренды</h2>
            <div className="tracks-grid">
              {trending.slice(0, 12).map((track) => (
                <TrackCard key={track.id} track={track} queue={trending} />
              ))}
            </div>
          </div>

          {recommendations.playlists.length > 0 && (
            <div className="content-section">
              <h2 className="section-title">Рекомендуемые плейлисты</h2>
              <div className="playlists-grid">
                {visiblePlaylists.map((playlist) => (
                  <div
                    key={playlist.id}
                    className="playlist-card"
                    onClick={() => handlePlayPlaylist(playlist)}
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
                  </div>
                ))}
              </div>
              {/* Маячок догрузки — соседом, а не ячейкой сетки: внутри
                  .playlists-grid он занял бы колонку и порвал ряд. */}
              <div ref={playlistsSentinelRef} aria-hidden="true" />
            </div>
          )}
        </>
      ) : (
        <div className="content-section">
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
