// Разбор строки исполнителя на отдельные имена и ссылки на их страницы.
//
// Зеркало backend/app/artist_utils.py (split_artists) — правила разбора должны
// совпадать: фронт по ним рисует ссылки, бэк по ним же отбирает треки артиста
// в выдаче SoundCloud. Меняя разделители здесь, поменяйте и там.
//
// «/» разделителем НЕ считается (AC/DC), точка в «feat.» съедается явно:
// после неё границы слова нет и имя осталось бы с осиротевшей точкой.
const ARTIST_SPLIT_RE =
  /\s*(?:,|;|&|·|•|\bfeat\.?(?=\s|$)|\bft\.?(?=\s|$)|\bwith(?=\s)|\bvs\.?(?=\s|$)|\bx(?=\s))\s*/gi

const artistKey = (name) => (name || '').trim().toLowerCase().replace(/\s+/g, ' ')

// ['Linkin Park', 'Jay-Z'] из 'Linkin Park, Jay-Z'. Пустые куски и повторы
// отбрасываются; если разбирать нечего — возвращаем исходную строку, чтобы у
// трека всегда был хотя бы один кликабельный исполнитель.
export const splitArtists = (name) => {
  const parts = []
  const seen = new Set()
  for (const raw of (name || '').split(ARTIST_SPLIT_RE)) {
    const piece = (raw || '').replace(/^[\s\-–—]+|[\s\-–—]+$/g, '')
    const key = artistKey(piece)
    if (!key || seen.has(key)) continue
    seen.add(key)
    parts.push(piece)
  }
  if (parts.length > 0) return parts
  const fallback = (name || '').trim()
  return fallback ? [fallback] : []
}

// Путь к странице исполнителя. encodeURIComponent обязателен: в именах
// встречаются «/», «?» и «#», а без экранирования они разваливают маршрут.
export const artistPath = (name) => `/artists/${encodeURIComponent(name)}`
