import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Plus, X, Search, Sparkles } from 'lucide-react'
import api from '../services/api'
import { resolveCoverUrl } from '../utils/media'
import './PreferencePicker.css'

/**
 * Выбор любимых артистов — сетка круглых фото с числом фанатов.
 *
 * Подсказки зависят от ЖАНРОВ: пустой ввод — топ артистов выбранных жанров
 * (Last.fm tag.getTopArtists через /users/artists/by-genres), ввод — поиск по
 * каталогу и YouTube Music (/users/artists/suggest). Без жанров подсказки не
 * пропадают: бэкенд добирает самыми слушаемыми артистами каталога.
 *
 * Имена приходят сразу, фото и фанаты (Deezer) дозагружаются отдельно
 * (/users/artists/cards) — сетка не ждёт внешний API. Выбор артиста
 * подтягивает трёх похожих (/users/artists/similar) и вставляет их в сетку
 * сразу за ним: так юзер идёт по своему вкусу, а не листает общий топ.
 *
 * Контролируемый: selected/excluded — string[], onChange({ artists,
 * excludedArtists }).
 */
const SIMILAR_COUNT = 3
// Фото ищутся в Deezer под общим троттлом (~8 запросов в секунду на сервер),
// и ответ на пачку ждёт её последнего артиста. Мелкие пачки, отправленные
// разом по порядку сетки, показывают первый ряд за секунду, а не всю
// страницу за пять.
const CARDS_BATCH = 8

const keyOf = (name) => (name || '').trim().toLowerCase().replace(/\s+/g, ' ')

const compactFans = new Intl.NumberFormat('ru-RU', {
  notation: 'compact',
  maximumFractionDigits: 1,
})

function fansLabel(count) {
  if (!count) return null
  const n = count % 100
  const last = count % 10
  // Склонение по самому числу: «1 фанат», «3 фаната», «1,8 млн фанатов» —
  // у сокращённой записи последнее слово «млн/тыс.», после него родительный.
  let word = 'фанатов'
  if (count < 1000 && (n < 11 || n > 14)) {
    if (last === 1) word = 'фанат'
    else if (last >= 2 && last <= 4) word = 'фаната'
  }
  return `${compactFans.format(count)} ${word}`
}

/** Повторяющийся параметр (?names=a&names=b): axios сериализует массив как
 *  names[]=..., чего FastAPI не разбирает, а через запятую нельзя — запятая
 *  бывает в имени («Tyler, The Creator»). */
function listParams(key, values, extra = {}) {
  const params = new URLSearchParams(extra)
  values.forEach((value) => params.append(key, value))
  return params
}

function ArtistTile({ name, card, active, index, similar, onToggle }) {
  const [broken, setBroken] = useState(false)
  const cover = card?.cover_url && !broken ? resolveCoverUrl(card.cover_url) : null
  const fans = fansLabel(card?.fans)
  return (
    <button
      type="button"
      className={`pref-artist-tile ${active ? 'active' : ''} ${similar ? 'similar' : ''}`}
      style={similar ? { '--tile-delay': `${index * 60}ms` } : undefined}
      onClick={() => onToggle(name)}
      aria-pressed={active}
    >
      <span className="pref-artist-photo">
        {cover ? (
          <img src={cover} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} />
        ) : (
          <span className={`pref-artist-initial ${card ? '' : 'pending'}`} aria-hidden="true">
            {name.trim().charAt(0).toUpperCase()}
          </span>
        )}
        <span className="pref-artist-check" aria-hidden="true">
          <Check size={16} strokeWidth={3} />
        </span>
      </span>
      <span className="pref-artist-name">{name}</span>
      <span className="pref-artist-fans">{fans || ' '}</span>
    </button>
  )
}

