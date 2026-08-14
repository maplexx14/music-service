import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import { useNavigate } from 'react-router-dom'
import './Auth.css'

function Login() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  // Второй шаг входа. mfaToken держим в стейте формы, а не в сторе: он не
  // даёт доступа к API и не должен переживать уход со страницы.
  const [mfaToken, setMfaToken] = useState(null)
  const [code, setCode] = useState('')
  const [mfaMethods, setMfaMethods] = useState([])
  const [emailMasked, setEmailMasked] = useState('')
  const [emailCodeSent, setEmailCodeSent] = useState(false)
  const [emailSending, setEmailSending] = useState(false)
  const [emailNotice, setEmailNotice] = useState('')
  // Код спрашивают из-за незнакомого устройства, а не потому что юзер включал
  // 2FA: без объяснения такой экран выглядит как поломка входа.
  const [newDevice, setNewDevice] = useState(false)
  const [unverified, setUnverified] = useState(false)
  const [resendState, setResendState] = useState('')
  const { login, verifyMfa, sendEmailCode, resendVerification } = useAuthStore()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  // Пришёл со страницы подтверждения — после входа показываем онбординг,
  // который до этого жил сразу за регистрацией.
  const justVerified = searchParams.get('verified') === '1'

  const afterLogin = () => navigate(justVerified ? '/onboarding' : '/')

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setUnverified(false)
    setResendState('')
    setLoading(true)

    const result = await login(username, password)
    setLoading(false)

    if (result.success) {
      afterLogin()
    } else if (result.mfaRequired) {
      setMfaToken(result.mfaToken)
      setCode('')
      setMfaMethods(result.mfaMethods)
      setEmailMasked(result.emailMasked)
      setEmailCodeSent(result.emailCodeSent)
      setNewDevice(result.newDevice)
      setEmailNotice(result.emailCodeSent ? `Код отправлен на ${result.emailMasked}` : '')
    } else if (result.emailUnverified) {
      setUnverified(true)
      setError(result.error)
    } else {
      setError(result.error)
    }
  }

  const handleResend = async () => {
    setResendState('sending')
    const result = await resendVerification(username, password)
    setResendState(result.success ? 'sent' : result.error)
  }

  const handleMfaSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    const result = await verifyMfa(mfaToken, code)
    setLoading(false)

    if (result.success) {
      afterLogin()
    } else {
      setError(result.error)
      // Промежуточный токен протух — возвращаем на шаг пароля, иначе юзер
      // будет бесконечно вводить коды в мёртвую форму.
      if (result.expired) {
        resetMfaStep()
        setPassword('')
      }
    }
  }

  const handleSendEmailCode = async () => {
    setError('')
    setEmailNotice('')
    setEmailSending(true)

    const result = await sendEmailCode(mfaToken)
    setEmailSending(false)

    if (!result.success) {
      setError(result.error)
      if (result.expired) {
        resetMfaStep()
        setPassword('')
      }
      return
    }

    setEmailCodeSent(true)
    setEmailNotice(
      result.sent
        ? `Код отправлен на ${result.emailMasked || emailMasked}`
        : `Код уже отправлен. Новый можно запросить через ${result.cooldownSeconds} с`
    )
  }

  const resetMfaStep = () => {
    setMfaToken(null)
    setCode('')
    setMfaMethods([])
    setEmailMasked('')
    setEmailCodeSent(false)
    setEmailNotice('')
    setNewDevice(false)
  }

  const handleBackToPassword = () => {
    resetMfaStep()
    setError('')
    setPassword('')
  }

  const hasTotp = mfaMethods.includes('totp')
  const hasEmail = mfaMethods.includes('email')
  const codeHint = hasTotp && hasEmail
    ? 'Введите код из приложения-аутентификатора, код из письма или резервный код.'
    : hasEmail
      ? `Введите 6-значный код, отправленный на ${emailMasked || 'вашу почту'}, или резервный код.`
      : 'Введите код из приложения-аутентификатора или один из резервных кодов.'
  return (
    <div className="auth-container">
      <div className="auth-card">
        <div className="auth-header">
          <h1>bolt</h1>
          <p>{mfaToken ? 'Подтвердите вход' : 'Войдите в свой аккаунт'}</p>
        </div>

        {mfaToken ? (
          <form onSubmit={handleMfaSubmit} className="auth-form">
            {error && <div className="error-message">{error}</div>}

            {emailNotice && <div className="success-message">{emailNotice}</div>}

            {/* Юзер, не включавший 2FA, иначе не понимает, почему у него вдруг
                спрашивают код, и принимает это за поломку входа. */}
            {newDevice && (
              <div className="auth-notice">
                Вход с нового устройства. Подтвердите, что это вы — устройство
                запомнится, и в следующий раз код не понадобится.
              </div>
            )}

            <p className="auth-hint">{codeHint}</p>

            <div className="form-group">
              <label htmlFor="mfa-code">Код подтверждения</label>
              <input
                id="mfa-code"
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
                autoFocus
                autoComplete="one-time-code"
                inputMode="text"
                placeholder="123456"
              />
            </div>

            <button type="submit" className="auth-button" disabled={loading}>
              {loading ? 'Проверка...' : 'Подтвердить'}
            </button>

            {hasEmail && (
              <button
                type="button"
                className="auth-button secondary"
                onClick={handleSendEmailCode}
                disabled={emailSending}
              >
                {emailSending
                  ? 'Отправка...'
                  : emailCodeSent
                    ? 'Отправить код ещё раз'
                    : 'Прислать код на почту'}
              </button>
            )}

            <button type="button" className="auth-link-button" onClick={handleBackToPassword}>
              Войти под другим аккаунтом
            </button>
          </form>
        ) : (
          <form onSubmit={handleSubmit} className="auth-form">
            {justVerified && !error && (
              <div className="success-message">
                Почта подтверждена. Войдите, чтобы продолжить.
              </div>
            )}

            {error && <div className="error-message">{error}</div>}

            {unverified && (
              <>
                {resendState === 'sent' && (
                  <div className="success-message">
                    Отправили новое письмо со ссылкой
                  </div>
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
                  {resendState === 'sending'
                    ? 'Отправка...'
                    : 'Отправить письмо ещё раз'}
                </button>
              </>
            )}

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
        )}

        {!mfaToken && (
          <div className="auth-footer">
            <p>
              Нет аккаунта? <Link to="/register">Зарегистрироваться</Link>
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

export default Login
