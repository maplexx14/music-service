import './DownloadProgress.css'

export default function DownloadProgress({ value = null, className = '', label }) {
  const indeterminate = value == null
  const percent = indeterminate ? null : Math.max(0, Math.min(100, Math.round(value)))
  return (
    <span
      className={`download-progress${indeterminate ? ' is-indeterminate' : ''}${className ? ` ${className}` : ''}`}
      style={percent == null ? undefined : { '--download-progress': `${percent}%` }}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
      aria-label={label}
    >
      <span className="download-progress-fill" />
    </span>
  )
}
