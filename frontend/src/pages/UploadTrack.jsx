import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Upload, Music, X } from 'lucide-react'
import api from '../services/api'
import './UploadTrack.css'

function UploadTrack() {
  const [file, setFile] = useState(null)
  const [coverFile, setCoverFile] = useState(null)
  const [formData, setFormData] = useState({
    title: '',
    artist: '',
    album: '',
    genre: '',
    duration: '',
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)
  const navigate = useNavigate()

  const handleFileChange = (e) => {
    const selectedFile = e.target.files[0]
    if (selectedFile) {
      // Check file type
      const allowedTypes = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/flac', 'audio/m4a', 'audio/ogg', 'audio/aac']
      const fileExt = selectedFile.name.split('.').pop().toLowerCase()
      const allowedExts = ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'aac']

      if (!allowedExts.includes(fileExt)) {
        setError('Неподдерживаемый формат файла. Разрешены: MP3, WAV, FLAC, M4A, OGG, AAC')
        return
      }

      setFile(selectedFile)
      setError('')

      // Try to extract metadata from filename
      if (!formData.title && !formData.artist) {
        const filename = selectedFile.name.replace(/\.[^/.]+$/, '')
        // Try to parse "Artist - Title" format
        if (filename.includes(' - ')) {
          const parts = filename.split(' - ')
          if (parts.length >= 2) {
            setFormData(prev => ({
              ...prev,
              artist: parts[0].trim(),
              title: parts.slice(1).join(' - ').trim(),
            }))
          }
        } else {
          setFormData(prev => ({
            ...prev,
            title: filename,
          }))
        }
      }

      // Try to extract audio duration using browser Audio API
      const objectUrl = URL.createObjectURL(selectedFile)
      const audio = new Audio(objectUrl)
      audio.addEventListener('loadedmetadata', () => {
        setFormData(prev => ({ ...prev, duration: Math.round(audio.duration).toString() }))
        URL.revokeObjectURL(objectUrl)
      })
      audio.addEventListener('error', () => {
        URL.revokeObjectURL(objectUrl)
      })
    }
  }

  const handleCoverChange = (e) => {
    const selectedFile = e.target.files[0]
    if (!selectedFile) return
    const fileExt = selectedFile.name.split('.').pop().toLowerCase()
    const allowedExts = ['jpg', 'jpeg', 'png', 'webp']
    if (!allowedExts.includes(fileExt)) {
      setError('Неподдерживаемый формат обложки. Разрешены: JPG, PNG, WEBP')
      return
    }
    setCoverFile(selectedFile)
    setError('')
  }

  const handleInputChange = (e) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value,
    })
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setSuccess(false)

    if (!file) {
      setError('Выберите файл для загрузки')
      return
    }

    if (!formData.title || !formData.artist) {
      setError('Заполните название трека и исполнителя')
      return
    }

    setLoading(true)

    try {
      const uploadFormData = new FormData()
      uploadFormData.append('file', file)
      if (coverFile) {
        uploadFormData.append('cover', coverFile)
      }
      uploadFormData.append('title', formData.title)
      uploadFormData.append('artist', formData.artist)
      if (formData.album) {
        uploadFormData.append('album', formData.album)
      }
      if (formData.genre) {
        uploadFormData.append('genre', formData.genre)
      }
      if (formData.duration) {
        uploadFormData.append('duration', parseInt(formData.duration))
      }

      const response = await api.post('/tracks/upload', uploadFormData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      })

      setSuccess(true)
      setTimeout(() => {
        navigate('/')
      }, 2000)
    } catch (err) {
      setError(err.response?.data?.detail || 'Ошибка при загрузке файла')
    } finally {
      setLoading(false)
    }
  }

  const handleRemoveFile = () => {
    setFile(null)
    setCoverFile(null)
    setFormData({
      title: '',
      artist: '',
      album: '',
      genre: '',
      duration: '',
    })
  }

  return (
    <div className="page-container">
      <div className="upload-header">
        <h1>Загрузить трек</h1>
        <p>Добавьте свою музыку в библиотеку</p>
      </div>

      <form onSubmit={handleSubmit} className="upload-form">
        {error && (
          <div className="error-message">
            {error}
          </div>
        )}

        {success && (
          <div className="success-message">
            Трек успешно загружен! Перенаправление...
          </div>
        )}

        <div className="upload-section">
          <label htmlFor="file-upload" className="file-upload-label">
            <div className="file-upload-box">
              {file ? (
                <div className="file-selected">
                  <Music size={48} />
                  <div className="file-info">
                    <div className="file-name">{file.name}</div>
                    <div className="file-size">
                      {(file.size / 1024 / 1024).toFixed(2)} MB
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleRemoveFile}
                    className="remove-file-btn"
                  >
                    <X size={20} />
                  </button>
                </div>
              ) : (
                <>
                  <Upload size={48} />
                  <div className="upload-text">
                    <span>Нажмите для выбора файла</span>
                    <span className="upload-hint">или перетащите файл сюда</span>
                  </div>
                  <div className="upload-formats">
                    Поддерживаемые форматы: MP3, WAV, FLAC, M4A, OGG, AAC
                  </div>
                </>
              )}
            </div>
            <input
              id="file-upload"
              type="file"
              accept="audio/*"
              onChange={handleFileChange}
              className="file-input"
            />
          </label>
        </div>

        <div className="upload-section">
          <label htmlFor="cover-upload" className="file-upload-label">
            <div className="file-upload-box">
              {coverFile ? (
                <div className="file-selected">
                  <Music size={48} />
                  <div className="file-info">
                    <div className="file-name">{coverFile.name}</div>
                    <div className="file-size">
                      {(coverFile.size / 1024 / 1024).toFixed(2)} MB
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setCoverFile(null)}
                    className="remove-file-btn"
                  >
                    <X size={20} />
                  </button>
                </div>
              ) : (
                <>
                  <Upload size={48} />
                  <div className="upload-text">
                    <span>Добавить обложку (необязательно)</span>
                    <span className="upload-hint">JPG, PNG, WEBP</span>
                  </div>
                </>
              )}
            </div>
            <input
              id="cover-upload"
              type="file"
              accept="image/*"
              onChange={handleCoverChange}
              className="file-input"
            />
          </label>
        </div>

        <div className="form-fields">
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="title">Название трека *</label>
              <input
                id="title"
                name="title"
                type="text"
                value={formData.title}
                onChange={handleInputChange}
                required
                placeholder="Название трека"
              />
            </div>

            <div className="form-group">
              <label htmlFor="artist">Исполнитель *</label>
              <input
                id="artist"
                name="artist"
                type="text"
                value={formData.artist}
                onChange={handleInputChange}
                required
                placeholder="Имя исполнителя"
              />
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="album">Альбом</label>
              <input
                id="album"
                name="album"
                type="text"
                value={formData.album}
                onChange={handleInputChange}
                placeholder="Название альбома"
              />
            </div>

            <div className="form-group">
              <label htmlFor="genre">Жанр</label>
              <input
                id="genre"
                name="genre"
                type="text"
                value={formData.genre}
                onChange={handleInputChange}
                placeholder="Жанр"
              />
            </div>
          </div>

          <div className="form-group">
            <label htmlFor="duration">Длительность (секунды)</label>
            <input
              id="duration"
              name="duration"
              type="number"
              value={formData.duration}
              onChange={handleInputChange}
              placeholder="180"
              min="1"
            />
            <small>Оставьте пустым для автоматического определения</small>
          </div>
        </div>

        <div className="form-actions">
          <button
            type="button"
            onClick={() => navigate('/')}
            className="cancel-btn"
            disabled={loading}
          >
            Отмена
          </button>
          <button
            type="submit"
            className="submit-btn"
            disabled={loading || !file}
          >
            {loading ? 'Загрузка...' : 'Загрузить трек'}
          </button>
        </div>
      </form>
    </div>
  )
}

export default UploadTrack
