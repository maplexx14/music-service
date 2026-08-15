import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import './Auth.css'

function ResetPassword() {
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token') || ''
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(token ? '' : 'В ссылке отсутствует токен восстановления')
  const [done, setDone] = useState(false)
  const resetPassword = useAuthStore((state) => state.resetPassword)

  const handleSubmit = async (event) => {
    event.preventDefault()
    if (password !== confirmation) {
      setError('Пароли не совпадают')
      return
    }
    setError('')
    setLoading(true)
    const result = await resetPassword(token, password)
    setLoading(false)
    if (result.success) setDone(true)
    else setError(result.error)
  }

  return (
    <div className="auth-container">
      <div className="auth-card">
        <div className="auth-header"><h1>bolt</h1><p>Новый пароль</p></div>
        {done ? (
          <div className="auth-form">
            <div className="success-message">Пароль изменён. Теперь можно войти.</div>
            <Link className="auth-button" to="/login">Перейти ко входу</Link>
          </div>
        ) : (
          <form className="auth-form" onSubmit={handleSubmit}>
            {error && <div className="error-message">{error}</div>}
            <div className="form-group">
              <label htmlFor="new-password">Новый пароль</label>
              <input id="new-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="new-password" autoFocus />
            </div>
            <div className="form-group">
              <label htmlFor="confirm-password">Повторите пароль</label>
              <input id="confirm-password" type="password" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} required autoComplete="new-password" />
            </div>
            <button className="auth-button" type="submit" disabled={loading || !token}>
              {loading ? 'Сохранение...' : 'Сохранить пароль'}
            </button>
          </form>
        )}
        {!done && <div className="auth-footer"><p><Link to="/forgot-password">Запросить новую ссылку</Link></p></div>}
      </div>
    </div>
  )
}

export default ResetPassword
