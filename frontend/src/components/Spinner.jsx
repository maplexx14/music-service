import './Spinner.css'

function Spinner({ label = 'Загрузка...' }) {
  return (
    <div className="spinner-wrap" role="status" aria-label={label}>
      <div className="spinner" />
      <span className="spinner-label">{label}</span>
    </div>
  )
}

export default Spinner
