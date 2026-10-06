import { lazy, memo, Suspense, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Play, Pause, Loader2, Home as HomeIcon, History } from 'lucide-react'
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
import { usePullToRefresh } from '../hooks/usePullToRefresh'
import { useScreen } from '../hooks/useScreen'
import Spinner from '../components/Spinner'
import BoltLoader from '../components/BoltLoader'
import ArtistLink from '../components/ArtistLink'
import Carousel from '../components/Carousel'
import HeroDisc from '../components/HeroDisc'
import HeroBolts from '../components/HeroBolts'
import { isSoftwareRendering } from '../utils/gpu'
import { useCoverColors, prefetchCoverColors } from '../hooks/useCoverColors'
import { DEFAULT_HERO_COLORS } from '../utils/coverColor'
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
  // Главная живёт смонтированной и скрытой, пока открыта другая вкладка, а
  // IntersectionObserver видимость (visibility: hidden) не учитывает — без
  // этой проверки скрытые карточки засчитывались бы как показанные.
  const { active } = useScreen()
  useEffect(() => {
    if (!active) return undefined
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
  }, [track, active])

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

// Последняя выдача главной живёт в модуле и переживает размонтирование
// страницы. Без неё каждый возврат на главную начинался со скелетона, карточки
// монтировались с нуля, и в iOS PWA обложки проявлялись заново. Теперь прошлая
// выдача рисуется сразу, а свежая подменяет её по ответу; если выдача та же
// (кэш бэка), React оставляет те же <img>. Снимок привязан к юзеру: после
// смены аккаунта чужая выдача не покажется.
let homeSnapshot = null

function readHomeSnapshot(userId) {
  return homeSnapshot && homeSnapshot.userId === userId ? homeSnapshot : null
}

function writeHomeSnapshot(userId, patch) {
  homeSnapshot = { ...(readHomeSnapshot(userId) || { userId }), ...patch }
}

// Индикатор pull-to-refresh: выезжает из-под шапки по мере жеста. Состояние
// жеста живёт здесь, а не в Home: жест тикает каждый кадр, и перерисовывать
// на каждом тике всю главную (полки, карусели, hero) незачем.
function PullToRefreshIndicator({ onRefresh, reachTop, root }) {
  const { pull, refreshing } = usePullToRefresh({ onRefresh, reachTop, root })
  if (pull <= 0 && !refreshing) return null
  const pullProgress = refreshing ? 1 : Math.min(pull / 64, 1)
  return (
    <div
      className="ptr-indicator"
      style={{ opacity: pullProgress, transform: `translateY(${-32 + (refreshing ? 32 : pull * 0.35)}px)` }}
      aria-hidden="true"
    >
      <BoltLoader
        size={18}
        frame={36}
        active={refreshing}
        style={refreshing ? undefined : { transform: `scale(${0.6 + pullProgress * 0.4})` }}
      />
    </div>
  )
}

