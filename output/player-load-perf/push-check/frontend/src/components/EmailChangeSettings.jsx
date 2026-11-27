import { useEffect, useState } from 'react'
import { useAuthStore } from '../store/authStore'
import { toast } from '../store/toastStore'
import './TwoFactorSettings.css'

/**
 * Смена почты аккаунта в два шага: новый адрес + пароль, затем код из письма,
 * пришедшего на новый адрес. Почта меняется только после кода — опечатка в
 * адресе иначе отрезала бы юзера от сброса пароля и почтовой 2FA.
 */
function EmailChangeSettings() {
  const { user, requestEmailChange, confirmEmailChange } = useAuthStore()

  const [editing, setEditing] = useState(false)
  const [newEmail, setNewEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [codeSent, setCodeSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const reset = () => {
    setEditing(false)
    setNewEmail('')
    setPassword('')
    setCode('')
    setCodeSent(false)
    setError('')
    setNotice('')
  }

  useEffect(reset, [user?.id])

  const sendCode = async () => {
    setBusy(true)
    setError('')
    setNotice('')
    const result = await requestEmailChange(newEmail.trim(), password)
    setBusy(false)
    if (!result.success) {
      setError(result.error)
      return
    }
    setCodeSent(true)
    setNotice(
      result.sent
        ? `Код отправлен на ${result.emailMasked}`
        : `Код уже отправлен. Новый можно запросить через ${result.cooldownSeconds} с`
    )
  }

  const handleRequest = (e) => {
    e.preventDefault()
    sendCode()
  }

  const handleConfirm = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    const result = await confirmEmailChange(code)
    setBusy(false)
    if (result.success) {
      reset()
      toast.success('Почта изменена')
    } else {
      setError(result.error)
    }
  }

  return (
    <div className="settings-card">
      <div className="settings-section-title">Почта</div>
      <p className="settings-hint settings-section-hint">
        {user?.email
          ? <>Сейчас: <strong>{user.email}</strong>. На неё приходят коды входа и ссылки сброса пароля.</>
          : 'На почту приходят коды входа и ссылки сброса пароля.'}
      </p>

      {error && <div className="settings-error">{error}</div>}
      {notice && !error && <div className="settings-hint">{notice}</div>}

      {!editing ? (
        <div className="settings-prefs-actions">
          <button
            type="button"
            className="btn btn--secondary settings-save-btn"
            onClick={() => setEditing(true)}
          >
            Сменить почту
          </button>
        </div>
      ) : codeSent ? (
        <form onSubmit={handleConfirm} className="twofa-form">
          <label className="twofa-field">
            <span>Код из письма на {newEmail.trim()}</span>
            <input className="field"
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              autoFocus
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
            />
          </label>

          <div className="settings-prefs-actions">
            <button type="submit" className="btn btn--primary settings-save-btn" disabled={busy}>
              {busy ? 'Проверка...' : 'Подтвердить'}
            </button>
            <button
              type="button"
              className="btn btn--secondary settings-save-btn"
              onClick={sendCode}
              disabled={busy}
            >
              Прислать код ещё раз
            </button>
            <button
              type="button"
              className="btn btn--ghost settings-save-btn"
              onClick={reset}
              disabled={busy}
            >
              Отмена
            </button>
          </div>
        </form>
      ) : (
        <form onSubmit={handleRequest} className="twofa-form">
          <label className="twofa-field">
            <span>Новая почта</span>
            <input className="field"
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              required
              autoFocus
              autoComplete="email"
            />
          </label>

          <label className="twofa-field">
            <span>Пароль</span>
            <input className="field"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </label>

          <div className="settings-prefs-actions">
            <button type="submit" className="btn btn--primary settings-save-btn" disabled={busy}>
              {busy ? 'Отправка...' : 'Прислать код'}
            </button>
            <button
              type="button"
              className="btn btn--ghost settings-save-btn"
              onClick={reset}
              disabled={busy}
            >
              Отмена
            </button>
          </div>
        </form>
      )}
    </div>
  )
}

export default EmailChangeSettings
