import { useEffect, useState } from 'react'
import { useAuthStore } from '../store/authStore'
import { toast } from '../store/toastStore'
import './TwoFactorSettings.css'

/**
 * Управление двухфакторкой в настройках.
 *
 * Три состояния: выключена → настройка (QR + подтверждение) → включена.
 * Резервные коды показываются ровно один раз, сразу после включения: в БД
 * лежат только их хэши, повторно их не достать — поэтому экран с кодами
 * закрывается явным «Я сохранил коды», а не автоматически.
 */
function TwoFactorSettings() {
  const { user, setupTwoFactor, enableTwoFactor, disableTwoFactor } = useAuthStore()
  const enabled = !!user?.totp_enabled

  const [setupData, setSetupData] = useState(null)
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [recoveryCodes, setRecoveryCodes] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // Смена аккаунта/состояния 2FA не должна оставлять на экране чужой QR
  // или недозаполненную форму подтверждения.
  useEffect(() => {
    setSetupData(null)
    setCode('')
    setPassword('')
    setError('')
  }, [user?.id, enabled])

  const handleStartSetup = async () => {
    setBusy(true)
    setError('')
    const result = await setupTwoFactor()
    setBusy(false)
    if (result.success) {
      setSetupData(result.data)
    } else {
      setError(result.error)
    }
  }

  const handleEnable = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    const result = await enableTwoFactor(code, password)
    setBusy(false)
    if (result.success) {
      setSetupData(null)
      setCode('')
      setPassword('')
      setRecoveryCodes(result.recoveryCodes)
      toast.success('Двухфакторная аутентификация включена')
    } else {
      setError(result.error)
    }
  }

  const handleDisable = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    const result = await disableTwoFactor(password)
    setBusy(false)
    if (result.success) {
      setPassword('')
      toast.success('Двухфакторная аутентификация выключена')
    } else {
      setError(result.error)
    }
  }

  const handleCopyCodes = async () => {
    try {
      await navigator.clipboard.writeText(recoveryCodes.join('\n'))
      toast.success('Коды скопированы')
    } catch {
      toast.error('Не удалось скопировать — сохраните коды вручную')
    }
  }

  // Экран одноразового показа резервных кодов перекрывает остальное:
  // пока юзер не подтвердил, что сохранил их, ничего важнее на этой карточке нет.
  if (recoveryCodes) {
    return (
      <div className="settings-card">
        <div className="settings-section-title">Резервные коды</div>
        <p className="settings-hint settings-section-hint">
          Сохраните эти коды в надёжном месте. Каждый работает один раз и
          заменяет код из приложения, если телефон недоступен.{' '}
          <strong>Больше они показаны не будут.</strong>
        </p>
        <ul className="twofa-codes">
          {recoveryCodes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <div className="settings-prefs-actions">
          <button type="button" className="settings-save-btn" onClick={handleCopyCodes}>
            Скопировать
          </button>
          <button
            type="button"
            className="settings-save-btn"
            onClick={() => setRecoveryCodes(null)}
          >
            Я сохранил коды
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="settings-card">
      <div className="settings-section-title">Приложение-аутентификатор</div>
      <p className="settings-hint settings-section-hint">
        {enabled
          ? 'Вход требует код из приложения-аутентификатора.'
          : 'Дополнительный код при входе — на случай, если пароль украдут.'}
      </p>

      {error && <div className="settings-error">{error}</div>}

      {enabled ? (
        <form onSubmit={handleDisable} className="twofa-form">
          <div className="twofa-status twofa-status-on">Включена</div>
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
              {busy ? 'Выключение...' : 'Выключить 2FA'}
            </button>
          </div>
        </form>
      ) : setupData ? (
        <form onSubmit={handleEnable} className="twofa-form">
          <ol className="twofa-steps">
            <li>Отсканируйте QR-код приложением (Google Authenticator, 1Password, Aegis).</li>
            <li>Введите код, который оно покажет, и свой пароль.</li>
          </ol>

          {setupData.qr_png && (
            <img className="twofa-qr" src={setupData.qr_png} alt="QR-код для настройки 2FA" />
          )}

          <div className="twofa-secret">
            <span className="settings-hint">Не сканируется? Введите ключ вручную:</span>
            <code>{setupData.totp_secret}</code>
          </div>

          <label className="twofa-field">
            <span>Код из приложения</span>
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
              {busy ? 'Включение...' : 'Включить 2FA'}
            </button>
            <button
              type="button"
              className="settings-save-btn"
              onClick={() => setSetupData(null)}
              disabled={busy}
            >
              Отмена
            </button>
          </div>
        </form>
      ) : (
        <>
          <div className="twofa-status">Выключена</div>
          <div className="settings-prefs-actions">
            <button
              type="button"
              className="settings-save-btn"
              onClick={handleStartSetup}
              disabled={busy}
            >
              {busy ? 'Подготовка...' : 'Включить 2FA'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

export default TwoFactorSettings
