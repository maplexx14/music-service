import './SourceIcon.css'

// Значок сервиса, откуда трек, — кружок в углу обложки в выдаче поиска.
// Упрощённые знаки в фирменных цветах: на 16 px мелкие детали логотипов всё
// равно не читаются, узнаются цвет и силуэт.
const ICONS = {
  ytmusic: {
    label: 'YouTube Music',
    bg: '#ff0033',
    mark: (
      <>
        <circle cx="12" cy="12" r="5.6" fill="none" stroke="#fff" strokeWidth="1.4" />
        <path d="M10.4 9.6v4.8l4-2.4z" fill="#fff" />
      </>
    ),
  },
  soundcloud: {
    label: 'SoundCloud',
    bg: '#ff5500',
    mark: (
      <path
        d="M5 15.5v-3M7 15.5v-4.5M9 15.5V10M11 15.5V9h3.6a3.2 3.2 0 0 1 3.2 3.25 3.2 3.2 0 0 1-3.2 3.25z"
        fill="#fff"
        stroke="#fff"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
  },
  deezer: {
    label: 'Deezer',
    bg: '#a238ff',
    mark: (
      <path
        d="M7 16.5v-3M10.3 16.5v-6M13.7 16.5V8M17 16.5v-4.5"
        stroke="#fff"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    ),
  },
  spotify: {
    label: 'Spotify',
    bg: '#1ed760',
    mark: (
      <path
        d="M6.6 9.6c3.6-1.1 7.6-.8 10.8 1M7.3 12.6c2.9-.8 6.1-.5 8.7.9M8 15.4c2.2-.6 4.5-.4 6.5.7"
        fill="none"
        stroke="#000"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    ),
  },
}

/** Значок сервиса или null, если источник свой (загруженный трек). */
function SourceIcon({ source }) {
  const icon = ICONS[source]
  if (!icon) return null
  return (
    <svg className="source-icon" viewBox="0 0 24 24" role="img" aria-label={icon.label}>
      <title>{icon.label}</title>
      <circle cx="12" cy="12" r="12" fill={icon.bg} />
      {icon.mark}
    </svg>
  )
}

export default SourceIcon
