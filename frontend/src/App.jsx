import { lazy, Suspense, useEffect } from 'react'
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom'
import { useAuthStore } from './store/authStore'
import Layout from './components/Layout'
import Spinner from './components/Spinner'
import api from './services/api'

const Login = lazy(() => import('./pages/Login'))
const Register = lazy(() => import('./pages/Register'))
const VerifyEmail = lazy(() => import('./pages/VerifyEmail'))
const PreferencesOnboarding = lazy(() => import('./pages/PreferencesOnboarding'))
const Home = lazy(() => import('./pages/Home'))
const Search = lazy(() => import('./pages/Search'))
const Playlists = lazy(() => import('./pages/Playlists'))
const PlaylistDetail = lazy(() => import('./pages/PlaylistDetail'))
const ExternalPlaylist = lazy(() => import('./pages/ExternalPlaylist'))
const Artist = lazy(() => import('./pages/Artist'))
const LikedSongs = lazy(() => import('./pages/LikedSongs'))
const UploadTrack = lazy(() => import('./pages/UploadTrack'))
const Settings = lazy(() => import('./pages/Settings'))
const Admin = lazy(() => import('./pages/Admin'))

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
    <Router>
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
    </Router>
  )
}

export default App
