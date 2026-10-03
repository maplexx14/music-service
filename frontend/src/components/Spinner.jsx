import BoltLoader from './BoltLoader'
import './Spinner.css'

function Spinner({ label = 'Загрузка...' }) {
  return (
    <div className="spinner-wrap" role="status" aria-label={label}>
      <BoltLoader size={40} reach={1} />
      <span className="spinner-label">{label}</span>
    </div>
  )
}

export default Spinner
