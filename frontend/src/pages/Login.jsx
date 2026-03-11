import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import api from '../services/api'
import './Auth.css'

function Login() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // Verification state
  const [step, setStep] = useState('login') // 'login' | 'verify'
  const [verifyEmail, setVerifyEmail] = useState('')
  const [verifyCode, setVerifyCode] = useState('')
  const [resendTimer, setResendTimer] = useState(0)

  const { login } = useAuthStore()
  const navigate = useNavigate()

  const startResendTimer = () => {
    setResendTimer(60)
    const interval = setInterval(() => {
      setResendTimer((prev) => {
        if (prev <= 1) {
          clearInterval(interval)
          return 0
        }
        return prev - 1
      })
    }, 1000)
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    const result = await login(username, password)
    setLoading(false)

    if (result.success) {
      navigate('/')
    } else if (result.needsVerification) {
      // User exists but email not verified — switch to verification step
      setVerifyEmail(result.email)
      setStep('verify')
      startResendTimer()
    } else {
      setError(result.error)
    }
  }

  const handleVerify = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      await api.post('/auth/verify-email', {
        email: verifyEmail,
        code: verifyCode,
      })
      // Verified — now log in again
      const result = await login(username, password)
      if (result.success) {
        navigate('/')
      } else {
        setError(result.error)
      }
    } catch (err) {
      setError(err.response?.data?.detail || 'Неверный код')
    } finally {
      setLoading(false)
    }
  }

  const handleResend = async () => {
    if (resendTimer > 0) return
    setError('')
    try {
      await api.post('/auth/resend-code', { email: verifyEmail })
      startResendTimer()
    } catch (err) {
      setError(err.response?.data?.detail || 'Не удалось отправить код')
    }
  }

  if (step === 'verify') {
    return (
      <div className="auth-container">
        <div className="auth-card">
          <div className="auth-header">
            <h1>Подтверждение Email</h1>
            <p>
              Мы отправили код на <strong>{verifyEmail}</strong>
            </p>
          </div>

          <form onSubmit={handleVerify} className="auth-form">
            {error && <div className="error-message">{error}</div>}

            <div className="form-group">
              <label htmlFor="code">Код подтверждения</label>
              <input
                id="code"
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={verifyCode}
                onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, ''))}
                placeholder="000000"
                required
                autoComplete="one-time-code"
                className="verify-code-input"
              />
            </div>

            <button type="submit" className="auth-button" disabled={loading || verifyCode.length < 6}>
              {loading ? 'Проверка...' : 'Подтвердить'}
            </button>
          </form>

          <div className="auth-footer">
            <p>
              Не получили код?{' '}
              {resendTimer > 0 ? (
                <span className="resend-timer">Отправить повторно через {resendTimer}с</span>
              ) : (
                <button type="button" onClick={handleResend} className="resend-btn">
                  Отправить повторно
                </button>
              )}
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="auth-container">
      <div className="auth-card">
        <div className="auth-header">
          <h1>Music Streaming</h1>
          <p>Войдите в свой аккаунт</p>
        </div>

        <form onSubmit={handleSubmit} className="auth-form">
          {error && <div className="error-message">{error}</div>}

          <div className="form-group">
            <label htmlFor="username">Имя пользователя</label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoComplete="username"
            />
          </div>

          <div className="form-group">
            <label htmlFor="password">Пароль</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </div>

          <button type="submit" className="auth-button" disabled={loading}>
            {loading ? 'Вход...' : 'Войти'}
          </button>
        </form>

        <div className="auth-footer">
          <p>
            Нет аккаунта? <Link to="/register">Зарегистрироваться</Link>
          </p>
        </div>
      </div>
    </div>
  )
}

export default Login
