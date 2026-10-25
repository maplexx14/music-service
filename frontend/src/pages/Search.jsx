import { useState, useEffect, useMemo } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { Download } from 'lucide-react'
import { usePlayerStore, trackIntentHandlers } from '../store/playerStore'
import { useSearchStore } from '../store/searchStore'
import api from '../services/api'
import { intentPrefetchHandlers, prefetchArtist, prefetchCache } from '../services/pageCache'
import Spinner from '../components/Spinner'
import ArtistLink from '../components/ArtistLink'
import Carousel from '../components/Carousel'
import { useTrackContextMenu, TrackContextMenu } from '../components/TrackContextMenu'
import defaultCover from '../assets/default-cover.webp'
import { resolveCoverUrl, handleCoverError } from '../utils/media'
import { artistPath } from '../utils/artists'
import { formatDuration } from '../utils/format'
import { parseMusicLink, linkPagePath } from '../utils/musicLinks'
import SourceIcon from '../components/SourceIcon'
import './Search.css'

// Пауза набора перед запросом. 600мс ощущались как «поиск думает»: локальная
// выдача отвечает из кэша бэка за десятки мс, ждать дольше незачем.
const SEARCH_DEBOUNCE_MS = 350

// Фильтр выдачи: «Все» или один источник треков. С фильтром страница
// показывает только его секцию — без исполнителей, плейлистов и пользователей.
const SEARCH_FILTERS = [
  { id: 'all', label: 'Все' },
  { id: 'top', label: 'Лучшие' },
  { id: 'library', label: 'Медиатека' },
  { id: 'ytmusic', label: 'YouTube Music' },
  { id: 'soundcloud', label: 'SoundCloud' },
  { id: 'deezer', label: 'Deezer' },
  { id: 'spotify', label: 'Spotify' },
]

// Deezer и Spotify ищутся только под своим фильтром: звука там нет, каждому
// результату бэк подбирает запись в YouTube Music, и в «Все» это были бы
// дубли выдачи YouTube Music ценой секунд подбора.
const PROVIDER_FILTERS = new Set(['deezer', 'spotify'])
const PROVIDER_LABELS = { deezer: 'Deezer', spotify: 'Spotify' }

// Поиск Spotify работает только с ключами на бэке — без них фильтр прячем.
// Статус один на сессию.
let spotifyStatusPromise = null
const fetchSpotifyEnabled = () => {
  spotifyStatusPromise ??= api
    .get('/spotify/status', { skipErrorToast: true })
    .then(({ data }) => !!data?.configured)
    .catch(() => false)
  return spotifyStatusPromise
}

// «Лучшие совпадения» из своей медиатеки: локальный поиск отвечает за доли
// секунды, внешний — за секунды, и точное совпадение из базы не должно ждать
// YouTube. Скоринг повторяет aggregate._relevance на бэке: 3 — название или
// «артист название» целиком, 2 — все слова запроса есть в артисте/названии.
const LIBRARY_TOP_LIMIT = 3

const normalizeText = (s) =>
  (s || '').toLowerCase().replace(/[^\p{L}\p{N}_\s]/gu, ' ').replace(/\s+/g, ' ').trim()

const relevance = (track, qNorm, tokens) => {
  const title = normalizeText(track.title)
  const artist = normalizeText(track.artist)
  if ([title, `${artist} ${title}`, `${title} ${artist}`].includes(qNorm)) return 3
  const words = new Set(`${artist} ${title}`.split(' '))
  return tokens.every((token) => words.has(token)) ? 2 : 0
}

// Ремикс, ускорение, кавер — как artist_utils.is_derivative_title на бэке.
// При равном счёте оригинал идёт раньше, если запрос сам не просит версию.
const DERIVATIVE_ANYWHERE =
  /remix|ремикс|\brmx\b|mash\s*-?\s*up|мэшап|мешап|bootleg|бутлег|sped\s*up|speed\s*up|ускор|slowed|замедл|nightcore|найткор|karaoke|караоке|\b8d\b|bass\s*boost|\bvip\s*mix|\brework\b/i
