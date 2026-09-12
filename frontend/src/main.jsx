import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

// Service worker: app-shell (см. public/sw.js). Он кэширует только каркас
// (HTML, /assets, шрифты, иконки) для мгновенного старта PWA; аудио, API и
// медиа-файлы проходят насквозь, БЕЗ перехвата — прошлый аудио-SW ломал
// Range-заголовки (пересобранный в SW Request теряет forbidden headers,
// плюс WebKit bug 189337), и iOS Safari ждал последний байт вместо старта
// с первых килобайт. register() сам вытесняет чужие/старые SW на своей
// scope; отдельного unregister-прохода больше не нужно.
if ('serviceWorker' in navigator && window.location.protocol === 'https:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}
