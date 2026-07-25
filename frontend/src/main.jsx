import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

// Снимаем аудио-SW, если он остался с прошлых версий. Он подставлял
// tuna-skip-browser-warning к запросам <audio>, но туннель этого заголовка
// не требует — а перехват ЛОМАЛ Range: пересобранный в SW Request теряет
// его (Range — forbidden header name, плюс WebKit bug 189337), поэтому
// бэкенд отдавал 200 со всем файлом и iOS Safari ждал последнего байта
// вместо старта с первых килобайт. Удалённый файл сам SW не выключает —
// он живёт в браузере до явного unregister.
navigator.serviceWorker?.getRegistrations?.()
  .then((regs) => regs.forEach((reg) => reg.unregister()))
  .catch(() => {})
