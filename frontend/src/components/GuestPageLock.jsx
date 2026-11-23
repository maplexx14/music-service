import { Link, useLocation } from 'react-router-dom'
import { LockKeyhole } from '@/components/icons'
import './GuestPageLock.css'

export default function GuestPageLock() {
  const location = useLocation()
  const next = encodeURIComponent(location.pathname + location.search)
  return (
    <section className="guest-page-lock" aria-labelledby="guest-page-lock-title">
      <div className="guest-page-lock-card">
        <LockKeyhole size={32} aria-hidden="true" />
        <h1 id="guest-page-lock-title">Требуется регистрация</h1>
        <p>Войдите или создайте аккаунт, чтобы пользоваться этим разделом.</p>
        <Link className="btn btn--primary btn--lg btn--block" to="/register">Зарегистрироваться</Link>
        <Link className="btn btn--secondary btn--lg btn--block" to={`/login?next=${next}`}>Войти</Link>
        <Link className="btn btn--ghost btn--lg btn--block" to="/search">Слушать без регистрации</Link>
      </div>
    </section>
  )
}
