import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

// Регистрируем SW ПОСЛЕ рендера — не блокирует LCP/TTFB.
// SW подставляет заголовок для обхода предупреждения Tuna в запросах <audio>.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/audio-sw.js').catch((err) => {
      console.error('Audio SW registration failed:', err)
    })
  })
}
