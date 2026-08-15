import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import './Auth.css'

function ForgotPassword() {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)
  const requestPasswordReset = useAuthStore((state) => state.requestPasswordReset)

  const handleSubmit = async (event) => {
    event.preventDefault()
    setError('')
    setLoading(true)
    const result = await requestPasswordReset(email)
    setLoading(false)
    if (result.success) setSent(true)
    else setError(result.error)
  }

  return (
    <div className="auth-container">
      <div className="auth-card">
        <div className="auth-header">
          <h1>bolt</h1>
          <p>Восстановление пароля</p>
        </div>
        {sent ? (
          <div className="auth-form">
            <div className="success-message">
              Если аккаунт с такой почтой существует, мы отправили ссылку для смены пароля.
            </div>
            <Link className="auth-link-button" to="/login">Вернуться ко входу</Link>
          </div>
        ) : (
          <form className="auth-form" onSubmit={handleSubmit}>
            {error && <div className="error-message">{error}</div>}
            <p className="auth-hint">Укажите почту аккаунта. Ссылка будет действовать один час.</p>
            <div className="form-group">
              <label htmlFor="reset-email">Почта</label>
              <input id="reset-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" autoFocus />
            </div>
            <button className="auth-button" type="submit" disabled={loading}>
              {loading ? 'Отправка...' : 'Отправить ссылку'}
            </button>
          </form>
        )}
        <div className="auth-footer"><p><Link to="/login">Войти с паролем</Link></p></div>
      </div>
    </div>
  )
}

export default ForgotPassword
