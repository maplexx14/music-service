import { Suspense, useCallback, useEffect, useLayoutEffect } from 'react'
import { unstable_HistoryRouter as HistoryRouter, Routes, Route, Navigate, useLocation, useSearchParams } from 'react-router-dom'
import { useAuthStore } from './store/authStore'
import Layout from './components/Layout'
import Spinner from './components/Spinner'
import api from './services/api'
import useNowPlayingReporter from './hooks/useNowPlayingReporter'
import { createAppHistory, notifyRouteCommitted, safeNextPath } from './services/navigation'
import { lazyWithReload } from './services/staleBuild'

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
const Home = lazyWithReload(() => import('./pages/Home'))
const Search = lazyWithReload(() => import('./pages/Search'))
const Playlists = lazyWithReload(() => import('./pages/Playlists'))
const PlaylistDetail = lazyWithReload(() => import('./pages/PlaylistDetail'))
const ExternalPlaylist = lazyWithReload(() => import('./pages/ExternalPlaylist'))
const Album = lazyWithReload(() => import('./pages/Album'))
const Artist = lazyWithReload(() => import('./pages/Artist'))
const Track = lazyWithReload(() => import('./pages/Track'))
const LikedSongs = lazyWithReload(() => import('./pages/LikedSongs'))
const UploadTrack = lazyWithReload(() => import('./pages/UploadTrack'))
const Settings = lazyWithReload(() => import('./pages/Settings'))
const Admin = lazyWithReload(() => import('./pages/Admin'))

// Экраны основной навигации качаем в простое после входа: переход на экран,
// чей чанк ещё в сети, стоял бы до таймаута и въезжал спиннером.
const PRELOADED_SCREENS = [Home, Search, Playlists, PlaylistDetail, ExternalPlaylist, Album, Artist, LikedSongs, Settings]

function preloadScreensWhenIdle() {
  const run = () => PRELOADED_SCREENS.forEach((screen) => screen.preload())
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(run, { timeout: 4000 })
    return () => window.cancelIdleCallback(id)
  }
  const timer = window.setTimeout(run, 1500)
  return () => window.clearTimeout(timer)
}

// Залогиненного со страницы входа — туда, откуда его на неё отправили.
function AfterLoginRedirect() {
  const [searchParams] = useSearchParams()
  return <Navigate to={safeNextPath(searchParams)} replace />
}

// Незалогиненного — на вход, запомнив адрес: ссылка на трек из «Поделиться»
// после входа должна открыть трек, а не главную.
function LoginRedirect() {
  const location = useLocation()
  const target = location.pathname + location.search
  return <Navigate to={target === '/' ? '/login' : `/login?next=${encodeURIComponent(target)}`} replace />
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

function App() {
  const { isAuthenticated, user } = useAuthStore()

  useEffect(() => {
    if (!isAuthenticated) return undefined
    const heartbeat = () => api.get('/users/me', { skipErrorToast: true, dedupe: false }).catch(() => {})
    heartbeat()
    const interval = window.setInterval(heartbeat, 60000)
    return () => window.clearInterval(interval)
  }, [isAuthenticated])
  useNowPlayingReporter(isAuthenticated)

  // Маршруты одного экрана стека (components/ScreenStack.jsx): каждый экран
  // рендерит свою локацию — скрытая вкладка остаётся на своём пути. Suspense
  // внутри экрана: при подгрузке чанка оболочка (меню, плеер) стоит на месте.
  const isAdmin = !!user?.is_admin
  const renderScreenRoutes = useCallback(
    (location) => (
      <Routes location={location}>
        <Route path="/" element={<Home />} />
        <Route path="/search" element={<Search />} />
        <Route path="/playlists" element={<Playlists />} />
        <Route path="/playlists/:id" element={<PlaylistDetail />} />
        <Route path="/external/soundcloud/playlists/:id" element={<ExternalPlaylist />} />
        <Route path="/albums/:source/:id" element={<Album />} />
        <Route path="/artists/:name" element={<Artist />} />
        <Route path="/track/:id" element={<Track />} />
        <Route path="/liked" element={<LikedSongs />} />
        <Route path="/upload" element={<UploadTrack />} />
        {/* Один маршрут на меню и разделы: страница не размонтируется при
            переходах, и несохранённые предпочтения не теряются. */}
        <Route path="/settings/:section?" element={<Settings />} />
        <Route path="/admin" element={isAdmin ? <Admin /> : <Navigate to="/" />} />
      </Routes>
    ),
    [isAdmin],
  )
  useEffect(() => (isAuthenticated ? preloadScreensWhenIdle() : undefined), [isAuthenticated])

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
              <Suspense fallback={<Spinner page />}>
                <PreferencesOnboarding />
              </Suspense>
            ) : (
              <Navigate to="/login" />
            )
          }
        />
        <Route
          path="/*"
          element={
            isAuthenticated ? (
              <Layout renderRoutes={renderScreenRoutes} />
            ) : (
              <LoginRedirect />
            )
          }
        />
      </Routes>
      <RouteCommitSignal />
    </HistoryRouter>
  )
}

export default App
