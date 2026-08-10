import { create } from 'zustand'

const emptyResults = { tracks: [], playlists: [], users: [] }
const emptyExternalTracks = { ytmusic: [], soundcloud: [] }

// Выдача поиска живёт в сторе, а не в состоянии страницы: роутер размонтирует
// /search при уходе на другую вкладку, и локальный useState терял и запрос, и
// результаты — возврат начинался с пустого экрана и повторного поиска.
const useSearchStore = create((set) => ({
  query: '',
  results: emptyResults,
  externalTracks: emptyExternalTracks,
  externalPlaylists: [],
  artists: [],
  searchError: '',
  // Запрос, чья выдача дособрана целиком. Только по нему возврат на страницу
  // считает результаты готовыми; оборванный на середине запрос ищется заново.
  cachedQuery: '',

  setQuery: (query) => set({ query }),

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

  setResults: (results) => set({ results }),
  setExternalTracks: (externalTracks) => set({ externalTracks }),
  setExternalPlaylists: (externalPlaylists) => set({ externalPlaylists }),
  setArtists: (artists) => set({ artists }),
  setSearchError: (searchError) => set({ searchError }),

  finishSearch: (query) => set({ cachedQuery: query }),

  clearSearch: () =>
    set({
      results: emptyResults,
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
      results: emptyResults,
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
