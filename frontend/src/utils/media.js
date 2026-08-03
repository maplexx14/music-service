import { SERVER_URL } from '../config'
import defaultCover from '../assets/default-cover.png'

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

// Резолвит URL обложки. highQuality=true — для полноэкранного плеера и
// системного виджета (апскейл CDN). highQuality=false (по умолчанию) —
// список треков, мини-плеер; экономит трафик и ускоряет загрузку.
export const resolveCoverUrl = (coverUrl, highQuality = false) => {
  if (!coverUrl) return null
  if (coverUrl.startsWith('http')) return highQuality ? upscaleCover(coverUrl) : coverUrl
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
