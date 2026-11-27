// Ссылки на другие сервисы (и плейлисты YouTube Music), которые можно послушать без импорта
// (GET /import/listen). Разбор здесь — только чтобы узнать ссылку в поиске;
// точный разбор и короткие ссылки резолвит бэкенд.

const KIND_LABELS = {
  track: 'Трек',
  album: 'Альбом',
  playlist: 'Плейлист',
  artist: 'Исполнитель',
  likes: 'Мне нравится',
}

const PATTERNS = [
  { service: 'Spotify', re: /open\.spotify\.com\/(?:intl-[a-z-]+\/)?(track|album|playlist|artist)\/[A-Za-z0-9]+/i },
  { service: 'Spotify', re: /^spotify:(track|album|playlist|artist):[A-Za-z0-9]+/i },
  { service: 'Spotify', re: /(?:spotify\.link|spotify\.app\.link)\/\S+/i },
  { service: 'Deezer', re: /deezer\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(track|album|playlist|artist)\/\d+/i },
  { service: 'Deezer', re: /(?:link\.deezer\.com|deezer\.page\.link|dzr\.page\.link)\/\S+/i },
  { service: 'YouTube Music', kind: 'playlist', re: /(?:music\.)?youtube\.com\/playlist\?(?:\S*&)?list=(?!RD)[\w-]{10,}/i },
  { service: 'Яндекс Музыка', re: /music\.yandex\.[a-z]+\/(?:users\/[^/\s]+\/)?(album|playlists?|track)\b/i },
]

/** Строка → { service, kind } для ссылки на трек/коллекцию или null. */
export function parseMusicLink(text) {
  const value = (text || '').trim()
  if (!value || /\s/.test(value)) return null
  for (const { service, re, kind: fixedKind } of PATTERNS) {
    const match = value.match(re)
    if (!match) continue
    let kind = fixedKind || (match[1] || '').toLowerCase()
    if (kind === 'playlists') kind = 'playlist'
    // У Яндекса трек живёт внутри альбома: /album/1/track/2.
    if (/\/track\/\d+/.test(value)) kind = 'track'
    return { service, kind, label: KIND_LABELS[kind] || 'Ссылка' }
  }
  return null
}

export const linkPagePath = (url) => `/link?url=${encodeURIComponent(url.trim())}`
