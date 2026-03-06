import { useState, useEffect } from 'react'
import { useParams, useLocation } from 'react-router-dom'
import { usePlayerStore } from '../store/playerStore'
import { Play, Heart, BellOff, MoreHorizontal, ChevronRight } from 'lucide-react'
import api from '../services/api'
import defaultCover from '../assets/default-cover.svg'
import { resolveCoverUrl } from '../utils/media'
import './Artist.css'

function Artist() {
    const { id } = useParams()
    const location = useLocation()
    const [artist, setArtist] = useState(null)
    const [tracks, setTracks] = useState([])
    const [loading, setLoading] = useState(true)
    const [isLiked, setIsLiked] = useState(false)
    const { playTrack, playPlaylist } = usePlayerStore()

    useEffect(() => {
        fetchArtistData()
    }, [id])

    const fetchArtistData = async () => {
        setLoading(true)
        try {
            const decodedId = decodeURIComponent(id)
            const isNumericId = !isNaN(decodedId) && !isNaN(parseFloat(decodedId))

            let searchName = decodedId;
            const stateArtistName = location.state?.artistName

            if (isNumericId && !stateArtistName) {
                // 1. Fetch user (artist) info if it's a real user ID
                const userRes = await api.get(`/users/${decodedId}`)
                const userData = userRes.data
                setArtist(userData)
                searchName = userData.full_name || userData.username
            } else {
                // Use the passed original name or fallback to the decode
                searchName = stateArtistName || decodedId

                // Mock user for simulated artist
                setArtist({
                    username: searchName,
                    full_name: searchName,
                    avatar_url: null
                })
            }

            // 2. Fetch tracks where artist name matches user's full_name or username
            const tracksRes = await api.get('/tracks', {
                params: { artist: searchName, limit: 10 },
            })
            setTracks(tracksRes.data)

            // 3. Check if artist is liked
            checkIfLiked(decodedId, stateArtistName || searchName)
        } catch (error) {
            console.error('Error fetching artist data:', error)
        } finally {
            setLoading(false)
        }
    }

    const checkIfLiked = async (artistId, artistName) => {
        try {
            const res = await api.get('/users/me/liked/artists')
            const likedList = res.data
            const found = likedList.some(item => item.artist_id === artistId || item.artist_name === artistName)
            setIsLiked(found)
        } catch (error) {
            console.error('Error checking liked status:', error)
        }
    }

    const handleToggleLike = async () => {
        try {
            if (isLiked) {
                await api.delete(`/users/me/liked/artists/${id}`)
                setIsLiked(false)
            } else {
                await api.post('/users/me/liked/artists', {
                    artist_id: id,
                    artist_name: artist.full_name || artist.username,
                    avatar_url: artist.avatar_url
                })
                setIsLiked(true)
            }
        } catch (error) {
            console.error('Error toggling like:', error)
        }
    }

    const handlePlayAll = () => {
        if (tracks.length > 0) {
            playPlaylist(tracks, 0)
        }
    }

    const handlePlayTrack = (track, index) => {
        playPlaylist(tracks, index)
    }

    const formatTime = (seconds) => {
        if (!seconds || isNaN(seconds)) return '0:00'
        const mins = Math.floor(seconds / 60)
        const secs = Math.floor(seconds % 60)
        return `${mins}:${secs.toString().padStart(2, '0')}`
    }

    if (loading) {
        return (
            <div className="page-container">
                <div className="loading">Загрузка...</div>
            </div>
        )
    }

    if (!artist) {
        return (
            <div className="page-container">
                <div className="no-results">Исполнитель не найден</div>
            </div>
        )
    }

    return (
        <div className="page-container artist-page">
            {/* ===== HEADER ===== */}
            <div className="artist-header">
                <div className="artist-cover-container">
                    {artist.avatar_url ? (
                        <img src={artist.avatar_url} alt={artist.username} className="artist-cover" />
                    ) : (
                        <div className="artist-cover placeholder">{artist.username[0].toUpperCase()}</div>
                    )}
                </div>
                <div className="artist-info">
                    <span className="artist-badge">Исполнитель</span>
                    <h1 className="artist-name">{artist.full_name || artist.username}</h1>
                    <div className="artist-stats">
                        {/* Stub for listeners count since it's not in DB yet */}
                        <span className="listeners-count">44 496 слушателей в месяц</span>
                    </div>

                    <div className="artist-actions">
                        <button className="artist-btn primary" onClick={handlePlayAll}>
                            <Play size={20} fill="currentColor" />
                            <span>Слушать</span>
                        </button>
                        <button className="artist-icon-btn" onClick={handleToggleLike}>
                            <Heart size={20} fill={isLiked ? "var(--color-accent)" : "none"} color={isLiked ? "var(--color-accent)" : "currentColor"} />
                        </button>
                        <button className="artist-icon-btn">
                            <MoreHorizontal size={20} />
                        </button>
                    </div>
                </div>
            </div>

            {/* ===== CONTENT GRID ===== */}
            <div className="artist-content-grid single-column">
                <section className="artist-popular-tracks">
                    <div className="section-header">
                        <h2 onClick={handlePlayAll}>Треки <ChevronRight size={24} className="chevron-icon" /></h2>
                    </div>
                    <div className="tracks-list-compact">
                        {tracks.length > 0 ? (
                            tracks.map((track, index) => (
                                <div
                                    key={track.id}
                                    className="artist-track-item"
                                    onClick={() => handlePlayTrack(track, index)}
                                >
                                    <img
                                        src={resolveCoverUrl(track.cover_url) || defaultCover}
                                        alt={track.title}
                                        className="artist-track-cover"
                                    />
                                    <div className="artist-track-info">
                                        <div className="artist-track-title">{track.title}</div>
                                        <div className="artist-track-artist">{track.artist}</div>
                                    </div>
                                    <div className="artist-track-trailing">
                                        <Heart size={18} className="trailing-icon heart-icon" />
                                        <span className="trailing-time">{formatTime(track.duration)}</span>
                                    </div>
                                </div>
                            ))
                        ) : (
                            <div className="no-tracks">У исполнителя пока нет треков</div>
                        )}
                    </div>
                </section>
            </div>
        </div>
    )
}

export default Artist
