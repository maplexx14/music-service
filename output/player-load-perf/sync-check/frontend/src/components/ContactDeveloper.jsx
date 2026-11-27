import { useState } from 'react'
import api from '../services/api'
import { toast } from '../store/toastStore'
import './TwoFactorSettings.css'

const MESSAGE_MAX_CHARS = 4000

// Сообщение разработчику — читает админ в админке. Вместе с текстом уходит
// версия сборки и устройство: без них «не играет» не разобрать.
function ContactDeveloper() {
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)

  const handleSubmit = async (event) => {
    event.preventDefault()
    const text = message.trim()
    if (!text || busy) return
    setBusy(true)
    try {
      await api.post('/feedback', {
        message: text,
        context: {
          build: import.meta.env.VITE_BUILD_TIME || null,
          userAgent: navigator.userAgent,
          screen: `${window.innerWidth}x${window.innerHeight}`,
          standalone: window.matchMedia('(display-mode: standalone)').matches,
        },
      })
      setMessage('')
      setSent(true)
      toast.success('Сообщение отправлено')
    } catch (error) {
      console.error('Error sending developer message:', error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-card">
      <div className="settings-section-title">Связь с разработчиком</div>
      <p className="settings-hint settings-section-hint">
        Нашли ошибку, есть идея или вопрос — напишите. Если что-то сломалось,
        опишите, что делали перед этим.
      </p>
      {sent && <div className="settings-hint">Спасибо! Сообщение получено.</div>}
      <form onSubmit={handleSubmit} className="twofa-form">
        <label className="twofa-field">
          <span>Сообщение</span>
          <textarea
            className="field"
            value={message}
            onChange={(e) => {
              setMessage(e.target.value)
              if (sent) setSent(false)
            }}
            maxLength={MESSAGE_MAX_CHARS}
            rows={6}
            required
          />
        </label>
        <div className="settings-prefs-actions">
          <button
            type="submit"
            className="btn btn--primary settings-save-btn"
            disabled={busy || !message.trim()}
          >
            {busy ? 'Отправка...' : 'Отправить'}
          </button>
        </div>
      </form>
    </div>
  )
}

export default ContactDeveloper
