import { Suspense, useCallback, useEffect, useLayoutEffect } from 'react'
import { unstable_HistoryRouter as HistoryRouter, Routes, Route, Navigate, Link, useLocation, useSearchParams } from 'react-router-dom'
import { useAuthStore } from './store/authStore'
import { usePlayerStore } from './store/playerStore'
import Layout from './components/Layout'
import InstallPrompt from './components/InstallPrompt'
import ImportTracker from './components/ImportTracker'
import Spinner from './components/Spinner'
import api from './services/api'
import useNowPlayingReporter from './hooks/useNowPlayingReporter'
import { createAppHistory, notifyRouteCommitted, safeNextPath } from './services/navigation'
import { lazyWithReload } from './services/staleBuild'
import { canReplayPlayerSetup, needsOnboarding, needsPlayerFlow, onboardingDestination } from './services/onboarding'
import { offerHandoff } from './services/sessionHandoff'
import Downloads from './pages/Downloads'
import { loadOfflineTracks, setOfflineLibrarySync, useOfflineTracks } from './services/offlineTracks'
import { syncOfflineLibrary } from './services/offlineLibrary'
import { useOffline } from './hooks/useOffline'

// История с анимированными переходами экранов (см. services/navigation.js).
const appHistory = createAppHistory()

// Ярлыки иконки (manifest shortcuts) при уже открытом окне: launch_handler
// focus-existing не перезагружает страницу — музыка не прерывается, — а
// нужный экран открываем сами.
if (typeof window !== 'undefined' && window.launchQueue?.setConsumer) {
  window.launchQueue.setConsumer((params) => {
    if (!params.targetURL) return
    const url = new URL(params.targetURL)
    const target = url.pathname + url.search
    if (target !== appHistory.location.pathname + appHistory.location.search) appHistory.push(target)
  })
}

const Login = lazyWithReload(() => import('./pages/Login'))
const Register = lazyWithReload(() => import('./pages/Register'))
const VerifyEmail = lazyWithReload(() => import('./pages/VerifyEmail'))
const ForgotPassword = lazyWithReload(() => import('./pages/ForgotPassword'))
const ResetPassword = lazyWithReload(() => import('./pages/ResetPassword'))
const PreferencesOnboarding = lazyWithReload(() => import('./pages/PreferencesOnboarding'))
const PlayerSetup = lazyWithReload(() => import('./pages/PlayerSetup'))
const Home = lazyWithReload(() => import('./pages/Home'))
const Search = lazyWithReload(() => import('./pages/Search'))
const Playlists = lazyWithReload(() => import('./pages/Playlists'))
const PlaylistDetail = lazyWithReload(() => import('./pages/PlaylistDetail'))
const ExternalPlaylist = lazyWithReload(() => import('./pages/ExternalPlaylist'))
const LinkPlaylist = lazyWithReload(() => import('./pages/LinkPlaylist'))
const Album = lazyWithReload(() => import('./pages/Album'))
const Artist = lazyWithReload(() => import('./pages/Artist'))
const Track = lazyWithReload(() => import('./pages/Track'))
const LikedSongs = lazyWithReload(() => import('./pages/LikedSongs'))
const UploadTrack = lazyWithReload(() => import('./pages/UploadTrack'))
const Settings = lazyWithReload(() => import('./pages/Settings'))
const Admin = lazyWithReload(() => import('./pages/Admin'))

function UploadScreen() {
  const offline = useOffline()
  if (!offline) return <UploadTrack />
  return <div className="page-container"><h1>Загрузить трек</h1><p role="status">Для загрузки трека нужен интернет.</p><Link to="/downloads" className="btn btn--secondary">Скачанные треки</Link></div>
}

// Залогиненного со страницы входа — туда, откуда его на неё отправили.
function AfterLoginRedirect() {
  const [searchParams] = useSearchParams()
  return <Navigate to={safeNextPath(searchParams)} replace />
}

function PlayerSetupRoute({ isAuthenticated, user }) {
  const [searchParams] = useSearchParams()
  const diagnosticReplay = searchParams.get('diagnostic') === '1' && canReplayPlayerSetup(user)
  if (!isAuthenticated) return <Navigate to="/login" replace />
  if (needsOnboarding(user)) return <Navigate to="/onboarding" replace />
  if (!needsPlayerFlow(user) && !diagnosticReplay) return <Navigate to="/" replace />
  return (
    <Suspense fallback={<Spinner page />}>
      <PlayerSetup key={`${user.id}:${diagnosticReplay ? 'diagnostic' : 'required'}`} diagnostic={diagnosticReplay} />
    </Suspense>
  )
}

