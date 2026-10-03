import { Suspense, useEffect, useLayoutEffect } from 'react'
import { unstable_HistoryRouter as HistoryRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { useAuthStore } from './store/authStore'
import Layout from './components/Layout'
import Spinner from './components/Spinner'
import api from './services/api'
import useNowPlayingReporter from './hooks/useNowPlayingReporter'
import { createAppHistory, notifyRouteCommitted } from './services/navigation'
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
              <Navigate to="/" />
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
              <Layout>
                {/* Suspense внутри Layout: при подгрузке lazy-чанка оболочка (меню, плеер) остаётся на месте. */}
                <Suspense fallback={<Spinner page />}>
                  <Routes>
                    <Route path="/" element={<Home />} />
                    <Route path="/search" element={<Search />} />
                    <Route path="/playlists" element={<Playlists />} />
                    <Route path="/playlists/:id" element={<PlaylistDetail />} />
                    <Route path="/external/soundcloud/playlists/:id" element={<ExternalPlaylist />} />
                    <Route path="/albums/:source/:id" element={<Album />} />
                    <Route path="/artists/:name" element={<Artist />} />
                    <Route path="/liked" element={<LikedSongs />} />
                    <Route path="/upload" element={<UploadTrack />} />
                    {/* Один маршрут на меню и разделы: страница не размонтируется при
                        переходах, и несохранённые предпочтения не теряются. */}
                    <Route path="/settings/:section?" element={<Settings />} />
                    <Route path="/admin" element={user?.is_admin ? <Admin /> : <Navigate to="/" />} />
                  </Routes>
                </Suspense>
              </Layout>
            ) : (
              <Navigate to="/login" />
            )
          }
        />
      </Routes>
      <RouteCommitSignal />
    </HistoryRouter>
  )
}

export default App
