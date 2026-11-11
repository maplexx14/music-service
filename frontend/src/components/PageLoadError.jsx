// Ошибка запроса оставляет пользователя на выбранном экране и даёт повторить
// действие. «Назад» остаётся обычной кнопкой в оболочке экрана.
import './PageLoadError.css'

function PageLoadError({ title, onRetry }) {
  return (
    <div className="page-container">
      <div className="empty-playlist page-load-error" role="alert">
        <h2>{title}</h2>
        <p>Попробуйте загрузить страницу ещё раз.</p>
        <button type="button" className="btn btn--primary" onClick={onRetry}>Повторить</button>
      </div>
    </div>
  )
}

export default PageLoadError