// Онбординг нужен до завершения последнего шага. Статус общий для всех устройств.
function OnboardingGate({ user, children }) {
  const destination = onboardingDestination(user)
  return destination ? <Navigate to={destination} replace /> : children
}

// Guests use the same shell; locked pages are covered by Layout.
function GuestRoutes({ renderRoutes }) {
  const handoffPending = useAuthStore((state) => state.handoffPending)
  if (handoffPending) return <Spinner page />
  return (
    <Suspense fallback={<Spinner page />}>
      <Layout renderRoutes={renderRoutes} />
    </Suspense>
  )
}

function GuestScreenPreview({ location }) {
  return (
    <div className="guest-page-preview" inert="" aria-hidden="true">
      <Routes location={location}>
        <Route path="/" element={<Home guest />} />
        <Route path="/liked" element={<LikedSongs guest />} />
        <Route path="/playlists/*" element={<Playlists guest />} />
        <Route path="/settings/*" element={<Settings guest />} />
        <Route path="*" element={<Home guest />} />
      </Routes>
    </div>
  )
}

// Стоит после <Routes>: layout-эффекты соседей идут по порядку, так что
// сигнал уходит, когда новый экран уже закоммичен и прокручен на место.
function RouteCommitSignal() {
  const location = useLocation()
  useLayoutEffect(() => {
    notifyRouteCommitted(location.key)
  }, [location.key])
  return null
}

// «Что юзер делает» для админки (PUT /users/me/activity): экран и видна ли
// вкладка. Только путь, без query — поисковые запросы в админку не уходят.
function reportActivity(visible) {
  api
    .put(
      '/users/me/activity',
      { screen: appHistory.location.pathname, visible },
      // Уход в фон бывает перед выгрузкой — запрос должен её пережить.
      visible
        ? { skipErrorToast: true }
        : { skipErrorToast: true, adapter: 'fetch', fetchOptions: { keepalive: true } },
    )
    .catch(() => {})
}

// Смена экрана. С задержкой: пролистанные на пути экраны админке не нужны.
const ACTIVITY_ROUTE_DELAY_MS = 1500

