import { create } from 'zustand'

// Окно «Добавить в плейлист» — одно на всё приложение, его рисует Layout.
// Страницы и плеер только открывают его с треком: раньше у каждой страницы был
// свой выпадающий список (и своя копия загрузки плейлистов и обработки
// ошибок), а у мини-плеера — отдельная панель с <select>.
//
// request: { track, resolveId?, excludePlaylistId? }
//   resolveId — как получить числовой id трека в БД. По умолчанию
//     materializeTrack из playerStore; плееру нужен свой (materializeCurrentTrack
//     заодно обновляет текущий трек).
//   excludePlaylistId — плейлист, который в списке не показываем (страница
//     плейлиста не предлагает добавить трек в него же).
const useAddToPlaylistStore = create((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: () => set({ request: null }),
}))

export const openAddToPlaylist = (track, options = {}) =>
  useAddToPlaylistStore.getState().open({ track, ...options })

export { useAddToPlaylistStore }
