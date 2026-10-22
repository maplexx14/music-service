import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Star, X } from 'lucide-react'
import api from '../services/api'
import { useAuthStore } from '../store/authStore'
import './InstallPrompt.css'
import './RateService.css'

const FIRST_SEEN_KEY = 'rate-prompt-first-seen-at'
const DISMISSED_KEY = 'rate-prompt-dismissed-at'
const DAY_MS = 24 * 60 * 60 * 1000
// Спрашиваем того, кто успел распробовать: не раньше двух дней с первого
// захода на этом устройстве и не с порога сессии — после десяти минут.
const MIN_AGE_MS = 2 * DAY_MS
const SHOW_DELAY_MS = 10 * 60 * 1000
// После «Не сейчас» снова спросим через месяц.
const REPEAT_AFTER_MS = 30 * DAY_MS
// Спасибо после оценки висит недолго и уходит само.
const THANKS_MS = 8000

function readTime(key) {
  try {
    return Number(localStorage.getItem(key)) || 0
  } catch {
    return 0
  }
}

function writeTime(key) {
  try {
    localStorage.setItem(key, String(Date.now()))
  } catch {
    // Приватный режим: просто не запомним.
  }
}

/**
 * Предложение оценить сервис. Звёзды прямо на плашке: тап сразу сохраняет
 * оценку (та же, что в «Оценить сервис» в настройках), а комментарий — по
 * переходу в настройки, чтобы не растягивать плашку формой.
 */
function RatePrompt() {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated)
  const navigate = useNavigate()
  const [visible, setVisible] = useState(false)
  const [savedScore, setSavedScore] = useState(0)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!isAuthenticated) return undefined
    let firstSeen = readTime(FIRST_SEEN_KEY)
    if (!firstSeen) {
      writeTime(FIRST_SEEN_KEY)
      firstSeen = Date.now()
    }
    const dismissedAt = readTime(DISMISSED_KEY)
    if (dismissedAt && Date.now() - dismissedAt < REPEAT_AFTER_MS) return undefined
    if (Date.now() - firstSeen < MIN_AGE_MS) return undefined

    let cancelled = false
    const timer = setTimeout(async () => {
      // Уже оценивших не спрашиваем. Проверка — только перед показом, а не
      // при каждом открытии приложения.
      try {
        const response = await api.get('/feedback/rating', { skipErrorToast: true, dedupe: false })
        if (!cancelled && !response.data) setVisible(true)
      } catch {
        // Сеть недоступна — спросим в другой раз.
      }
    }, SHOW_DELAY_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [isAuthenticated])

  useEffect(() => {
    if (!savedScore) return undefined
    const timer = setTimeout(() => setVisible(false), THANKS_MS)
    return () => clearTimeout(timer)
  }, [savedScore])

  if (!visible) return null

  const dismiss = () => {
    setVisible(false)
    if (!savedScore) writeTime(DISMISSED_KEY)
  }

  const rate = async (score) => {
    if (busy) return
    setBusy(true)
    try {
      await api.put('/feedback/rating', { score })
      setSavedScore(score)
    } catch (error) {
      console.error('Error saving service rating:', error)
    } finally {
      setBusy(false)
    }
  }

  const openComment = () => {
    setVisible(false)
    navigate('/settings/feedback')
  }

  return (
    <div className="install-prompt" role="dialog" aria-label="Оценка сервиса">
      <div className="install-prompt-body">
        {savedScore ? (
          <>
            <p className="install-prompt-title">Спасибо за оценку!</p>
            <p className="install-prompt-text">
              {savedScore <= 3
                ? 'Напишите, что не так, — будем чинить.'
                : 'Хотите что-то добавить? Пара слов очень поможет.'}
            </p>
            <div className="push-prompt-actions">
              <button type="button" className="btn btn--primary btn--sm" onClick={openComment}>
                Написать отзыв
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="install-prompt-title">Как вам сервис?</p>
            <p className="install-prompt-text">
              Поставьте оценку — так мы поймём, что улучшить.
            </p>
            <div className="rate-stars rate-prompt-stars" role="group" aria-label="Оценка от 1 до 5">
              {[1, 2, 3, 4, 5].map((value) => (
                <button
                  key={value}
                  type="button"
                  className="rate-star"
                  aria-label={`${value} из 5`}
                  disabled={busy}
                  onClick={() => rate(value)}
                >
                  <Star size={28} aria-hidden="true" />
                </button>
              ))}
            </div>
            <div className="push-prompt-actions">
              <button type="button" className="btn btn--ghost btn--sm" onClick={dismiss}>
                Не сейчас
              </button>
            </div>
          </>
        )}
      </div>
      <button type="button" className="install-prompt-close" onClick={dismiss} aria-label="Закрыть">
        <X size={18} />
      </button>
    </div>
  )
}

export default RatePrompt
