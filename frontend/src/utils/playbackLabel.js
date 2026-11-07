// Название очереди, а не текущего трека или открытой сейчас страницы.
export function playbackLabel(state) {
  const context = state.playContext || {}
  const kind = context.kind || state.source
  const path = context.path || ''
  if (!state.currentTrack || kind === 'flow') return 'поток'
  if (kind === 'liked' || context.liked || path === '/liked') return 'Понравившиеся'
  if (context.title?.trim()) return context.title.trim()

  // Старые снимки плеера сохраняли путь, но ещё не сохраняли имя подборки.
  const artist = /^\/artists\/([^/]+)/.exec(path)
  if (artist) {
    try { return decodeURIComponent(artist[1]) } catch { return artist[1] }
  }
  if (kind === 'album' || path.startsWith('/albums/')) return state.currentTrack.album?.trim() || 'Альбом'
  if (kind === 'artist') return 'Исполнитель'
  if (kind === 'playlist' || path.startsWith('/playlists/') || path.startsWith('/external/') || path === '/link') return 'Плейлист'
  if (path === '/search') return 'Поиск'
  if (kind === 'wave' || path === '/') return 'Рекомендации'
  return 'Музыка'
}