function ActivityRouteSignal({ enabled }) {
  const { pathname } = useLocation()
  useEffect(() => {
    if (!enabled || document.hidden) return undefined
    const timer = window.setTimeout(() => reportActivity(true), ACTIVITY_ROUTE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [enabled, pathname])
  return null
}

function App() {
  const { isAuthenticated, user } = useAuthStore()
  const offlineReady = useOfflineTracks((state) => state.ready)
  const offline = useOffline()
  useLayoutEffect(() => {
    if (!isAuthenticated || !offline) return
    if (offlineReady) usePlayerStore.getState().restrictToOfflineLibrary()
    usePlayerStore.getState().closeFullScreen()
  }, [offline, isAuthenticated, offlineReady])
  useEffect(() => {
    const sync = () => syncOfflineLibrary(api).catch(() => {})
    const stop = setOfflineLibrarySync(sync)
    loadOfflineTracks(isAuthenticated ? user?.id : null).then(sync)
    window.addEventListener('online', sync)
    return () => { stop(); window.removeEventListener('online', sync) }
  }, [isAuthenticated, user?.id])
  useLayoutEffect(() => {
    if (!isAuthenticated) {
      usePlayerStore.getState().clearQueue()
      usePlayerStore.setState({ likedTrackIds: [], dislikedTrackIds: [], dislikedTrackKeys: [], pendingLikeKeys: [], likedTracksLoaded: false, dislikedTracksLoaded: false, flowPreload: null, flowPreview: null })
    }
    usePlayerStore.setState({ guestMode: !isAuthenticated })
  }, [isAuthenticated])

  useEffect(() => {
    if (!isAuthenticated) return undefined
    let wasVisible = !document.hidden
    const heartbeat = () => {
      // Только на экране. С погашенным экраном на мобильной сети каждый запрос
      // посреди трека будит модем на ~5–10 с, а онлайн слушателя в фоне
      // админка видит по играющему now-playing (бэкенд _online_user_ids).
      // Уход в фон — одно событие, чтобы админка видела «свернул(а)».
      if (document.hidden) {
        if (wasVisible) reportActivity(false)
        wasVisible = false
        return
      }
      wasVisible = true
      // Он же держит presence-маркер онлайна (любой авторизованный запрос).
      reportActivity(true)
      // Приложение (особенно PWA) держат открытым неделями — продлеваем
      // сессию и без перезапуска; чаще раза в несколько часов не ходит.
      useAuthStore.getState().renewToken()
    }
    heartbeat()
    const interval = window.setInterval(heartbeat, 60000)
    // Вернулись на экран — отмечаемся сразу, не дожидаясь тика.
    document.addEventListener('visibilitychange', heartbeat)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', heartbeat)
    }
  }, [isAuthenticated])
  useNowPlayingReporter(isAuthenticated)
  // Safari на iOS: готовим вход для приложения на экране «Домой».
  useEffect(() => {
    if (isAuthenticated) offerHandoff()
  }, [isAuthenticated])

  // Маршруты одного экрана стека (components/ScreenStack.jsx): каждый экран
  // рендерит свою локацию — скрытая вкладка остаётся на своём пути. Suspense
  // внутри экрана: при подгрузке чанка оболочка (меню, плеер) стоит на месте.
  const isAdmin = !!user?.is_admin
  const renderScreenRoutes = useCallback(
    (location) => !isAuthenticated && location.pathname !== '/search' ? <GuestScreenPreview location={location} /> : (
      <Routes location={location}>
        <Route path="/" element={<Home />} />
        <Route path="/search" element={<Search guest={!isAuthenticated} />} />
        <Route path="/playlists" element={<Playlists />} />
        <Route path="/downloads" element={<Downloads />} />
        <Route path="/playlists/:id" element={<PlaylistDetail />} />
        <Route path="/external/soundcloud/playlists/:id" element={<ExternalPlaylist />} />
        <Route path="/link" element={<LinkPlaylist />} />
        <Route path="/albums/:source/:id" element={<Album />} />
        <Route path="/artists/:name" element={<Artist />} />
        <Route path="/track/:id" element={<Track />} />
        <Route path="/liked" element={<LikedSongs />} />
        <Route path="/upload" element={<UploadScreen />} />
        {/* Один маршрут на меню и разделы: страница не размонтируется при
            переходах, и несохранённые предпочтения не теряются. */}
        <Route path="/settings/:section?" element={<Settings />} />
        <Route path="/admin" element={isAdmin ? <Admin /> : <Navigate to="/" />} />
      </Routes>
    ),
    [isAdmin, isAuthenticated],
  )
  return (
    // v7_startTransition: переход на вкладку, чей чанк ещё грузится, держит
    // прежнюю страницу на экране вместо вспышки спиннера на месте контента.
    <HistoryRouter history={appHistory} future={{ v7_startTransition: true }}>
      <Routes>
        <Route
          path="/login"
          element={
            !isAuthenticated ? (
              <Suspense fallback={<Spinner page />}>
                <Login />
              </Suspense>
            ) : (
              <AfterLoginRedirect />
            )
          }
        />
        <Route
          path="/forgot-password"
          element={
            !isAuthenticated ? (
              <Suspense fallback={<Spinner page />}><ForgotPassword /></Suspense>
            ) : (
              <Navigate to="/" />
            )
          }
        />
        <Route
          path="/reset-password"
          element={
            <Suspense fallback={<Spinner page />}><ResetPassword /></Suspense>
          }
        />
        <Route
          path="/register"
          element={
            !isAuthenticated ? (
              <Suspense fallback={<Spinner page />}>
                <Register />
              </Suspense>
            ) : (
              <Navigate to="/" />
            )
          }
        />
        {/* Доступен и залогиненным, и нет: юзер приходит по ссылке из письма. */}
        <Route
          path="/verify-email"
          element={
            <Suspense fallback={<Spinner page />}>
              <VerifyEmail />
            </Suspense>
          }
        />
        <Route
          path="/onboarding"
          element={
            isAuthenticated ? (
              !needsOnboarding(user) ? (
                <Navigate to={onboardingDestination(user) || '/'} replace />
              ) : (
                <Suspense fallback={<Spinner page />}>
                  <PreferencesOnboarding />
                </Suspense>
              )
            ) : (
              <Navigate to="/login" />
            )
          }
        />
        <Route
          path="/onboarding/player"
          element={<PlayerSetupRoute isAuthenticated={isAuthenticated} user={user} />}
        />
        <Route
          path="/*"
          element={
            isAuthenticated ? (
              <OnboardingGate user={user}>
                <Layout renderRoutes={renderScreenRoutes} />
              </OnboardingGate>
            ) : (
              <GuestRoutes renderRoutes={renderScreenRoutes} />
            )
          }
        />
      </Routes>
      <RouteCommitSignal />
      {/* Установка не перекрывает музыкальный онбординг и распаковку. */}
      {!onboardingDestination(user) && <InstallPrompt />}
      <ActivityRouteSignal enabled={isAuthenticated} />
      <ImportTracker enabled={isAuthenticated} />
    </HistoryRouter>
  )
}

export default App
