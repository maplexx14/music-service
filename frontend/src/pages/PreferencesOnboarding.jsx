import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import PreferencePicker from '../components/PreferencePicker'
import './PreferencesOnboarding.css'

/**
 * Необязательный экран выбора любимых жанров и артистов после регистрации.
 * Можно пропустить и заполнить позже в настройках.
 */
function PreferencesOnboarding() {
  const navigate = useNavigate()
  const { updatePreferences } = useAuthStore()
  const [value, setValue] = useState({ genres: [], artists: [] })
  const [saving, setSaving] = useState(false)

  const total = value.genres.length + value.artists.length

  const handleSave = async () => {
    setSaving(true)
    await updatePreferences(value.genres, value.artists)
    setSaving(false)
    navigate('/')
  }

  const handleSkip = () => navigate('/')

  return (
    <div className="onboarding-container">
      <div className="onboarding-card">
        <div className="onboarding-header">
          <h1>Что вы любите слушать?</h1>
          <p>
            Выберите жанры и артистов — и мы соберём поток под ваш вкус. Это
            можно изменить в любой момент в настройках.
          </p>
        </div>

        <PreferencePicker value={value} onChange={setValue} />

        <div className="onboarding-actions">
          <button
            type="button"
            className="onboarding-skip"
            onClick={handleSkip}
            disabled={saving}
          >
            Пропустить
          </button>
          <button
            type="button"
            className="onboarding-save"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? 'Сохранение...' : total > 0 ? `Продолжить (${total})` : 'Продолжить'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default PreferencesOnboarding