function Home() {
  const userId = useAuthStore((s) => s.user?.id)
  const [snapshot] = useState(() => readHomeSnapshot(userId))
  const [recommendations, setRecommendations] = useState(
    () => snapshot?.recommendations ?? { tracks: [], playlists: [] },
  )
  const [soundCloudPlaylists, setSoundCloudPlaylists] = useState(
    () => snapshot?.soundCloudPlaylists ?? [],
  )
  const [history, setHistory] = useState(() => snapshot?.history ?? [])
  const [loading, setLoading] = useState(!snapshot?.recommendations)
  const [historyLoading, setHistoryLoading] = useState(false)
  const historyRequestedRef = useRef(false)
  const [activeTab, setActiveTab] = useState('home')
  // Атомарные селекторы: подписка на весь store перерисовывала всю главную
  // (со всеми списками карточек) на каждом тике currentTime — 4 раза/сек
  // всё время воспроизведения.
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const source = usePlayerStore((s) => s.source)
  const togglePlayPause = usePlayerStore((s) => s.togglePlayPause)
  // Текущий трек нужен главной только ради цвета фона под его обложку:
  // подписка добавляет перерисовку на смену трека (событие редкое), тиков
  // времени в ней нет.
  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const liteMode = useUiSettingsStore((s) => s.liteMode)
  // В облегчённом режиме фон всегда стандартный: обложку не разбираем вовсе
  // (сеть, декод картинки и canvas на каждый трек) — вспышки на фиолетовом
  // фоне логотипа и так смотрятся цельно.
  const coverColors = useCoverColors(liteMode ? null : currentTrack?.cover_url)
  // Пока цвет не разобран (серая обложка, трек без обложки, ошибка canvas) —
  // дефолтная фиолетовая пара, как было зашито в hero раньше.
  const heroColors = (!liteMode && coverColors) || DEFAULT_HERO_COLORS
  const waveGif = useWaveSettingsStore((s) => s.waveGif)
  // Без аппаратного ускорения WebGL-шейдер на весь hero считается на CPU —
  // вместо него статичный CSS-градиент тех же цветов.
  const noGpu = isSoftwareRendering()
  // Аватар в верхней шапке — вход в профиль и настройки на мобильных
  // (сайдбар скрыт, в нижней навигации профиля нет). Выход — там же.
  const user = useAuthStore((s) => s.user)

  useEffect(() => {
    fetchData()
  }, [])

  // Разбор обложки следующего трека — заранее. Разбор идёт через сеть и декод
  // картинки, поэтому без прогрева фон докрашивался бы уже во время трека, а на
  // быстрых переключениях цвет отставал бы на один трек. Следующий трек известен
  // из очереди, а кэш разбора общий с useCoverColors — так что в момент смены
  // трека палитра уже готова и берётся синхронно.
  useEffect(() => {
    if (liteMode) return
    const next = usePlayerStore.getState().getNextTrack(1)
    prefetchCoverColors(next?.cover_url)
  }, [currentTrack, liteMode])

  // Плейлисты SoundCloud раньше стартовали ТОЛЬКО из .then() рекомендаций —
  // получался водопад: 2.2с recs (холодные) + 1.2с плейлисты = 3.4с до второй
  // полки. Но сиды из preferred_artists юзера известны сразу, до всякой сети,
  // поэтому запрос уходит параллельно с /recommendations. Если предпочтений
  // нет, ждём треки как раньше (см. fetchSoundCloudPlaylists).
  const scRequestedRef = useRef(false)
  useEffect(() => {
    if (scRequestedRef.current) return
    if (!user?.preferred_artists?.length) return
    scRequestedRef.current = true
    fetchSoundCloudPlaylists([])
  }, [user])

  const fetchData = () => {
    api
      // Локальный час клиента — для контекста времени суток в рекомендациях
      // (таймзона юзера бэку неизвестна): утренняя выдача тяготеет к
      // «утреннему» вкусу, вечерняя — к вечернему. Слэш в конце: без него
      // FastAPI отвечает 307 и каждый заход платит лишний раунд-трип.
      .get('/recommendations/', { params: { hour: new Date().getHours() } })
      .then((res) => {
        const data = {
          tracks: res.data?.tracks || [],
          playlists: res.data?.playlists || [],
        }
        setRecommendations(data)
        writeHomeSnapshot(userId, { recommendations: data })
        // Если сиды из preferred_artists уже ушли параллельным эффектом —
        // второй раз не ходим: дедуп в api.get спасает только одновременные
        // запросы, а этот пришёл бы позже и стоил бы ещё раунд-трипа.
        if (!scRequestedRef.current) {
          scRequestedRef.current = true
          fetchSoundCloudPlaylists(data.tracks)
        }
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
    writeHomeSnapshot(userId, { soundCloudPlaylists: playlists })
  }

  const fetchHistory = async () => {
    historyRequestedRef.current = true
    // Спиннер только когда показать нечего: снимок прошлого захода остаётся
    // на экране, пока свежая история не придёт.
    if (history.length === 0) setHistoryLoading(true)
    try {
      const response = await api.get('/tracks/me/history', { params: { limit: 30 } })
      setHistory(response.data)
      writeHomeSnapshot(userId, { history: response.data })
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
  // Поток запускается (список ещё не пришёл) — кнопка сразу показывает, что
  // нажатие принято. Подгрузка следующей порции идёт при flowActive — её не
  // показываем.
  const flowStarting = usePlayerStore((s) => s.flowLoading && !s.flowActive)
  // Pull-to-refresh: шапка/hero не зависят от рекомендаций, поэтому тянем
  // обновление вручную по жесту — как в нативных приложениях. Индикатор
  // рисуется отдельным fixed-элементом, список не дёргается.
  // reachTop важен: скролл живёт в контейнере экрана, window.scrollY всегда 0.
  // Слушатели жеста висят на window — на скрытой главной (открыта другая
  // вкладка) жест не начинается вовсе.
  const { active: screenActive, scrollerRef } = useScreen()

  // Предзагружаем поток рекомендаций: к клику по «потоку» список уже получен,
  // а резолв первых треков прогрет на бэке — старт почти мгновенный.
  // Через idle, а не сразу: этот запрос ничего не рисует, и при открытии он
  // отбирал полосу у /recommendations и /tracks, от которых зависит экран.
  // Главная живёт смонтированной всю сессию (ScreenStack), поэтому одной
  // предзагрузки на монтировании мало: через 5 минут (TTL) список устаревал,
  // и нажатие ждало расчёта рекомендаций на бэке — секунды без отклика.
  // Пока главная на экране, освежаем предзагрузку раз в минуту и при
  // возврате в приложение; preloadFlow сам пропускает свежий список, летящий
  // запрос и уже играющий поток, так что лишних запросов нет.
  useEffect(() => {
    if (!screenActive) return undefined
    const idle = window.requestIdleCallback ?? ((fn) => setTimeout(fn, 1500))
    const cancel = window.cancelIdleCallback ?? clearTimeout
    const preload = () => usePlayerStore.getState().preloadFlow()
    const handle = idle(preload)
    const timer = setInterval(preload, 60 * 1000)
    const onVisible = () => {
      if (!document.hidden) preload()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancel(handle)
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [screenActive])
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

  // Раньше здесь был ранний `return <Spinner/>` на всю страницу: пока шли
  // холодные /recommendations (замер: 2.2с), юзер смотрел на пустой контейнер —
  // хотя шапка, hero с кнопкой потока и вкладки не зависят от этого запроса
  // вообще. Теперь оболочка рисуется сразу (FCP не ждёт сеть), а ожидание
  // локализовано в той единственной полке, которой нужны данные.
  return (
    <div className="page-container">
      <PullToRefreshIndicator
        onRefresh={fetchData}
        reachTop={() => screenActive && (scrollerRef?.current?.scrollTop ?? window.scrollY) <= 0}
        root={() => scrollerRef?.current ?? null}
      />
      <div className="mobile-header">
        
        <span href = "">
          <img src="/logoBolt1.webp" alt="BoltMusic" className="mobile-logo-img" />
        </span>
        <Link to="/settings" className="mobile-avatar" aria-label="Профиль и настройки">
          {user?.avatar_url ? (
            <img src={user.avatar_url} alt="" className="mobile-avatar-img" />
          ) : (
            <span aria-hidden="true">{(user?.username || 'U').charAt(0).toUpperCase()}</span>
          )}
        </Link>
      </div>
      <div
        className="hero-section"
        // Цвета градиента hero: тройка под доминирующий тон обложки текущего
        // трека. Здесь они нужны ради CSS-заглушки (.hero-grainient-static —
        // lite mode и фолбэк Suspense), сам WebGL-градиент получает те же
        // цвета пропсами ниже.
        style={{
          '--hero-c1': heroColors[0],
          '--hero-c2': heroColors[1],
          '--hero-c3': heroColors[2],
        }}
      >
        <div className="hero-grainient">
          {liteMode || noGpu ? (
            <>
              <div className="hero-grainient-static" />
              <HeroBolts active={isWavePlaying} />
            </>
          ) : (
            <Suspense fallback={<div className="hero-grainient-static" />}>
              <Grainient
                color1={heroColors[0]}
                color2={heroColors[1]}
                color3={heroColors[2]}
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
                rippleFrom=".hero-disc"
                rippleStrength={1}
                rippleKey={currentTrack ? 1 : 0}
                active={isWavePlaying}
              />
            </Suspense>
          )}
        </div>
        {/* Диск с обложкой текущего трека — слой между градиентом и кнопкой
            потока: кнопка остаётся в центре диска, как на макете. Сам диск
            подписан на currentTrack, главная от его тиков не перерисовывается. */}
        <HeroDisc />
        <div className={`wave-widget ${isWavePlaying ? 'is-playing' : ''}`}>
          <div className="wave-center">
            {/* Крупный заголовок над кнопкой. Висит абсолютно, чтобы сама
                кнопка оставалась ровно в центре диска. Для скринридеров
                название несёт aria-label кнопки. */}
            <div className="wave-heading" aria-hidden="true">поток</div>
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
                  {flowStarting ? (
                    <Loader2 size={20} className="wave-loading-icon" />
                  ) : isWavePlaying ? (
                    <Pause size={20} />
                  ) : (
                    <Play size={20} />
                  )}
                </span>
              </button>
            ) : (
              <button
                type="button"
                onClick={handleWaveClick}
                className="wave-title"
                aria-label={isWavePlaying ? 'пауза потока' : 'включить поток'}
                aria-busy={flowStarting || undefined}
                {...waveIntentHandlers}
              >
                {flowStarting ? (
                  <Loader2 size={40} strokeWidth={2.5} className="wave-loading-icon" />
                ) : isWavePlaying ? (
                  <Pause size={38} fill="currentColor" strokeWidth={0} />
                ) : (
                  // Треугольник визуально тяжелее слева — сдвиг вправо
                  // ставит его в оптический центр круга.
                  <Play size={44} fill="currentColor" strokeWidth={0} className="wave-title-play" />
                )}
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
            if ((!historyRequestedRef.current || history.length === 0) && !historyLoading) {
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

      {/* Обе вкладки остаются в DOM, неактивная скрыта. Условный рендер
          размонтировал карточки на каждом переключении, и на iOS обложки
          заново проходили lazy-загрузку и декод: мигали пустыми. */}
      <div hidden={activeTab !== 'home'}>
          <div className="content-section content-section--tab-fade">
            <h2 className="section-title">Рекомендуемые треки</h2>
            {loading ? (
              <div className="home-skeleton-row" aria-busy="true" aria-label="Загрузка рекомендаций">
                {Array.from({ length: 6 }, (_, i) => (
                  <div className="home-skeleton-card" key={i}>
                    <div className="home-skeleton-cover" />
                    <div className="home-skeleton-line" />
                    <div className="home-skeleton-line home-skeleton-line--short" />
                  </div>
                ))}
              </div>
            ) : (
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
            )}
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
                      src={resolveCoverUrl(playlist.cover_url) || defaultCover}
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
      </div>
      <div hidden={activeTab !== 'history'}>
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
      </div>
    </div>
  )
}

export default Home
