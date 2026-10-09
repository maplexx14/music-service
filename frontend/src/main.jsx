import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import ErrorBoundary from './components/ErrorBoundary'
import MeterProfiler from './components/MeterProfiler'
import './index.css'
import './styles/controls.css'
// Стиль промо-ролика — пока выключен.
// import './styles/promo.css'
import { installImageFade } from './services/imageFade'
import { installFrameMeter } from './utils/frameMeter'
import { installPressFeedback } from './services/pressFeedback'
import { installTouchGuard } from './services/touchGuard'
import { applyGpuClass } from './utils/gpu'

// До первого рендера: облегчённые эффекты должны действовать с первого кадра.
applyGpuClass()
installPressFeedback()
installImageFade()
installFrameMeter()
installTouchGuard()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <MeterProfiler id="всё приложение">
        <App />
      </MeterProfiler>
    </ErrorBoundary>
  </React.StrictMode>,
)
// Сторож в index.html: бандл исполнился, восстанавливать нечего.
window.__boltBooted = true
// Заставка из index.html: снимаем, когда React успел отрисовать первый кадр.
requestAnimationFrame(() => window.__bootSplashHide?.())

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
