import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import api from '../services/api'

function SharedPlaylist() {
  const { uuid } = useParams()
  const navigate = useNavigate()
  const [error, setError] = useState(false)

  useEffect(() => {
    api.get(`/playlists/shared/${uuid}`)
      .then(res => {
        navigate(`/playlists/${res.data.id}`, { replace: true })
      })
      .catch(() => setError(true))
  }, [uuid, navigate])

  if (error) {
    return (
      <div className="page-container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '40vh' }}>
        <div style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
          <p style={{ fontSize: 18, marginBottom: 8 }}>Плейлист не найден</p>
          <p style={{ fontSize: 14 }}>Возможно, ссылка устарела или плейлист был удалён</p>
        </div>
      </div>
    )
  }

  return (
    <div className="page-container">
      <div className="loading">Загрузка...</div>
    </div>
  )
}

export default SharedPlaylist
