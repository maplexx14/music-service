import BoltLoader from './BoltLoader'
import './Spinner.css'

// page — загрузка всего экрана: индикатор по центру видимой области
// (main в Layout или #root вне его), а не прижат к верху страницы.
function Spinner({ label = 'Загрузка...', page = false }) {
  return (
    <div className={`spinner-wrap${page ? ' spinner-wrap--page' : ''}`} role="status" aria-label={label}>
      <BoltLoader size={40} frame={104} />
      <span className="spinner-label">{label}</span>
    </div>
  )
}

export default Spinner
