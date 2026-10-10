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
import { installFastTap } from './services/fastTap'
import { applyGpuClass } from './utils/gpu'

// До первого рендера: облегчённые эффекты должны действовать с первого кадра.
applyGpuClass()
installPressFeedback()
installImageFade()
installFrameMeter()
installTouchGuard()
installFastTap()

// WebKit на iOS решает, ждать ли главный поток перед прокруткой, по
// слушателям touch- и pointer-событий под пальцем: если среди них есть
// непассивный (может вызвать preventDefault), жест прокрутки откладывается до
// ответа страницы, и любая занятость главного потока — рендер, событие
// медиаэлемента — задерживает старт прокрутки и клик. React вешает на корень
// pointer-события и touchend непассивными (пассивны у него только touchstart,
// touchmove и wheel), и синхронным становилось всё приложение. preventDefault
// в pointer- и touchend-обработчиках у нас нигде не нужен — корневые
// слушатели этих событий делаем пассивными. Где жесту правда нужен
// preventDefault, слушатель вешается напрямую, на узкий элемент (см. полосу
// у кромки в useSwipeNavigation).
const PASSIVE_ROOT_EVENTS = new Set([
  'pointerdown',
  'pointermove',
  'pointerup',
  'pointerover',
  'pointerout',
  'pointerenter',
  'pointerleave',
  'touchend',
])

function createRootWithPassiveTouch(container) {
  const add = container.addEventListener
  container.addEventListener = function addRootListener(type, listener, options) {
    if (!PASSIVE_ROOT_EVENTS.has(type)) return add.call(this, type, listener, options)
    const capture = typeof options === 'boolean' ? options : Boolean(options?.capture)
    return add.call(this, type, listener, { capture, passive: true })
  }
  // Слушатели корня React ставит синхронно, внутри createRoot.
  try {
    return ReactDOM.createRoot(container)
  } finally {
    delete container.addEventListener
  }
}

createRootWithPassiveTouch(document.getElementById('root')).render(
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
