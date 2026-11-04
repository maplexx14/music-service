import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import { Download, Eye, EyeOff, LockKeyhole, UserRound } from 'lucide-react'
import { androidDownloadUrl, installedAndroidVersion } from '../services/androidRelease'
import { safeNextPath } from '../services/navigation'
import loginHeart from '../assets/liked-hero-heart.webp'
import loginWordmark from '../assets/bolt-wordmark.webp'
import './Auth.css'
import './Login.css'

function Login() {
  const native = !!installedAndroidVersion(navigator.userAgent) || !!window.__boltAndroid
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [passwordVisible, setPasswordVisible] = useState(false)
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

  // Иначе — туда, откуда отправили на вход (ссылка на трек и т.п.).
  const afterLogin = () => navigate(justVerified ? '/onboarding' : safeNextPath(searchParams))

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
    setPasswordVisible(false)
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

  const hasEmail = mfaMethods.includes('email')
  const codeHint = `Введите 6-значный код, отправленный на ${emailMasked || 'вашу почту'}.`
  return (
    <main className="auth-container login-page" data-scrollable>
      <div className="auth-card login-card">
        <div className="login-art" aria-hidden="true">
          <img src={loginHeart} alt="" width="269" height="271" draggable="false" />
        </div>

        <section className="login-panel" aria-labelledby="login-title">
          <div className="login-content">
            <div className="auth-header">
              <h1 id="login-title">
                <img className="login-wordmark" src={loginWordmark} alt="bolt" width="665" height="248" />
              </h1>
              {mfaToken && <p>Подтвердите вход</p>}
            </div>

            {mfaToken ? (
              <form onSubmit={handleMfaSubmit} className="auth-form">
                {error && <div className="error-message" role="alert">{error}</div>}

                {emailNotice && <div className="success-message" role="status">{emailNotice}</div>}

                {/* Юзер, не включавший 2FA, иначе не понимает, почему у него вдруг
                    спрашивают код, и принимает это за поломку входа. */}
                {newDevice && (
                  <div className="auth-notice">
                    Вход с нового устройства. Подтвердите, что это вы — устройство
                    запомнится, и в следующий раз код не понадобится.
                  </div>
                )}

                <p className="auth-hint" id="login-code-hint">{codeHint}</p>

                <div className="form-group">
                  <label htmlFor="mfa-code">Код подтверждения</label>
                  <input className="field"
                    id="mfa-code"
                    type="text"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    required
                    autoFocus
                    autoComplete="one-time-code"
                    inputMode="numeric"
                    aria-describedby="login-code-hint"
                    placeholder="123456"
                  />
                </div>

                <button type="submit" className="btn btn--primary btn--lg btn--block auth-button" disabled={loading}>
                  {loading ? 'Проверка...' : 'Подтвердить'}
                </button>

                {hasEmail && (
                  <button
                    type="button"
                    className="btn btn--secondary btn--lg btn--block auth-button"
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
                  <div className="success-message" role="status">
                    Почта подтверждена. Войдите, чтобы продолжить.
                  </div>
                )}

                {error && <div className="error-message" role="alert">{error}</div>}

                {unverified && (
                  <>
                    {resendState === 'sent' && (
                      <div className="success-message" role="status">
                        Отправили новое письмо со ссылкой
                      </div>
                    )}
                    {resendState && !['sending', 'sent'].includes(resendState) && (
                      <div className="error-message" role="alert">{resendState}</div>
                    )}
                    <button
                      type="button"
                      className="btn btn--secondary btn--lg btn--block auth-button"
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
                  <label className="login-sr-only" htmlFor="username">Имя пользователя или email</label>
                  <div className="login-field-wrap">
                    <UserRound className="login-field-icon" size={18} aria-hidden="true" />
                    <input className="field"
                      id="username"
                      name="username"
                      type="text"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      required
                      autoComplete="username"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      placeholder="Логин или email"
                    />
                  </div>
                </div>

                <div className="form-group">
                  <label className="login-sr-only" htmlFor="password">Пароль</label>
                  <div className="login-field-wrap">
                    <LockKeyhole className="login-field-icon" size={18} aria-hidden="true" />
                    <input className="field login-password-input"
                      id="password"
                      name="password"
                      type={passwordVisible ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      autoComplete="current-password"
                      placeholder="Пароль"
                    />
                    <button
                      className="login-password-toggle"
                      type="button"
                      onClick={() => setPasswordVisible((visible) => !visible)}
                      aria-label={passwordVisible ? 'Скрыть пароль' : 'Показать пароль'}
                      aria-pressed={passwordVisible}
                      aria-controls="password"
                    >
                      {passwordVisible
                        ? <EyeOff size={18} aria-hidden="true" />
                        : <Eye size={18} aria-hidden="true" />}
                    </button>
                  </div>
                </div>

                <div className="login-actions">
                  <button type="submit" className="btn btn--primary btn--lg btn--block auth-button" disabled={loading}>
                    {loading ? 'Вход...' : 'Войти'}
                  </button>
                  <Link className="login-forgot" to="/forgot-password">Забыли пароль?</Link>
                </div>
              </form>
            )}

            {!mfaToken && (
              <div className="login-footer">
                <div className="login-divider"><span>или</span></div>
                <Link className="btn btn--secondary btn--lg btn--block" to="/register">
                  Создать аккаунт
                </Link>
                {!native && (
                  <a className="btn btn--ghost btn--sm auth-apk-download" href={androidDownloadUrl()} download="bolt.apk">
                    <Download size={16} aria-hidden="true" /> Скачать для Android
                  </a>
                )}
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  )
}

export default Login