function ArtistSelect({
  selected = [],
  excluded = [],
  detected = [],
  genres = [],
  // Подсказок по жанрам на страницу подгрузки: в настройках сетка во всю
  // ширину страницы, в онбординге — в карточке со своим скроллом.
  suggestionLimit = 24,
  onChange,
}) {
  const [query, setQuery] = useState('')
  const [suggestions, setSuggestions] = useState([])
  const [loading, setLoading] = useState(false)
  // Артисты, которых нет в подсказках, но которые должны стоять в сетке:
  // уже выбранные раньше (настройки) и найденные поиском. Снятый выбор
  // артиста из сетки не убирает — плитка не должна прыгать из-под пальца.
  const [pinned, setPinned] = useState([])
  // ключ артиста → имена похожих, вставленных за ним.
  const [related, setRelated] = useState({})
  // ключ артиста → { cover_url, fans }; null — запрошено, ответа нет.
  const [cards, setCards] = useState({})
  const requestedCards = useRef(new Set())
  const requestedSimilar = useRef(new Set())

  // Строка стабилизирует эффект: массив жанров пересоздаётся на каждый рендер
  // родителя, а запрос должен уходить только при реальной смене выбора.
  const genresParam = genres.filter(Boolean).join(',')
  const term = query.trim()

  // Подгрузка при прокрутке: есть ли ещё страница и идёт ли запрос за ней.
  // В ref, а не только в state: обзёрвер зовёт loadMore из замыкания,
  // созданного раньше, и должен видеть текущее значение.
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const paging = useRef({ busy: false, generation: 0 })

  useEffect(() => {
    let active = true
    const generation = ++paging.current.generation
    paging.current.busy = false
    setLoading(true)
    setLoadingMore(false)
    setHasMore(false)
    const timer = setTimeout(() => {
      const request = term
        ? api.get('/users/artists/suggest', { params: { q: term, limit: 12 } })
        : api.get('/users/artists/by-genres', {
            // Жанры одной строкой через запятую: axios сериализует массив как
            // genres[]=..., чего FastAPI в List[str] = Query() не разбирает.
            params: { genres: genresParam, limit: suggestionLimit, offset: 0 },
          })
      request
        .then((res) => {
          if (!active || generation !== paging.current.generation) return
          const names = res.data || []
          setSuggestions(names)
          // Поиск не листается: 12 лучших совпадений — это и есть ответ.
          setHasMore(!term && names.length >= suggestionLimit)
        })
        .catch(() => {
          if (active) setSuggestions([])
        })
        .finally(() => {
          if (active) setLoading(false)
        })
    }, term ? 250 : 0)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [term, genresParam, suggestionLimit])

  const loadMore = () => {
    if (term || !hasMore || paging.current.busy) return
    const generation = paging.current.generation
    paging.current.busy = true
    setLoadingMore(true)
    api
      .get('/users/artists/by-genres', {
        params: { genres: genresParam, limit: suggestionLimit, offset: suggestions.length },
      })
      .then((res) => {
        if (generation !== paging.current.generation) return
        const names = res.data || []
        setSuggestions((prev) => {
          const seen = new Set(prev.map(keyOf))
          return [...prev, ...names.filter((name) => !seen.has(keyOf(name)))]
        })
        setHasMore(names.length >= suggestionLimit)
      })
      // Сбой — не листаем дальше: бесконечные повторы на каждый скролл хуже,
      // чем короткая сетка.
      .catch(() => setHasMore(false))
      .finally(() => {
        if (generation !== paging.current.generation) return
        paging.current.busy = false
        setLoadingMore(false)
      })
  }

  // Конец сетки показался (с запасом в пару рядов) — тянем следующую страницу.
  const loadMoreRef = useRef(loadMore)
  loadMoreRef.current = loadMore
  const sentinel = useRef(null)
  useEffect(() => {
    const node = sentinel.current
    if (!node || !hasMore) return undefined
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMoreRef.current()
      },
      { rootMargin: '400px 0px' }
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [hasMore, suggestions.length])

  const selectedKeys = useMemo(() => new Set(selected.map(keyOf)), [selected])
  const excludedKeys = useMemo(() => new Set(excluded.map(keyOf)), [excluded])

  const unusedDetected = useMemo(
    () => detected.filter((d) => !selectedKeys.has(keyOf(d)) && !excludedKeys.has(keyOf(d))),
    [detected, selectedKeys, excludedKeys]
  )

  // Плитки сетки. Похожие встают сразу за артистом, от которого пришли, и
  // рекурсивно: выбрал похожего — его соседи встанут уже за ним.
  const tiles = useMemo(() => {
    const out = []
    const seen = new Set()
    const push = (name, parent = null, index = 0) => {
      const k = keyOf(name)
      if (!k || seen.has(k)) return
      seen.add(k)
      out.push({ name, key: k, parent, index })
      ;(related[k] || []).forEach((child, i) => push(child, k, i))
    }
    if (term) {
      suggestions.forEach((name) => push(name))
    } else {
      pinned.forEach((name) => push(name))
      suggestions.forEach((name) => push(name))
    }
    return out
  }, [term, pinned, suggestions, related])

  // Выбранные, которых сетка сама не показывает (сохранённые раньше, «Добавить
  // всех» из определённых), — в начало. Эффектом, а не начальным значением
  // pinned: в настройках профиль приходит асинхронно, и на монтировании
  // selected ещё пуст — сохранённые артисты уезжали в хвост сетки. Выбранный
  // клик по подсказке или похожему сюда не попадает: его плитка уже на месте.
  useEffect(() => {
    if (term) return
    const shown = new Set(tiles.map((t) => t.key))
    const missing = selected.filter((name) => !shown.has(keyOf(name)))
    if (missing.length) setPinned((prev) => [...missing, ...prev])
  }, [term, selected, tiles])

  // Дозагрузка фото/фанатов для плиток, которых ещё не спрашивали.
  useEffect(() => {
    const missing = tiles
      .map((t) => t.name)
      .filter((name) => !requestedCards.current.has(keyOf(name)))
    if (!missing.length) return
    missing.forEach((name) => requestedCards.current.add(keyOf(name)))
    for (let i = 0; i < missing.length; i += CARDS_BATCH) {
      const batch = missing.slice(i, i + CARDS_BATCH)
      api
        .get('/users/artists/cards', { params: listParams('names', batch) })
        .then((res) => {
          setCards((prev) => {
            const next = { ...prev }
            batch.forEach((name) => {
              if (!(keyOf(name) in next)) next[keyOf(name)] = null
            })
            ;(res.data || []).forEach((card) => {
              next[keyOf(card.name)] = card
            })
            return next
          })
        })
        .catch(() => {
          // Сбой — разрешаем повторный запрос при следующем рендере сетки.
          batch.forEach((name) => requestedCards.current.delete(keyOf(name)))
        })
    }
  }, [tiles])

  const loadSimilar = (name) => {
    const k = keyOf(name)
    if (requestedSimilar.current.has(k)) return
    requestedSimilar.current.add(k)
    const shown = [...tiles.map((t) => t.name), ...selected, ...excluded]
    api
      .get('/users/artists/similar', {
        params: listParams('exclude', shown, { artist: name, limit: SIMILAR_COUNT }),
      })
      .then((res) => {
        const found = res.data || []
        if (!found.length) return
        // Карточки похожих приходят уже с фото — второй раз не спрашиваем.
        setCards((prev) => {
          const next = { ...prev }
          found.forEach((card) => {
            next[keyOf(card.name)] = card
            requestedCards.current.add(keyOf(card.name))
          })
          return next
        })
        setRelated((prev) => ({ ...prev, [k]: found.map((card) => card.name) }))
      })
      .catch(() => requestedSimilar.current.delete(k))
  }

  const addArtist = (name) => {
    const clean = (name || '').trim()
    if (!clean) return
    if (!selectedKeys.has(keyOf(clean))) {
      onChange({
        artists: [...selected, clean],
        excludedArtists: excluded.filter((e) => keyOf(e) !== keyOf(clean)),
      })
    }
    // Найденный поиском — в начало сетки: после сброса запроса он должен
    // остаться на виду вместе со своими похожими.
    const inGrid = !term && tiles.some((t) => t.key === keyOf(clean))
    if (!inGrid) {
      setPinned((prev) => (prev.some((p) => keyOf(p) === keyOf(clean)) ? prev : [clean, ...prev]))
    }
    if (term) setQuery('')
    loadSimilar(clean)
  }

  const removeArtist = (name) => {
    onChange({
      artists: selected.filter((a) => keyOf(a) !== keyOf(name)),
      excludedArtists: excluded,
    })
  }

  const toggleArtist = (name) => {
    if (selectedKeys.has(keyOf(name))) removeArtist(name)
    else addArtist(name)
  }

  const excludeDetected = (name) => {
    onChange({ artists: selected, excludedArtists: [...excluded, name] })
  }

  const handleKeyDown = (e) => {
    // Не отправляем во время IME-композиции (CJK) и на неточном событии Safari.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === 'Enter') {
      e.preventDefault()
      addArtist(query)
    }
  }

  return (
    <div className="pref-section">
      {unusedDetected.length > 0 && (
        <div className="pref-detected">
          <div className="pref-detected-label">
            <Sparkles size={14} /> Определено по вашим прослушиваниям
          </div>
          <div className="pref-suggestions">
            {unusedDetected.map((a) => (
              <div className="pref-detected-artist" key={a}>
                <button
                  type="button"
                  className="pref-suggestion detected"
                  onClick={() => addArtist(a)}
                >
                  <Plus size={14} /> {a}
                </button>
                <button
                  type="button"
                  className="pref-dismiss-detected"
                  onClick={() => excludeDetected(a)}
                  aria-label={`Убрать ${a} из определённых артистов`}
                  title="Не учитывать этого артиста"
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="pref-apply-detected"
            onClick={() =>
              onChange({
                artists: [...selected, ...unusedDetected],
                excludedArtists: excluded.filter(
                  (e) => !unusedDetected.some((a) => keyOf(a) === keyOf(e))
                ),
              })
            }
          >
            <Sparkles size={14} /> Добавить всех ({unusedDetected.length})
          </button>
        </div>
      )}

      <div className="pref-artist-input">
        <Search size={18} className="pref-artist-icon" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Найти артиста"
        />
        {term && (
          <button type="button" className="pref-add-btn" onClick={() => addArtist(query)}>
            <Plus size={16} /> Добавить
          </button>
        )}
      </div>

      {!term && genres.length > 0 && (
        <p className="pref-subtitle pref-hint">
          Популярное в выбранных жанрах. Отметьте артиста — рядом появятся похожие.
        </p>
      )}

      {tiles.length > 0 ? (
        <div className="pref-artist-grid">
          {tiles.map((tile) => (
            <ArtistTile
              key={tile.key}
              name={tile.name}
              card={cards[tile.key]}
              active={selectedKeys.has(tile.key)}
              index={tile.index}
              similar={Boolean(tile.parent)}
              onToggle={toggleArtist}
            />
          ))}
          {/* Внутри сетки: в онбординге она скроллится сама, и маркер конца
              должен жить в том же скролле. */}
          {hasMore && (
            <div ref={sentinel} className="pref-artist-more" aria-hidden="true">
              {loadingMore && <span className="pref-artist-more-dot" />}
            </div>
          )}
        </div>
      ) : loading ? (
        <p className="pref-subtitle">Подбираем артистов…</p>
      ) : (
        <p className="pref-subtitle">
          {term
            ? 'Никого не нашли — нажмите «Добавить», чтобы сохранить имя как есть.'
            : genres.length
              ? 'Под выбранные жанры артистов не нашлось — найдите нужных поиском.'
              : 'Найдите любимых артистов поиском.'}
        </p>
      )}
    </div>
  )
}

export default ArtistSelect
