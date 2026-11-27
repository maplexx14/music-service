import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'

export function httpUrl(value, base) {
  const url = new URL(value, base)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Ожидается ссылка HTTP или HTTPS.')
  }
  return url
}

async function request(url, timeout = 25_000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeout) })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`${new URL(url).hostname} вернул HTTP ${response.status}`)
  }
  return response
}

const json = async (url, timeout) => (await request(url, timeout)).json()
const html = async url => (await request(url)).text()

export function api(origin, route, params) {
  const url = new URL('/api/' + route, origin)
  url.search = new URLSearchParams(params)
  return url
}

function meta(page, property) {
  for (const tag of page.matchAll(/<meta\s+[^>]+>/gi)) {
    const attrs = Object.fromEntries([...tag[0].matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)]
      .map(([, key, , value]) => [key, value]))
    if ((attrs.property || attrs.name) !== property) continue
    const entities = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' }
    return attrs.content?.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (entity, code) => {
      if (code[0] !== '#') return entities[code.toLowerCase()]
      const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1))
      return point <= 0x10ffff ? String.fromCodePoint(point) : entity
    })
  }
}

function normalize(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

function sameRecording(first, second) {
  return normalize(first.title) === normalize(second.title)
    && normalize(first.artist) === normalize(second.artist)
}

function rank(track, query) {
  const title = normalize(track.title)
  const artist = normalize(track.artist)
  const key = normalize(query)
  if ([`${artist} ${title}`, `${title} ${artist}`].includes(key)) return 2
  return Number(title === key)
}

async function catalog(origin, query) {
  const [external, local] = await Promise.allSettled([
    json(api(origin, 'search/external', { q: query, limit: 14 })),
    json(api(origin, 'search/', { q: query, limit: 14 })),
  ])
  if (external.status === 'rejected' && local.status === 'rejected') {
    throw new Error(`Поиск Bolt недоступен на ${origin}: ${external.reason.message}`)
  }
  const tracks = [...(external.value ?? []), ...(local.value?.tracks ?? [])]
  return tracks.filter(track => track.title && track.stream_url)
    .sort((a, b) => rank(b, query) - rank(a, query))
}

async function providerMetadata(url) {
  const host = url.hostname.toLowerCase()
  const pathname = url.pathname
  if (host === 'open.spotify.com') {
    const id = pathname.match(/\/(?:intl-[a-z-]+\/|embed\/)?track\/([\da-z]+)\/?$/i)?.[1]
    if (!id) throw new Error('Укажите ссылку на отдельный трек Spotify.')
    const page = await html(`https://open.spotify.com/embed/track/${id}`)
    const data = page.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s)?.[1]
    const track = data && JSON.parse(data).props?.pageProps?.state?.data?.entity
    return {
      title: track?.name,
      artist: track?.artists?.map(item => item.name).join(', '),
      duration: track?.duration / 1000,
    }
  }
  if (/^music\.yandex\.[a-z]+$/.test(host)) {
    const id = pathname.match(/\/track\/(\d+)\/?$/)?.[1]
    if (!id) throw new Error('Укажите ссылку на отдельный трек Яндекс Музыки.')
    const track = (await json(`https://api.music.yandex.net/tracks/${id}`)).result?.[0]
    return {
      title: track?.version ? `${track.title} (${track.version})` : track?.title,
      artist: track?.artists?.map(item => item.name).join(', '),
      duration: track?.durationMs / 1000,
    }
  }
  if (/^(?:www\.)?deezer\.com$/.test(host)) {
    const id = pathname.match(/\/track\/(\d+)\/?$/)?.[1]
    if (!id) throw new Error('Укажите ссылку на отдельный трек Deezer.')
    const track = await json(`https://api.deezer.com/track/${id}`)
    return { title: track.title, artist: track.artist?.name, duration: track.duration }
  }
  return null
}

