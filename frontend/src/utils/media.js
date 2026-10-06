import { API_URL, SERVER_URL } from '../config'
import defaultCover from '../assets/default-cover.webp'

// Размер обложки под место на экране. CDN провайдеров отдают один и тот же
// кадр в разных разрешениях, размер зашит в URL. Импорт кладёт в базу
// полноразмерные обложки (SoundCloud 500×500, Яндекс 400×400, Spotify
// 640×640), и раньше они без изменений уходили даже в строки списка по
// 48px: плейлист на сотню треков тянул мегабайты картинок. На iOS это
// особенно больно — мобильная сеть плюс декод крупных JPEG на каждый
// кадр прокрутки, обложки проявлялись с большой задержкой.
//   thumb — строки списков и мини-плеер (до ~64px на экране);
//   card  — карточки, шапки плейлистов (до ~200px);
//   full  — полноэкранный плеер и системный виджет.
const COVER_VARIANTS = {
  thumb: { google: 'w120-h120', yandex: '200x200', soundcloud: 't300x300', spotify: 'ab67616d00001e02', deezer: '250x250' },
  // Deezer — фото артистов в выборе любимых. Только стандартные размеры его
  // CDN (56/250/500/1000): они лежат готовыми и отдаются за ~40 мс, а любой
  // другой (320, 120) режется на лету — 0,2–0,7 с на холодную картинку
  // (замер с прода 2026-10-06), что и тормозило сетку на первом заходе.
  card: { google: 'w300-h300', yandex: '400x400', soundcloud: 't500x500', spotify: 'ab67616d00001e02', deezer: '500x500' },
  // Яндекс в full — те же 400: полноэкранный плеер ждёт прогрева обложки
  // (preloadCover, 450мс), а 1000×1000 весит в разы больше.
  // Google — 800 с качеством JPEG 75: обложка ytmusic 1200×1200 при родных
  // -l90 весила ~610 КБ, это в разы больше первых секунд аудио, и на узком
  // канале она качалась параллельно со стартом трека (виджет системы, прогрев
  // фуллскрина). 800/-l75 — ~200 КБ, на экране телефона разницы не видно.
  full: {
    google: 'w800-h800',
    googleQuality: 75,
    yandex: '400x400',
    soundcloud: 't500x500',
    spotify: 'ab67616d0000b273',
    deezer: '500x500',
  },
}

// Spotify кодирует размер префиксом id картинки: 4851 — 64px, 1e02 — 300px,
// b273 — 640px. Другие префиксы (мозаики плейлистов) не трогаем.
const SPOTIFY_ALBUM_SIZE_RE = /\/image\/ab67616d0000(?:4851|1e02|b273)/

const sizeCover = (url, size) => {
  const v = COVER_VARIANTS[size]
  if (!url || !v) return url
  if (url.includes('googleusercontent.com') || url.includes('ggpht.com')) {
    const sized = url.replace(/=w\d+-h\d+/, `=${v.google}`)
    // Качество меняем только там, где оно задано: у thumb/card URL остаётся
    // прежним — он уже лежит в кэше браузера и nginx.
    return v.googleQuality ? sized.replace(/(=w\d+-h\d+)-l\d+/, `$1-l${v.googleQuality}`) : sized
  }
  if (url.includes('ytimg.com')) {
    return size === 'full'
      ? url.replace(/\/(default|mqdefault|hqdefault|sddefault)\.jpg/, '/maxresdefault.jpg')
      : url
  }
  if (url.includes('sndcdn.com')) {
    return url.replace(/-(?:large|t\d+x\d+|crop|original)\.(jpg|png)/, `-${v.soundcloud}.$1`)
  }
  if (url.includes('avatars.yandex.net') || url.includes('avatars.mds.yandex.net')) {
    return url.replace(/\/(?:\d+x\d+|orig)$/, `/${v.yandex}`)
  }
  if (url.includes('dzcdn.net')) {
    return url.replace(/\/\d+x\d+-/, `/${v.deezer}-`)
  }
  if (url.includes('scdn.co')) {
    return url.replace(SPOTIFY_ALBUM_SIZE_RE, `/image/${v.spotify}`)
  }
  return url
}

// Внешние http(s)-обложки отдаются через бэкенд-прокси, а не напрямую с CDN
// провайдера: прямой выход к этим CDN с браузера мигает (окна, когда ВСЕ
// внешние обложки разом падают в дефолт-заглушку), а аудио при этом играет —
// оно идёт через наш прокси. Бэкенд тянет обложку через свой выход и кэширует.
const proxyExternalCover = (url) => `${API_URL}/tracks/cover-proxy?url=${encodeURIComponent(url)}`

// Резолвит URL обложки. Второй аргумент — размер: 'thumb' | 'card' | 'full'.
// true — прежняя форма записи для 'full', по умолчанию 'card'. Свои
// (загруженные) обложки лежат одним файлом — размер на них не влияет.
export const resolveCoverUrl = (coverUrl, size = 'card') => {
  if (!coverUrl) return null
  const variant = size === true ? 'full' : size === false ? 'card' : size
  if (coverUrl.startsWith('http')) return proxyExternalCover(sizeCover(coverUrl, variant))
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
