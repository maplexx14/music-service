import { buildRecentPlaylist, filterRecentTracks, formatTimeAgo, normalizeLastPlayed, sortRecentTracks } from './recentlyPlayed'

const now = Date.now()

const makeTrack = (id, msAgo) => ({
  id,
  title: `t${id}`,
  last_played: new Date(now - msAgo).toISOString(),
})

describe('recentlyPlayed utils', () => {
  it('normalizes last played timestamps', () => {
    const track = makeTrack(1, 0)
    expect(normalizeLastPlayed(track)).toBeLessThanOrEqual(now)
  })

  it('returns null when no last played field', () => {
    expect(normalizeLastPlayed({ id: 1 })).toBeNull()
  })

  it('normalizes numeric lastPlayedAt field', () => {
    const ts = now - 1000
    expect(normalizeLastPlayed({ lastPlayedAt: ts })).toBe(ts)
  })

  it('filters tracks by 48 hour window', () => {
    const within = makeTrack(1, 2 * 60 * 60 * 1000)
    const outside = makeTrack(2, 72 * 60 * 60 * 1000)
    const result = filterRecentTracks([within, outside], now, 48)
    expect(result.map(t => t.id)).toEqual([1])
  })

  it('sorts by last played descending', () => {
    const newest = makeTrack(1, 1000)
    const older = makeTrack(2, 5000)
    const missing = { id: 3 }
    const result = sortRecentTracks([older, missing, newest])
    expect(result[0].id).toBe(1)
  })

  it('formats time ago labels', () => {
    expect(formatTimeAgo('invalid', now)).toBe('Слушали недавно')
    expect(formatTimeAgo(now - 30 * 1000, now)).toBe('Слушали только что')
    expect(formatTimeAgo(now - 60 * 1000, now)).toBe('Слушали 1 минуту назад')
    expect(formatTimeAgo(now - 5 * 60 * 1000, now)).toBe('Слушали 5 минут назад')
    expect(formatTimeAgo(now - 60 * 60 * 1000, now)).toBe('Слушали 1 час назад')
    expect(formatTimeAgo(now - 2 * 60 * 60 * 1000, now)).toBe('Слушали 2 часа назад')
    expect(formatTimeAgo(now - 24 * 60 * 60 * 1000, now)).toBe('Слушали 1 день назад')
    expect(formatTimeAgo(now - 2 * 24 * 60 * 60 * 1000, now)).toBe('Слушали 2 дня назад')
    expect(formatTimeAgo(now - 5 * 24 * 60 * 60 * 1000, now)).toBe('Слушали 5 дней назад')
  })

  it('builds recent playlist efficiently for large datasets', () => {
    const tracks = Array.from({ length: 10000 }, (_, i) => makeTrack(i + 1, i * 1000))
    const start = performance.now()
    const result = buildRecentPlaylist(tracks, now, 48)
    const duration = performance.now() - start
    expect(result.length).toBe(10000)
    expect(duration).toBeLessThan(300)
  })
})
