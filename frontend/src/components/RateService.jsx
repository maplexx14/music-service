import { useEffect, useState } from 'react'
import { Star } from 'lucide-react'
import api from '../services/api'
import { toast } from '../store/toastStore'
import './TwoFactorSettings.css'
import './RateService.css'

const COMMENT_MAX_CHARS = 1000
const SCORE_LABELS = ['', 'Очень плохо', 'Плохо', 'Нормально', 'Хорошо', 'Отлично']

// Оценка довольства сервисом — одна на пользователя: новая заменяет прежнюю.
// Сводку видит админ в админке.
function RateService() {
  const [score, setScore] = useState(0)
  const [comment, setComment] = useState('')
  const [saved, setSaved] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.get('/feedback/rating', { skipErrorToast: true, dedupe: false })
      .then((response) => {
        if (!response.data) return
        setSaved(response.data)
        setScore(response.data.score)
        setComment(response.data.comment || '')
      })
      .catch((error) => console.error('Error loading service rating:', error))
      .finally(() => setLoading(false))
  }, [])

  const unchanged = saved && saved.score === score && (saved.comment || '') === comment.trim()

  const handleSubmit = async (event) => {
    event.preventDefault()
    if (!score || busy || unchanged) return
    setBusy(true)
    try {
      const response = await api.put('/feedback/rating', { score, comment: comment.trim() || null })
      setSaved(response.data)
      setComment(response.data.comment || '')
      toast.success('Спасибо за оценку!')
    } catch (error) {
      console.error('Error saving service rating:', error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-card">
      <div className="settings-section-title">Оценить сервис</div>
      <p className="settings-hint settings-section-hint">
        Как вам у нас? Оценку можно поменять когда угодно.
      </p>
      <form onSubmit={handleSubmit} className="twofa-form">
        <div className="rate-stars" role="radiogroup" aria-label="Оценка от 1 до 5">
          {[1, 2, 3, 4, 5].map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={score === value}
              aria-label={`${value} — ${SCORE_LABELS[value]}`}
              className={`rate-star${value <= score ? ' is-on' : ''}`}
              disabled={loading}
              onClick={() => setScore(value)}
            >
              <Star size={32} aria-hidden="true" />
            </button>
          ))}
          <span className="rate-stars-label">{SCORE_LABELS[score] || 'Выберите оценку'}</span>
        </div>
        <label className="twofa-field">
          <span>Что нравится, что мешает — по желанию</span>
          <textarea
            className="field"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            maxLength={COMMENT_MAX_CHARS}
            rows={4}
          />
        </label>
        {saved && (
          <div className="settings-hint">
            Ваша оценка: {saved.score} из 5
          </div>
        )}
        <div className="settings-prefs-actions">
          <button
            type="submit"
            className="btn btn--primary settings-save-btn"
            disabled={busy || !score || unchanged}
          >
            {busy ? 'Сохранение...' : saved ? 'Обновить оценку' : 'Отправить'}
          </button>
        </div>
      </form>
    </div>
  )
}

export default RateService
