import { useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import './GuestAccessDialog.css'

export default function GuestAccessDialog() {
  const dialogRef = useRef(null)
  useEffect(() => {
    const open = () => { if (!dialogRef.current.open) dialogRef.current.showModal() }
    window.addEventListener('guest:registration-required', open)
    return () => window.removeEventListener('guest:registration-required', open)
  }, [])
  return (
    <dialog ref={dialogRef} className="guest-access-dialog" aria-labelledby="guest-access-title">
      <h2 id="guest-access-title">Нужен аккаунт</h2>
      <p>Без регистрации можно слушать треки из поиска. Войдите, чтобы пользоваться остальными функциями.</p>
      <Link className="btn btn--primary btn--lg btn--block" to="/register">Зарегистрироваться</Link>
      <Link className="btn btn--secondary btn--lg btn--block" to="/login?next=%2Fsearch">Войти</Link>
      <button className="btn btn--ghost btn--lg btn--block" type="button" onClick={() => dialogRef.current.close()}>Продолжить слушать</button>
    </dialog>
  )
}
