import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

// Регистрируем SW, который подставляет заголовок для обхода предупреждения
// Tuna в запросах <audio> — без этого пришлось бы качать треки целиком через
// fetch() перед проигрыванием (см. audio-sw.js).
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/audio-sw.js').catch((err) => {
    console.error('Audio SW registration failed:', err)
  })
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
