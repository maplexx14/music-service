import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import Turnstile from '../components/Turnstile'
import { useAuthStore } from '../store/authStore'
import './Auth.css'

function Register() {
  const [formData, setFormData] = useState({
    username: '',
    email: '',
    password: '',
  })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)
  const [resendState, setResendState] = useState('')
  // Каптча: настройки приходят с бэка, пока их нет — виджет не рисуем.
  const [captcha, setCaptcha] = useState({ loaded: false, required: false, siteKey: '' })
  const [captchaToken, setCaptchaToken] = useState('')
  // Смена nonce перерисовывает виджет: токен одноразовый, и после любой
  // неудачной отправки старый уже негоден.
  const [captchaNonce, setCaptchaNonce] = useState(0)
  const { register, resendVerification, fetchCaptchaConfig } = useAuthStore()

  useEffect(() => {
    let cancelled = false
    fetchCaptchaConfig().then((config) => {
      if (cancelled) return
      setCaptcha({
        loaded: config.success,
        required: config.required,
        siteKey: config.siteKey,
      })
      if (!config.success) {
        setError('Не удалось загрузить проверку «я не робот». Обновите страницу.')
      }
    })
    return () => {
      cancelled = true
    }
  }, [fetchCaptchaConfig])

  const showCaptcha = captcha.required && Boolean(captcha.siteKey)

  const resetCaptcha = () => {
    setCaptchaToken('')
    setCaptchaNonce((n) => n + 1)
  }

  const handleCaptchaToken = (token) => {
    setCaptchaToken(token)
    if (token) {
      // Убираем оставшуюся после преждевременного submit подсказку сразу,
      // как только Turnstile подтвердил пользователя.
      setError((current) =>
        current.toLowerCase().includes('не робот') || current.toLowerCase().includes('проверка')
          ? ''
          : current
      )
    }
  }

  const handleChange = (e) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value,
    })
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')

    if (!captcha.loaded) {
      setError('Проверка «я не робот» ещё загружается — попробуйте ещё раз')
      return
    }

    // Turnstile writes the token to a hidden cf-turnstile-response field as
    // well as invoking the callback. Read it here to cover delayed callback
    // delivery in React/concurrent rendering.
    const domCaptchaToken = showCaptcha
      ? document.querySelector('[name="cf-turnstile-response"]')?.value || ''
      : ''
    const token = captchaToken || domCaptchaToken

    if (showCaptcha && !token) {
      setError('Подтвердите, что вы не робот')
      return
    }

    setLoading(true)
    const result = await register(
      formData.username,
      formData.email,
      formData.password,
      token
    )
    setLoading(false)

    if (result.success) {
      setSent(true)
    } else {
      setError(result.error)
      // Бэк гасит токен при проверке — даже если отказ пришёл из-за занятого
      // username, второй раз тот же токен не пройдёт.
      if (showCaptcha) resetCaptcha()
    }
  }

  const handleResend = async () => {
    setResendState('sending')
    const result = await resendVerification(formData.username, formData.password)
    setResendState(result.success ? 'sent' : result.error)
  }

  if (sent) {
    return (
      <div className="auth-container">
        <div className="auth-card">
          <div className="auth-header">
            <h1>Проверьте почту</h1>
            <p>
              Отправили ссылку для подтверждения на <strong>{formData.email}</strong>.
              Ссылка действует 24 часа.
            </p>
          </div>

          <div className="auth-form">
            <p className="auth-hint">
              Не пришло письмо? Проверьте папку со спамом или отправьте ещё раз.
            </p>

            {resendState === 'sent' && (
              <div className="success-message">Письмо отправлено ещё раз</div>
            )}
            {resendState && !['sending', 'sent'].includes(resendState) && (
              <div className="error-message">{resendState}</div>
            )}

            <button
              type="button"
              className="auth-button secondary"
              onClick={handleResend}
              disabled={resendState === 'sending'}
            >
              {resendState === 'sending' ? 'Отправка...' : 'Отправить письмо ещё раз'}
            </button>
          </div>

          <div className="auth-footer">
            <p>
              Уже подтвердили? <Link to="/login">Войти</Link>
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
          <p>Создайте новый аккаунт</p>
        </div>
        
        <form onSubmit={handleSubmit} className="auth-form">
          {error && <div className="error-message">{error}</div>}
          
          <div className="form-group">
            <label htmlFor="username">Имя пользователя</label>
            <input
              id="username"
              name="username"
              type="text"
              value={formData.username}
              onChange={handleChange}
              required
              autoComplete="username"
            />
          </div>

          <div className="form-group">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              name="email"
              type="email"
              value={formData.email}
              onChange={handleChange}
              required
              autoComplete="email"
            />
          </div>

          <div className="form-group">
            <label htmlFor="password">Пароль</label>
            <input
              id="password"
              name="password"
              type="password"
              value={formData.password}
              onChange={handleChange}
              required
              autoComplete="new-password"
            />
          </div>

          {showCaptcha && (
            <Turnstile
              key={captchaNonce}
              siteKey={captcha.siteKey}
              onToken={handleCaptchaToken}
              onError={() => setError('Проверка «я не робот» не сработала — попробуйте ещё раз')}
            />
          )}

          <button type="submit" className="auth-button" disabled={loading || !captcha.loaded}>
            {loading
              ? 'Регистрация...'
              : !captcha.loaded
                ? 'Загрузка проверки...'
                : 'Зарегистрироваться'}
          </button>
        </form>

        <div className="auth-footer">
          <p>
            Уже есть аккаунт? <Link to="/login">Войти</Link>
          </p>
        </div>
      </div>
    </div>
  )
}

export default Register