async function resolveLink(origin, input) {
  const host = input.hostname.toLowerCase()
  const path = input.pathname
  if (/^(?:www\.|m\.|music\.)?youtube\.com$|^youtu\.be$/.test(host)) {
    const id = input.searchParams.get('v') || path.match(/^\/(?:shorts\/|embed\/|live\/)?([\w-]{11})\/?$/)?.[1]
    if (!/^[\w-]{11}$/.test(id ?? '')) throw new Error('Укажите ссылку на отдельный трек YouTube.')
    const embed = new URL('https://www.youtube.com/oembed')
    embed.search = new URLSearchParams({ url: `https://www.youtube.com/watch?v=${id}`, format: 'json' })
    const info = await json(embed)
    const artist = info.author_name.replace(/ - Topic$/, '')
    const stream_url = api(origin, `ytdlp/stream/${id}`).href
    return {
      id: `ytmusic:${id}`, external_id: id, source: 'ytmusic',
      title: info.title, artist, cover_url: info.thumbnail_url, stream_url,
    }
  }

  if (/^(?:www\.|m\.|on\.)?soundcloud\.com$|^snd\.sc$/.test(host)) {
    const response = await request(input)
    const url = httpUrl(response.url)
    const page = await response.text()
    const id = meta(page, 'twitter:app:url:googleplay')?.match(/^soundcloud:\/\/sounds:(\d+)$/)?.[1]
    const title = meta(page, 'og:title')
    if (!id || !title || !['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com'].includes(url.hostname)) {
      throw new Error('По ссылке SoundCloud не найден отдельный публичный трек.')
    }
    const permalink = 'https://soundcloud.com' + url.pathname.replace(/\/$/, '')
    const token = Buffer.from(`${id}|${permalink}`).toString('base64url')
    const artist = page.match(/"publisher_metadata":\{[^{}]*"artist":"([^"]+)"/)?.[1]
      || meta(page, 'og:description')?.match(/ by (.*?) #np on #SoundCloud/)?.[1] || ''
    return {
      id: `soundcloud:${id}`, external_id: id, source: 'soundcloud',
      title, artist, cover_url: meta(page, 'og:image'), stream_url: api(origin, `soundcloud/stream/${token}`).href,
    }
  }

  const id = path.match(/^\/track\/([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})\/?$/i)?.[1]
  if (id) {
    const page = await html(input)
    const label = meta(page, 'og:title')
    if (meta(page, 'og:type') !== 'music.song' || !label) throw new Error('Трек по ссылке Bolt не найден.')
    const dash = label.indexOf(' — ')
    return {
      id, source: 'local',
      title: dash < 0 ? label : label.slice(dash + 3),
      artist: dash < 0 ? '' : label.slice(0, dash),
      cover_url: meta(page, 'og:image'), duration: Number(meta(page, 'music:duration')),
      stream_url: api(input.origin, `tracks/${id}/stream`).href,
    }
  }
  const metadata = await providerMetadata(input)
  if (metadata) {
    if (metadata.title && metadata.artist) return metadata
    throw new Error('Сервис не вернул название и исполнителя трека.')
  }
  throw new Error('Поддерживаются ссылки Bolt, YouTube / YouTube Music, SoundCloud, Spotify, Яндекс Музыки и Deezer.')
}

export async function resolveTrack(origin, input) {
  const isLink = /^https?:\/\//i.test(input)
  if (isLink) {
    const linked = await resolveLink(origin, httpUrl(input))
    const query = [linked.title, linked.artist].filter(Boolean).join(' ')
    if (!linked.stream_url) {
      const results = await catalog(origin, query)
      const matches = results.filter(track => sameRecording(track, linked) && (
        !linked.duration || !track.duration || Math.abs(track.duration - linked.duration) <= 6
      ))
      if (!matches.length) throw new Error(`В Bolt не найдена запись «${linked.artist} — ${linked.title}».`)
      return { query, selected: matches[0], results, audioChoices: matches }
    }
    const results = await catalog(origin, query).catch(() => [])
    const exact = results.find(track => track.id === linked.id ||
      (linked.external_id && track.source === linked.source && track.external_id === linked.external_id))
    const selected = { ...linked, ...(exact ?? {}), cover_url: exact?.cover_url || linked.cover_url }
    return { query, selected, results, audioChoices: [selected] }
  }

  const results = await catalog(origin, input)
  const [selected] = results
  if (!selected) throw new Error(`Трек «${input}» не найден в Bolt.`)
  const audioChoices = [selected, ...results.slice(1).filter(track => sameRecording(track, selected))]
  return { query: input, selected, results, audioChoices }
}

export async function downloadAudio(origin, track, filename) {
  const response = await request(httpUrl(track.stream_url, origin), 90_000)
  const contentType = response.headers.get('content-type') || ''
  if (/text\/html|application\/json|mpegurl/i.test(contentType)) {
    await response.body.cancel()
    throw new Error('Bolt не вернул аудиофайл.')
  }
  await pipeline(response.body, createWriteStream(filename))
}

export async function lookupLyrics({ artist, title, duration }) {
  if (!artist || !title) return null
  const params = { artist_name: artist, track_name: title }
  const url = new URL('https://lrclib.net/api/get')
  url.search = new URLSearchParams({ ...params, duration: Math.round(duration) })
  const response = await fetch(url, {
    headers: { 'User-Agent': 'bolt-track-video/1.0 (https://boltmusic.lat)' },
    signal: AbortSignal.timeout(8_000),
  })
  let entries
  if (response.ok) {
    entries = [await response.json()]
  } else {
    await response.body?.cancel()
    if (response.status !== 404) throw new Error(`LRCLIB вернул HTTP ${response.status}`)
    url.pathname = '/api/search'
    url.search = new URLSearchParams(params)
    entries = await json(url, 8_000)
  }
  const matches = entries.filter(entry =>
    sameRecording({ title: entry.trackName, artist: entry.artistName }, { title, artist }))
  const timed = matches.find(entry => Math.abs(entry.duration - duration) <= 3 &&
    /^\[\d{2}:\d{2}\.\d{2,3}\][ \t]*\S/m.test(entry.syncedLyrics ?? ''))
  if (timed) return { synced: timed.syncedLyrics }
  const plain = matches.find(entry => entry.plainLyrics?.trim())
  return plain ? { plain: plain.plainLyrics } : null
}
