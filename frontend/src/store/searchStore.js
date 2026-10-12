import { create } from 'zustand'

const emptyResults = { tracks: [], playlists: [], users: [] }
const emptyExternalTracks = { top: [], ytmusic: [], soundcloud: [] }

// Выдача поиска живёт в сторе, а не в состоянии страницы: роутер размонтирует
// /search при уходе на другую вкладку, и локальный useState терял и запрос, и
// результаты — возврат начинался с пустого экрана и повторного поиска.
const useSearchStore = create((set) => ({
  query: '',
  results: emptyResults,
  // Строка, по которой получена results: пока идёт набор, query уже новая, а
  // выдача старая — топ медиатеки считается по её собственному запросу.
  resultsQuery: '',
  externalTracks: emptyExternalTracks,
  externalPlaylists: [],
  artists: [],
  searchError: '',
  // Запрос, чья выдача дособрана целиком. Только по нему возврат на страницу
  // считает результаты готовыми; оборванный на середине запрос ищется заново.
  cachedQuery: '',
  // Фильтр выдачи: 'all' или один источник (см. SEARCH_FILTERS в Search.jsx).
  // В сторе, чтобы пережить уход на другую вкладку вместе с выдачей.
  filter: 'all',

  setQuery: (query) => set({ query }),
  setFilter: (filter) => set({ filter }),

  // Старт нового запроса: внешние секции дорисовываются позже и не должны
  // миксоваться с новой выдачей, а полустарая выдача — считаться закешированной.
  beginSearch: () =>
    set({
      externalTracks: emptyExternalTracks,
      externalPlaylists: [],
      artists: [],
      searchError: '',
      cachedQuery: '',
    }),

  setResults: (results, resultsQuery = '') => set({ results, resultsQuery }),
  setExternalTracks: (externalTracks) => set({ externalTracks }),
  setExternalPlaylists: (externalPlaylists) => set({ externalPlaylists }),
  setArtists: (artists) => set({ artists }),
  setSearchError: (searchError) => set({ searchError }),

  finishSearch: (query) => set({ cachedQuery: query }),

  clearSearch: () =>
    set({
      results: emptyResults,
      resultsQuery: '',
      externalTracks: emptyExternalTracks,
      externalPlaylists: [],
      artists: [],
      searchError: '',
      cachedQuery: '',
    }),

  // Полный сброс, включая строку запроса — на выход из аккаунта.
  resetSearch: () =>
    set({
      query: '',
      filter: 'all',
      results: emptyResults,
      resultsQuery: '',
      externalTracks: emptyExternalTracks,
      externalPlaylists: [],
      artists: [],
      searchError: '',
      cachedQuery: '',
    }),
}))

// Стор живёт на уровне модуля и переживает конец сессии — без сброса запрос и
// выдача прошлого пользователя встречали бы следующего. Явный выход сбрасывает
// стор из authStore, здесь ловим истёкший токен.
if (typeof window !== 'undefined') {
  window.addEventListener('auth:unauthorized', () => {
    useSearchStore.getState().resetSearch()
  })
}

export { useSearchStore }
