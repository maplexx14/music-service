import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom'
import { useAuthStore } from './store/authStore'
import Login from './pages/Login'
import Register from './pages/Register'
import Home from './pages/Home'
import Search from './pages/Search'
import Playlists from './pages/Playlists'
import PlaylistDetail from './pages/PlaylistDetail'
import LikedSongs from './pages/LikedSongs'
import LikedSongsDetail from './pages/LikedSongsDetail'
import UploadTrack from './pages/UploadTrack'
import Settings from './pages/Settings'
import Admin from './pages/Admin'
import Artist from './pages/Artist'
import LikedArtists from './pages/LikedArtists'
import SharedPlaylist from './pages/SharedPlaylist'
import Layout from './components/Layout'

function App() {
  const { isAuthenticated } = useAuthStore()

  return (
    <Router>
      <Routes>
        <Route path="/login" element={!isAuthenticated ? <Login /> : <Navigate to="/" />} />
        <Route path="/register" element={!isAuthenticated ? <Register /> : <Navigate to="/" />} />
        <Route
          path="/*"
          element={
            isAuthenticated ? (
              <Layout>
                <Routes>
                  <Route path="/" element={<Home />} />
                  <Route path="/search" element={<Search />} />
                  <Route path="/playlists" element={<Playlists />} />
                  <Route path="/playlists/:id" element={<PlaylistDetail />} />
                  <Route path="/shared/:uuid" element={<SharedPlaylist />} />
                  <Route path="/artist/:id" element={<Artist />} />
                  <Route path="/liked" element={<LikedSongs />} />
                  <Route path="/liked-all" element={<LikedSongsDetail />} />
                  <Route path="/liked/artists" element={<LikedArtists />} />
                  <Route path="/upload" element={<UploadTrack />} />
                  <Route path="/settings" element={<Settings />} />
                  <Route path="/admin" element={<Admin />} />
                </Routes>
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
