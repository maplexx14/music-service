import { lazy, Suspense, useEffect, useLayoutEffect } from 'react'
import { unstable_HistoryRouter as HistoryRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { useAuthStore } from './store/authStore'
import Layout from './components/Layout'
import Spinner from './components/Spinner'
import api from './services/api'
import { createAppHistory, notifyRouteCommitted } from './services/navigation'

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

const Login = lazy(() => import('./pages/Login'))
const Register = lazy(() => import('./pages/Register'))
const VerifyEmail = lazy(() => import('./pages/VerifyEmail'))
const ForgotPassword = lazy(() => import('./pages/ForgotPassword'))
const ResetPassword = lazy(() => import('./pages/ResetPassword'))
const PreferencesOnboarding = lazy(() => import('./pages/PreferencesOnboarding'))
const Home = lazy(() => import('./pages/Home'))
const Search = lazy(() => import('./pages/Search'))
const Playlists = lazy(() => import('./pages/Playlists'))
const PlaylistDetail = lazy(() => import('./pages/PlaylistDetail'))
const ExternalPlaylist = lazy(() => import('./pages/ExternalPlaylist'))
const Album = lazy(() => import('./pages/Album'))
const Artist = lazy(() => import('./pages/Artist'))
const LikedSongs = lazy(() => import('./pages/LikedSongs'))
const UploadTrack = lazy(() => import('./pages/UploadTrack'))
const Settings = lazy(() => import('./pages/Settings'))
const Admin = lazy(() => import('./pages/Admin'))

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

  return (
    // v7_startTransition: переход на вкладку, чей чанк ещё грузится, держит
    // прежнюю страницу на экране вместо вспышки спиннера на месте контента.
    <HistoryRouter history={appHistory} future={{ v7_startTransition: true }}>
      <Routes>
        <Route
          path="/login"
          element={
            !isAuthenticated ? (
              <Suspense fallback={<Spinner />}>
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
              <Suspense fallback={<Spinner />}><ForgotPassword /></Suspense>
            ) : (
              <Navigate to="/" />
            )
          }
        />
        <Route
          path="/reset-password"
          element={
            <Suspense fallback={<Spinner />}><ResetPassword /></Suspense>
          }
        />
        <Route
          path="/register"
          element={
            !isAuthenticated ? (
              <Suspense fallback={<Spinner />}>
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
            <Suspense fallback={<Spinner />}>
              <VerifyEmail />
            </Suspense>
          }
        />
        <Route
          path="/onboarding"
          element={
            isAuthenticated ? (
              <Suspense fallback={<Spinner />}>
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
                <Suspense fallback={<Spinner />}>
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
                    <Route path="/settings" element={<Settings />} />
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