const DERIVATIVE_TAGGED =
  /(?:[([]|\s[-–—|]\s)[^()[\]]*?(?:\bcover\b|кавер|instrumental|инструментал|(?<!\p{L})минус(?!\p{L})|reverb|реверб|\bflip\b|\bedit\b(?<!radio edit))/iu
const isDerivativeTitle = (title) =>
  DERIVATIVE_ANYWHERE.test(title || '') || DERIVATIVE_TAGGED.test(title || '')

// Тот же трек в медиатеке и во внешней выдаче — как aggregate.dedup_key.
const sameTrackKey = (track) =>
  `${normalizeText(track.artist)}|${normalizeText((track.title || '').replace(/\bfeat\.?\b.*$/i, ''))}`

// Медиатека + внешний топ одним списком, лучшие первыми; при равном счёте
// медиатека раньше (она играет сразу из нашего хранилища). Внешний топ бэк
// уже вырезал из секций источников, поэтому его не обрезаем — иначе треки
// пропали бы из выдачи совсем; выкидываем только дубли медиатеки.
const mergeTopTracks = (query, libraryTracks, externalTop) => {
  const qNorm = normalizeText(query)
  const tokens = qNorm.split(' ').filter(Boolean)
  if (tokens.length === 0) return externalTop
  const wantDerivative = isDerivativeTitle(query)
  const derivative = (track) => (!wantDerivative && isDerivativeTitle(track.title) ? 1 : 0)
  const library = libraryTracks
    .map((track) => ({ track, score: relevance(track, qNorm, tokens) }))
    .filter((item) => item.score >= 2)
    .sort((a, b) => b.score - a.score || derivative(a.track) - derivative(b.track))
    .slice(0, LIBRARY_TOP_LIMIT)
  // Внешний топ бэк отобрал со счётом не ниже 2; заново считаем, только чтобы
  // поднять точные совпадения (clean_title бэка тут нет — отсюда max).
  const external = externalTop.map((track) => ({
    track,
    score: Math.max(2, relevance(track, qNorm, tokens)),
  }))
  const seen = new Set()
  return [...library, ...external]
    .sort((a, b) => b.score - a.score || derivative(a.track) - derivative(b.track))
    .filter(({ track }) => {
      const key = sameTrackKey(track)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map(({ track }) => track)
}

// Формат записи совпадает с тем, что кладёт в кэш страница ExternalPlaylist.
const prefetchExternalPlaylist = (id) =>
  prefetchCache(`external-playlist:${id}`, `/soundcloud/playlists/${id}`, {
    select: (response) => ({ playlist: response.data.playlist, tracks: response.data.tracks }),
    maxAgeMs: 10 * 60 * 1000,
  })

function Search() {
  const navigate = useNavigate()
  // Всё, что должно пережить уход на другую вкладку, — в сторе: роутер
  // размонтирует страницу, и локальный useState обнулял запрос вместе с выдачей.
  const query = useSearchStore((state) => state.query)
  const setQuery = useSearchStore((state) => state.setQuery)
  const results = useSearchStore((state) => state.results)
  const resultsQuery = useSearchStore((state) => state.resultsQuery)
  // Внешние источники держим раздельно: выдача показывает их отдельными
  // секциями в фиксированном порядке (см. рендер ниже).
  const externalTracks = useSearchStore((state) => state.externalTracks)
  const externalPlaylists = useSearchStore((state) => state.externalPlaylists)
  const artists = useSearchStore((state) => state.artists)
  const searchError = useSearchStore((state) => state.searchError)
  const filter = useSearchStore((state) => state.filter)
  const setFilter = useSearchStore((state) => state.setFilter)
  const providerTracks = useSearchStore((state) => state.providerTracks)
  const [providerLoading, setProviderLoading] = useState(false)
  const [spotifyEnabled, setSpotifyEnabled] = useState(false)
  const [loading, setLoading] = useState(false)
  // Внешний каталог отвечает за 2–5 с — дольше локальной выдачи, после
  // которой гаснет основной спиннер. Без своего индикатора страница успевала
  // показать «Ничего не найдено», а треки появлялись через секунды.
  const [externalLoading, setExternalLoading] = useState(false)
  // Long-press / правый клик на треке — контекстное меню (лайк и др.).
  const trackMenu = useTrackContextMenu()

  // Вставленная ссылка Spotify/Deezer/Яндекса — не запрос, а то, что надо
  // открыть: каталог по ней искать бессмысленно.
  const musicLink = useMemo(() => parseMusicLink(query), [query])

  useEffect(() => {
    let cancelled = false
    fetchSpotifyEnabled().then((enabled) => {
      if (cancelled) return
      setSpotifyEnabled(enabled)
      // Фильтр Spotify мог остаться в сторе, а ключи с бэка убрали.
      if (!enabled && useSearchStore.getState().filter === 'spotify') setFilter('all')
    })
    return () => {
      cancelled = true
    }
  }, [])
  const filters = spotifyEnabled ? SEARCH_FILTERS : SEARCH_FILTERS.filter((f) => f.id !== 'spotify')

  // Выдача Deezer/Spotify — под своим фильтром и только для текущего запроса.
  const providerQuery = query.trim()
  const providerResult = PROVIDER_FILTERS.has(filter) ? providerTracks[filter] : null
  const currentProviderTracks =
    providerResult && providerResult.q === providerQuery ? providerResult.tracks : []

  useEffect(() => {
    if (!PROVIDER_FILTERS.has(filter) || !providerQuery || parseMusicLink(providerQuery)) {
      setProviderLoading(false)
      return
    }
    if (useSearchStore.getState().providerTracks[filter]?.q === providerQuery) {
      setProviderLoading(false)
      return
    }
    const controller = new AbortController()
    setProviderLoading(true)
    const timeoutId = window.setTimeout(() => {
      api
        .get(`/import/search/${filter}`, {
          params: { q: providerQuery },
          // Холодный подбор двадцати результатов — несколько секунд.
          timeout: 0,
          skipErrorToast: true,
          signal: controller.signal,
        })
        .then(({ data }) => {
          useSearchStore.getState().setProviderTracks(filter, providerQuery, data || [])
          usePlayerStore.getState().prefetchTracks(data || [], 1)
        })
        .catch((error) => {
          if (controller.signal.aborted) return
          console.error(`${filter} search error:`, error)
          useSearchStore.getState().setSearchError(`Не удалось выполнить поиск в ${PROVIDER_LABELS[filter]}.`)
        })
        .finally(() => {
          if (!controller.signal.aborted) setProviderLoading(false)
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timeoutId)
      controller.abort()
      // Оборванный запрос свой finally пропускает — снимаем спиннер здесь.
      setProviderLoading(false)
    }
  }, [filter, providerQuery])

  useEffect(() => {
    const searchQuery = query.trim()
    if (searchQuery.length > 0 && !parseMusicLink(searchQuery)) {
      // Возврат на страницу с той же строкой: выдача уже в сторе целиком,
      // повторять четыре запроса незачем.
      if (useSearchStore.getState().cachedQuery === searchQuery) return

      const controller = new AbortController()
      const timeoutId = window.setTimeout(() => {
        performSearch(searchQuery, controller.signal)
      }, SEARCH_DEBOUNCE_MS)
      return () => {
        window.clearTimeout(timeoutId)
        controller.abort()
      }
    }

    useSearchStore.getState().clearSearch()
    setLoading(false)
    setExternalLoading(false)
  }, [query])

  const performSearch = async (searchQuery, signal) => {
    const {
      beginSearch,
      setResults,
      setExternalTracks,
      setExternalPlaylists,
      setArtists,
      setSearchError,
      finishSearch,
    } = useSearchStore.getState()

    setLoading(true)
    // Старые внешние результаты чистим сразу: они дорисуются позже и не
    // должны миксоваться с новым запросом.
    beginSearch()

    // Исполнители — отдельным лёгким запросом: секция только ведёт на
    // страницу артиста и не должна ждать медленную выдачу треков.
    const artistsRequest = api
      .get('/artists/search', {
        params: { q: searchQuery, limit: 12 },
        skipErrorToast: true,
        signal,
      })
      .then((response) => {
        if (!signal.aborted) setArtists(response.data || [])
      })
      .catch((error) => {
        if (!signal.aborted) console.error('Artist search error:', error)
      })

    // Внешний каталог медленный (секунды) — не блокируем им локальную выдачу,
    // его секции дорисовываются по мере прихода ответов.
    setExternalLoading(true)
    const externalRequest = api
      .get('/search/external/grouped', {
        // Слоты делятся между источниками (каталог артиста / YouTube Music /
        // SoundCloud), поэтому на каждый приходится примерно треть лимита.
        params: { q: searchQuery, limit: 45 },
        skipErrorToast: true,
        signal,
      })
      .then((response) => {
        if (signal.aborted) return
        const grouped = {
          top: response.data?.top || [],
          ytmusic: response.data?.ytmusic || [],
          soundcloud: response.data?.soundcloud || [],
        }
        setExternalTracks(grouped)
        // Прогреваем резолв топ-нескольких результатов заранее — большинство
        // кликов приходится на верх списка, и к моменту клика резолв уже тёплый.
        // Ограничиваем прогрев видимой верхушкой, чтобы поиск не создавал
        // всплеск фоновых запросов на слабом клиенте или под нагрузкой.
        // ytmusic — только первый: каждый прогрев это резолв в YouTube, а
        // объём резолвов с нашего IP и вызывает bot-check. Остальное греет
        // hover/pointerdown (prefetchOnIntent) перед реальным кликом.
        // Есть блок «Лучшие совпадения» — греем только его: туда уходят самые
        // вероятные клики, а остальные секции греет intent-префетч.
        if (grouped.top.length > 0) {
          usePlayerStore.getState().prefetchTracks(grouped.top, 1)
        } else {
          usePlayerStore.getState().prefetchTracks(grouped.ytmusic, 1)
          usePlayerStore.getState().prefetchTracks(grouped.soundcloud, 2)
        }
      })
      .catch((error) => {
        if (!signal.aborted) console.error('External search error:', error)
      })
      .finally(() => {
        if (!signal.aborted) setExternalLoading(false)
      })
    const externalPlaylistsRequest = api
      .get('/search/external/playlists', {
        params: { q: searchQuery, limit: 10 },
        skipErrorToast: true,
        signal,
      })
      .then((response) => {
        if (!signal.aborted) setExternalPlaylists(response.data)
      })
      .catch((error) => {
        if (!signal.aborted) console.error('External playlist search error:', error)
      })

    let localSucceeded = false
    try {
      // Слэш в конце: без него FastAPI отвечает 307, и каждый поиск платил
      // лишний раунд-трип до первой выдачи.
      const response = await api.get('/search/', {
        // 50, а не 20: при поиске по имени артиста выдача — это его треки,
        // и на двадцати позициях дискография обрывается на середине.
        params: { q: searchQuery, limit: 50 },
        // Ошибку показывает сама страница (searchError) — тост её дублировал.
        skipErrorToast: true,
        signal,
      })
      if (signal.aborted) return
      setResults(response.data, searchQuery)
      localSucceeded = true
    } catch (error) {
      if (signal.aborted) return
      console.error('Local search error:', error)
      setResults({ tracks: [], playlists: [] })
      setSearchError('Не удалось выполнить поиск. Попробуйте ещё раз.')
    } finally {
      if (!signal.aborted) setLoading(false)
    }

    // Закешированным запрос считается только когда дособраны все секции.
    // Выдачу, оборванную уходом на другую вкладку, возврат должен догрузить,
    // а не принять за готовую — иначе внешние секции пропадут насовсем.
    await Promise.allSettled([artistsRequest, externalRequest, externalPlaylistsRequest])
    if (!signal.aborted && localSucceeded) finishSearch(searchQuery)
  }

  const topTracks = useMemo(
    () => mergeTopTracks(resultsQuery, results.tracks, externalTracks.top),
    [resultsQuery, results.tracks, externalTracks.top],
  )
  // Поднятые в «Лучшие» треки медиатеки из её секции убираем — кроме фильтра
  // «Медиатека», где она показывается целиком.
  const libraryTracks = useMemo(() => {
    if (filter === 'library') return results.tracks
    const lifted = new Set(topTracks.map((track) => track.id))
    return results.tracks.filter((track) => !lifted.has(track.id))
  }, [filter, results.tracks, topTracks])

  const handlePlayTrack = (track) => {
    const { playTrack } = usePlayerStore.getState()
    playTrack(track, libraryTracks)
  }

  // Очередь — список своей секции: клик по треку из YouTube Music продолжает
  // выдачу YouTube Music, а не прыгает в SoundCloud.
  const handlePlayExternalTrack = (track, queue) => {
    const { playTrack } = usePlayerStore.getState()
    playTrack(track, queue, 'external')
  }

  const handleImportExternalPlaylist = (playlist) => {
    // Открываем просмотр — импорт в библиотеку только по явной кнопке там.
    navigate(`/external/soundcloud/playlists/${playlist.external_id}`)
  }

  const showAll = filter === 'all'
  const shows = (id) => (showAll && !PROVIDER_FILTERS.has(id)) || filter === id
  // Спиннер внешнего поиска нужен, только если его секции вообще видны.
  const waitingExternal = externalLoading && filter !== 'library' && !PROVIDER_FILTERS.has(filter)

  const hasResults = showAll
    ? results.tracks.length > 0 ||
      topTracks.length > 0 ||
      externalTracks.ytmusic.length > 0 ||
      externalTracks.soundcloud.length > 0 ||
      results.playlists.length > 0 ||
      externalPlaylists.length > 0 ||
      artists.length > 0
    : {
        top: topTracks,
        library: results.tracks,
        ytmusic: externalTracks.ytmusic,
        soundcloud: externalTracks.soundcloud,
        deezer: currentProviderTracks,
        spotify: currentProviderTracks,
      }[filter].length > 0

  // Секция внешних треков: разметка одна на оба источника, отличаются только
  // заголовком и списком.
  const renderExternalSection = (title, tracks) => {
    if (tracks.length === 0) return null
    return (
      <div className="results-section">
        <h2 className="results-title">{title}</h2>
        <div className="tracks-list">
          {tracks.map((track) => (
            // intent-префетч: наведение/касание строки прогревает резолв на
            // бэке до клика — важно для результатов ниже топ-4 (их автопрогрев
            // не покрывает, см. performSearch).
            <div
              key={track.id}
              className="track-item"
              data-fast-tap=""
              onClick={() => handlePlayExternalTrack(track, tracks)}
              {...trackIntentHandlers(track)}
              {...trackMenu.getProps(track)}
            >
              <span className="source-cover">
                <img
                  src={resolveCoverUrl(track.cover_url, 'thumb') || defaultCover}
                  alt={track.title}
                  className="track-item-cover"
                  loading="lazy"
                  decoding="async"
                  onError={handleCoverError}
                />
                <SourceIcon source={track.provider || track.source} />
              </span>
              <div className="track-item-info">
                <div className="track-item-title">
                  {track.title}
                  {/* E — оригинал с явным контентом, CLEAN — цензурная
                      редакция: см. aggregate._mark_clean / ytdlp.is_explicit. */}
                  {track.is_explicit && <span className="track-badge track-badge-e">E</span>}
                  {track.is_clean && <span className="track-badge track-badge-clean">CLEAN</span>}
                </div>
                <ArtistLink artist={track.artist} className="track-item-artist" />
              </div>
              <div className="track-item-meta">
                {/* Источник виден по заголовку секции, а вот длительности
                    в выдаче не хватало: по ней отличают трек от часового
                    микса или получасовой «версии» с тем же названием. */}
                {formatDuration(track.duration) && (
                  <span className="track-item-duration">{formatDuration(track.duration)}</span>
                )}
                {track.download_allowed && track.download_url && (
                  <a
                    className="track-download"
                    href={track.download_url}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(event) => event.stopPropagation()}
                    aria-label={`Скачать ${track.title}`}
                  >
                    <Download size={18} />
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="page-container">
      <div className="search-header">
        {/* type=search + enterKeyHint: клавиатура телефона показывает «Найти»,
            а Enter её прячет — результаты ищутся по мере ввода, и нажатие
            означает «хватит, покажи». Автоисправление и заглавная буква в
            начале для имён артистов и названий только мешают. */}
        <input
          type="search"
          enterKeyHint="search"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="Что вы хотите послушать?"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            e.currentTarget.blur()
            if (musicLink) navigate(linkPagePath(query))
          }}
          className="search-input"
          autoFocus
        />
        {/* Фильтры — в липкой шапке, под полем: вне её в iOS PWA (клавиатура
            поднимает и прокручивает экран) лента уезжала под строку поиска
            и до неё было не добраться. */}
        {query && !musicLink && (
          <div className="search-filters" role="radiogroup" aria-label="Источник">
            {filters.map((item) => (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={filter === item.id}
                className={`search-filter${filter === item.id ? ' active' : ''}`}
                onClick={() => setFilter(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {loading && (
        <Spinner label="Поиск..." />
      )}

      {musicLink && (
        <Link to={linkPagePath(query)} className="search-link-card">
          <span className="search-link-card__kicker">{musicLink.label} · {musicLink.service}</span>
          <span className="search-link-card__title">Слушать по ссылке</span>
          <span className="search-link-card__hint">Треки подберутся из YouTube Music, без импорта в медиатеку</span>
        </Link>
      )}

      {!loading && query && !musicLink && searchError && (
        <div className="search-error">{searchError}</div>
      )}

      {/* Порядок секций фиксирован: исполнители → плейлисты → лучшие
          совпадения → треки из медиатеки → YouTube Music → SoundCloud.
          Исполнители и плейлисты сверху — это не результат, а переход: одно
          нажатие вместо выискивания артиста или подборки среди треков. Спиннер внешнего поиска
          стоит под «Лучшими совпадениями»: совпадения из медиатеки видны
          сразу, внешние дорисовываются к ним позже. С фильтром видна одна
          секция. */}
      {!loading && query && !musicLink && (
        <div className="search-results">
          {showAll && artists.length > 0 && (
            <div className="results-section artists-section">
              <h2 className="results-title">Исполнители</h2>
              <Carousel
                items={artists}
                label="Исполнители"
                renderItem={(item) => (
                  <Link
                    key={item.name}
                    to={artistPath(item.name)}
                    className="artist-card"
                    title={`Открыть страницу «${item.name}»`}
                    {...intentPrefetchHandlers(() => prefetchArtist(item.name))}
                  >
                    <img
                      src={resolveCoverUrl(item.cover_url) || defaultCover}
                      alt={item.name}
                      className="artist-card-cover"
                      loading="lazy"
                      decoding="async"
                      onError={handleCoverError}
                    />
                    <div className="artist-card-name">{item.name}</div>
                  </Link>
                )}
              />
            </div>
          )}

          {showAll && results.playlists.length > 0 && (
            <div className="results-section">
              <h2 className="results-title">Плейлисты</h2>
              <Carousel
                items={results.playlists}
                label="Плейлисты"
                renderItem={(playlist) => (
                  <div
                    key={playlist.id}
                    className="playlist-item"
                    onClick={() => navigate(`/playlists/${playlist.id}`)}
                  >
                    <img
                      src={resolveCoverUrl(playlist.cover_url) || defaultCover}
                      alt={playlist.name}
                      className="playlist-item-cover"
                      loading="lazy"
                      decoding="async"
                      onError={handleCoverError}
                    />
                    <div className="playlist-item-info">
                      <div className="playlist-item-name">{playlist.name}</div>
                      {playlist.description && (
                        <div className="playlist-item-description">{playlist.description}</div>
                      )}
                    </div>
                  </div>
                )}
              />
            </div>
          )}

          {showAll && externalPlaylists.length > 0 && (
            <div className="results-section">
              <h2 className="results-title">Плейлисты SoundCloud</h2>
              <Carousel
                items={externalPlaylists}
                label="Плейлисты SoundCloud"
                renderItem={(playlist) => (
                  <div
                    key={playlist.id}
                    className="playlist-item"
                    onClick={() => handleImportExternalPlaylist(playlist)}
                    {...intentPrefetchHandlers(() => prefetchExternalPlaylist(playlist.external_id))}
                    title="Открыть плейлист"
                  >
                    <img
                      src={resolveCoverUrl(playlist.cover_url) || defaultCover}
                      alt={playlist.title}
                      className="playlist-item-cover"
                      loading="lazy"
                      decoding="async"
                      onError={handleCoverError}
                    />
                    <div className="playlist-item-info">
                      <div className="playlist-item-name">{playlist.title}</div>
                      <div className="playlist-item-description">
                        {`${playlist.owner ? playlist.owner + ' · ' : ''}${playlist.track_count} треков · SoundCloud`}
                      </div>
                    </div>
                  </div>
                )}
              />
            </div>
          )}

          {shows('top') && renderExternalSection('Лучшие совпадения', topTracks)}
          {waitingExternal && (
            <Spinner label="Ищем в YouTube Music и SoundCloud..." />
          )}

          {PROVIDER_FILTERS.has(filter) && providerLoading && (
            <Spinner label={`Ищем в ${PROVIDER_LABELS[filter]}...`} />
          )}
          {PROVIDER_FILTERS.has(filter) &&
            renderExternalSection(PROVIDER_LABELS[filter], currentProviderTracks)}

          {shows('library') && libraryTracks.length > 0 && (
            <div className="results-section">
              <h2 className="results-title">Треки</h2>
              <div className="tracks-list">
                {libraryTracks.map((track) => (
                  <div
                    key={track.id}
                    className="track-item"
                    data-fast-tap=""
                    onClick={() => handlePlayTrack(track)}
                    {...trackIntentHandlers(track)}
                    {...trackMenu.getProps(track)}
                  >
                    <span className="source-cover">
                      <img
                        src={resolveCoverUrl(track.cover_url, 'thumb') || defaultCover}
                        alt={track.title}
                        className="track-item-cover"
                        onError={handleCoverError}
                        loading="lazy"
                        decoding="async"
                      />
                      <SourceIcon source={track.source} />
                    </span>
                    <div className="track-item-info">
                      <div className="track-item-title">{track.title}</div>
                      <ArtistLink artist={track.artist} className="track-item-artist" />
                    </div>
                    {formatDuration(track.duration) && (
                      <div className="track-item-meta">
                        <span className="track-item-duration">{formatDuration(track.duration)}</span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {shows('ytmusic') && renderExternalSection('YouTube Music', externalTracks.ytmusic)}
          {shows('soundcloud') && renderExternalSection('SoundCloud', externalTracks.soundcloud)}

          {!loading && !waitingExternal && !providerLoading && query && !hasResults && (
            <div className="no-results">
              <p>Ничего не найдено</p>
            </div>
          )}
        </div>
      )}

      {!query && (
        <div className="search-placeholder">
          <h2>Найдите любимую музыку</h2>
          <p>Ищите треки, плейлисты и исполнителей — или вставьте ссылку Spotify, Deezer, Яндекс Музыки</p>
        </div>
      )}
      <TrackContextMenu menu={trackMenu.menu} menuRef={trackMenu.menuRef} onClose={trackMenu.close} />
    </div>
  )
}

export default Search

