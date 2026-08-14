import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import './Auth.css'

function VerifyEmail() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { verifyEmail } = useAuthStore()
  const [status, setStatus] = useState('checking')
  const [error, setError] = useState('')
  // React 18 в dev монтирует эффекты дважды, а токен одноразовый: второй
  // вызов получил бы 400 и затёр успех ошибкой.
  const started = useRef(false)

  const token = searchParams.get('token')

  useEffect(() => {
    if (started.current) return
    started.current = true

    if (!token) {
      setStatus('error')
      setError('В ссылке нет токена')
      return
    }

    let cancelled = false
    verifyEmail(token).then((result) => {
      if (cancelled) return
      if (result.success) {
        setStatus('done')
        setTimeout(() => navigate(result.authenticated ? '/onboarding' : '/login?verified=1'), 600)
      } else {
        setStatus('error')
        setError(result.error)
      }
    })

    return () => {
      cancelled = true
    }
  }, [token, verifyEmail, navigate])

  return (
    <div className="auth-container">
      <div className="auth-card">
        <div className="auth-header">
          <h1>Подтверждение почты</h1>
        </div>

        <div className="auth-form">
          {status === 'checking' && <p className="auth-hint">Проверяем ссылку...</p>}

          {status === 'done' && (
            <div className="success-message">
              Почта подтверждена. Перенаправляем...
            </div>
          )}

          {status === 'error' && (
            <>
              <div className="error-message">{error}</div>
              <p className="auth-hint">
                Ссылка живёт 24 часа и срабатывает один раз. Если она истекла,
                запросите новое письмо на странице входа.
              </p>
            </>
          )}
        </div>

        <div className="auth-footer">
          <p>
            <Link to="/login">Перейти ко входу</Link>
          </p>
        </div>
      </div>
    </div>
  )
}

export default VerifyEmail
