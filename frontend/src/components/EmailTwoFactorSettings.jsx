import { useEffect, useState } from 'react'
import { useAuthStore } from '../store/authStore'
import { toast } from '../store/toastStore'
import './TwoFactorSettings.css'

/**
 * Второй фактор по почте: код из письма при входе.
 *
 * Стили и разметка переиспользуют карточку TOTP-настроек — фактор другой,
 * но экран для юзера тот же по смыслу.
 *
 * Включение требует и кода из письма, и пароля: код доказывает доступ к
 * ящику, пароль — что фактор включает владелец аккаунта, а не тот, кто
 * подобрал брошенную сессию.
 */
function EmailTwoFactorSettings() {
  const { user, setupEmailTwoFactor, enableEmailTwoFactor, disableEmailTwoFactor } =
    useAuthStore()
  const enabled = !!user?.email_2fa_enabled
  const emailVerified = !!user?.email_verified

  const [codeRequested, setCodeRequested] = useState(false)
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  // Смена аккаунта или состояния фактора не должна оставлять на экране
  // недозаполненную форму от прошлого состояния.
  useEffect(() => {
    setCodeRequested(false)
    setCode('')
    setPassword('')
    setError('')
    setNotice('')
  }, [user?.id, enabled])

  const handleSendCode = async () => {
    setBusy(true)
    setError('')
    setNotice('')
    const result = await setupEmailTwoFactor()
    setBusy(false)
    if (!result.success) {
      setError(result.error)
      return
    }
    setCodeRequested(true)
    setNotice(
      result.sent
        ? `Код отправлен на ${result.emailMasked}`
        : `Код уже отправлен. Новый можно запросить через ${result.cooldownSeconds} с`
    )
  }

  const handleEnable = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    const result = await enableEmailTwoFactor(code, password)
    setBusy(false)
    if (result.success) {
      setCodeRequested(false)
      setCode('')
      setPassword('')
      setNotice('')
      toast.success('Вход по коду из почты включён')
    } else {
      setError(result.error)
    }
  }

  const handleDisable = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    const result = await disableEmailTwoFactor(password)
    setBusy(false)
    if (result.success) {
      setPassword('')
      toast.success('Вход по коду из почты выключен')
    } else {
      setError(result.error)
    }
  }

  return (
    <div className="settings-card">
      <div className="settings-section-title">Код на почту</div>
      <p className="settings-hint settings-section-hint">
        {enabled
          ? 'При входе присылаем 6-значный код на вашу почту.'
          : 'Второй фактор без приложения: 6-значный код письмом при каждом входе.'}
      </p>

      {error && <div className="settings-error">{error}</div>}
      {notice && !error && <div className="settings-hint">{notice}</div>}

      {enabled ? (
        <form onSubmit={handleDisable} className="twofa-form">
          <div className="twofa-status twofa-status-on">Включён</div>
          <label className="twofa-field">
            <span>Пароль для подтверждения</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </label>
          <div className="settings-prefs-actions">
            <button type="submit" className="settings-save-btn twofa-danger" disabled={busy}>
              {busy ? 'Выключение...' : 'Выключить'}
            </button>
          </div>
        </form>
      ) : !emailVerified ? (
        <>
          <div className="twofa-status">Выключен</div>
          <p className="settings-hint">
            Сначала подтвердите почту — иначе код будет некуда прислать.
          </p>
        </>
      ) : codeRequested ? (
        <form onSubmit={handleEnable} className="twofa-form">
          <ol className="twofa-steps">
            <li>Откройте письмо и найдите 6-значный код.</li>
            <li>Введите его и свой пароль.</li>
          </ol>

          <label className="twofa-field">
            <span>Код из письма</span>
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
            />
          </label>

          <label className="twofa-field">
            <span>Пароль</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </label>

          <div className="settings-prefs-actions">
            <button type="submit" className="settings-save-btn" disabled={busy}>
              {busy ? 'Включение...' : 'Включить'}
            </button>
            <button
              type="button"
              className="settings-save-btn"
              onClick={handleSendCode}
              disabled={busy}
            >
              Прислать код ещё раз
            </button>
            <button
              type="button"
              className="settings-save-btn"
              onClick={() => setCodeRequested(false)}
              disabled={busy}
            >
              Отмена
            </button>
          </div>
        </form>
      ) : (
        <>
          <div className="twofa-status">Выключен</div>
          <div className="settings-prefs-actions">
            <button
              type="button"
              className="settings-save-btn"
              onClick={handleSendCode}
              disabled={busy}
            >
              {busy ? 'Отправка...' : 'Прислать код на почту'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

export default EmailTwoFactorSettings
