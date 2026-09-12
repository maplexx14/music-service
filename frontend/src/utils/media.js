import { API_URL, SERVER_URL } from '../config'
import defaultCover from '../assets/default-cover.webp'

// Просит у CDN Google обложку большего разрешения. Обложки YouTube Music
// приходят крошечными (120×120), но размер зашит в URL и CDN ресайзит по
// запросу. Применяется к URL при отображении в полноэкранном плеере и
// системном виджете (где нужна высокая детализация).
const upscaleCover = (url) => {
  if (!url) return url
  if (url.includes('googleusercontent.com') || url.includes('ggpht.com')) {
    return url.replace(/=w\d+-h\d+/, '=w1200-h1200')
  }
  if (url.includes('ytimg.com')) {
    return url.replace(/\/(default|mqdefault|hqdefault|sddefault)\.jpg/, '/maxresdefault.jpg')
  }
  return url
}

// Внешние http(s)-обложки отдаются через бэкенд-прокси, а не напрямую с CDN
// провайдера: прямой выход к этим CDN с браузера мигает (окна, когда ВСЕ
// внешние обложки разом падают в дефолт-заглушку), а аудио при этом играет —
// оно идёт через наш прокси. Бэкенд тянет обложку через свой выход и кэширует.
const proxyExternalCover = (url) => `${API_URL}/tracks/cover-proxy?url=${encodeURIComponent(url)}`

// Резолвит URL обложки. highQuality=true — для полноэкранного плеера и
// системного виджета (апскейл CDN). highQuality=false (по умолчанию) —
// список треков, мини-плеер; экономит трафик и ускоряет загрузку.
export const resolveCoverUrl = (coverUrl, highQuality = false) => {
  if (!coverUrl) return null
  if (coverUrl.startsWith('http')) return proxyExternalCover(highQuality ? upscaleCover(coverUrl) : coverUrl)
  if (coverUrl.startsWith('/')) return `${SERVER_URL}${coverUrl}`
  return `${SERVER_URL}/${coverUrl}`
}

// Fallback to the default cover when a track/playlist image fails to load
// (broken URL, 404, etc.). Guarded to avoid an infinite loop if the default
// itself ever fails.
export const handleCoverError = (e) => {
  if (e.currentTarget.src.endsWith(defaultCover)) return
  e.currentTarget.src = defaultCover
}

// Прогрев обложки до показа: скачивание + декод. Резолвится true, когда
// картинка готова к мгновенной отрисовке, false — по ошибке или таймауту
// (холодная сеть не должна блокировать открытие плеера дольше предела).
// Без crossOrigin: no-cors, как у обычного <img>, — та же ячейка кэша,
// что у плеера (decode не «пачкает» canvas, чтение пикселей не нужно).
export const preloadCover = (url, timeoutMs = 450) => {
  if (!url) return Promise.resolve(false)
  return new Promise((resolve) => {
    const img = new Image()
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(ok)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    img.onload = () => {
      // decode() отдельно от load: load значит «скачано», decode —
      // «готово к рисованию без задержки на декодирование».
      if (typeof img.decode === 'function') {
        img.decode().then(() => finish(true), () => finish(false))
      } else {
        finish(true)
      }
    }
    img.onerror = () => finish(false)
    img.src = url
  })
}
