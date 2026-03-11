import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ChevronLeft } from 'lucide-react'
import api from '../services/api'
import './LikedArtists.css'

function LikedArtists() {
    const [likedArtists, setLikedArtists] = useState([])
    const [loading, setLoading] = useState(true)
    const navigate = useNavigate()

    useEffect(() => {
        fetchLikedArtists()
    }, [])

    const fetchLikedArtists = async () => {
        try {
            const res = await api.get('/users/me/liked/artists')
            setLikedArtists(res.data)
        } catch (error) {
            console.error('Error fetching liked artists:', error)
        } finally {
            setLoading(false)
        }
    }

    if (loading) {
        return (
            <div className="page-container">
                <div className="loading">Загрузка...</div>
            </div>
        )
    }

    return (
        <div className="page-container liked-artists-page">
            <header className="page-header">
                <button className="back-btn" onClick={() => navigate(-1)}>
                    <ChevronLeft size={24} />
                </button>
                <h1>Исполнители</h1>
            </header>

            <section className="liked-artists-section">
                <h2 className="section-subtitle">Вам понравились</h2>
                <div className="liked-artists-grid">
                    {likedArtists.map(artist => (
                        <Link key={artist.artist_id} to={`/artist/${artist.artist_id}`} className="liked-artist-card">
                            <div className="artist-avatar-wrap">
                                {artist.avatar_url ? (
                                    <img src={artist.avatar_url} alt={artist.artist_name} className="artist-avatar" />
                                ) : (
                                    <div className="artist-avatar placeholder">{artist.artist_name[0].toUpperCase()}</div>
                                )}
                            </div>
                            <div className="artist-info">
                                <span className="artist-name">{artist.artist_name}</span>
                                <span className="artist-type">Исполнитель</span>
                            </div>
                        </Link>
                    ))}
                    {likedArtists.length === 0 && (
                        <div className="empty-state">У вас пока нет любимых исполнителей</div>
                    )}
                </div>
            </section>
        </div>
    )
}

export default LikedArtists
