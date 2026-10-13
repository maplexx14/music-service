import { create } from 'zustand'
import api from '../services/api'
import { toast } from './toastStore'

// Импорты плейлистов — одни на всё приложение. Раньше прогресс жил в окне
// страницы: ушёл со страницы, закрыл окно или оборвался запрос — статус
// пропадал, и юзер жал «Импортировать» снова (пять копий плейлиста на 4 тыс.
// треков). Теперь импорт ведёт стор: опрашивает прогресс сам, переживает
// уход со страницы, а после перезагрузки находит идущие импорты (GET /active).
//
// imports[id]: { id, title, state, lost }
//   state — прогресс с бэкенда: stage, total, done, saved, save_total,
//     started_at, imported, skipped, playlist_ids, stalled, error…
//   lost — POST оборвался (сеть, рестарт), а импорт мог продолжиться: итог
//     узнаём из опроса.

const POLL_MS = 1000

const isFinal = (state) =>
  state?.stage === 'done' || state?.stage === 'error' || !!state?.stalled

export const importIsFinal = isFinal

/** Id импорта, под которым бэкенд пишет прогресс (GET /import/progress/{id}). */
export function newImportId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID()
  return `imp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function importSummary(state) {
  const parts = [`В плейлисте треков: ${state?.imported ?? 0}`]
  const count = state?.playlist_ids?.length || 0
  if (count > 1) parts.push(`плейлистов: ${count}`)
  if (state?.skipped) parts.push(`не нашлось: ${state.skipped}`)
  return parts.join(', ')
}

let pollTimer = null

const useImportStore = create((set, get) => {
  const patch = (id, fields) =>
    set((s) => (s.imports[id] ? { imports: { ...s.imports, [id]: { ...s.imports[id], ...fields } } } : s))

  const finish = (id) => {
    const entry = get().imports[id]
    if (!entry || entry.notified) return
    patch(id, { notified: true })
    set((s) => ({ completed: s.completed + 1 }))
    // Окно открыто — итог и так на экране.
    if (get().openId === id) return
    const { state } = entry
    if (state.stage === 'done') toast.success(`Импорт готов. ${importSummary(state)}`)
    else if (state.stalled) toast.error('Импорт прервался — откройте статус внизу экрана')
    else toast.error(state.error || 'Не удалось импортировать')
  }

  const poll = async () => {
    pollTimer = null
    const running = Object.values(get().imports).filter((e) => !isFinal(e.state))
    await Promise.all(
      running.map(async ({ id }) => {
        try {
          // skipErrorToast: первый опрос обгоняет POST /import и ловит 404.
          const { data } = await api.get(`/import/progress/${id}`, { skipErrorToast: true })
          const entry = get().imports[id]
          // Итог POST уже записан — опрос, ушедший раньше, его не перетирает.
          if (!entry || isFinal(entry.state)) return
          patch(id, { state: { ...entry.state, ...data } })
          if (isFinal(data)) finish(id)
        } catch {
          // 404 до первой записи прогресса или сбой сети — ждём следующего опроса.
        }
      }),
    )
    schedule()
  }

  const schedule = () => {
    if (pollTimer) return
    if (!Object.values(get().imports).some((e) => !isFinal(e.state))) return
    pollTimer = setTimeout(poll, POLL_MS)
  }

  return {
    imports: {},
    // Импорт, чьё окно открыто (иначе статус — плашкой внизу экрана).
    openId: null,
    // Растёт на каждый законченный импорт — медиатека по нему перечитывает список.
    completed: 0,

    open: (id) => set({ openId: id }),
    close: () => set({ openId: null }),

    /** Убрать законченный импорт из статуса. */
    dismiss: (id) =>
      set((s) => {
        const imports = { ...s.imports }
        delete imports[id]
        return { imports, openId: s.openId === id ? null : s.openId }
      }),

    /**
     * Запустить импорт. → { accepted, data }: accepted — сервер принял импорт
     * (готов или ещё идёт после обрыва связи), data — ответ POST, если дошёл.
     */
    start: async ({ url, collections, title }) => {
      const id = newImportId()
      set((s) => ({
        imports: {
          ...s.imports,
          [id]: { id, title, state: { stage: 'fetching', total: 0, done: 0, started_at: Date.now() / 1000 } },
        },
        openId: id,
      }))
      schedule()

      const body = { url, import_id: id }
      if (collections) body.collections = collections
      try {
        // Без таймаута: большой плейлист импортируется минутами, ход виден в
        // окне прогресса, ограничивает только nginx (1 ч).
        const { data } = await api.post('/import', body, { timeout: 0, skipErrorToast: true })
        const entry = get().imports[id]
        if (entry) {
          patch(id, {
            state: {
              ...entry.state,
              stage: 'done',
              done: entry.state.total,
              saved: entry.state.save_total,
              imported: data.imported,
              skipped: data.skipped,
              playlist_ids: (data.playlists?.length ? data.playlists : [data.playlist])
                .filter(Boolean)
                .map((p) => p.id),
            },
          })
          finish(id)
        }
        return { accepted: true, data }
      } catch (error) {
        const status = error.response?.status
        const detail = error.response?.data?.detail
        // Ответ есть и это не сбой прокси/воркера — сервер импорт отклонил.
        if (status && status < 500) {
          get().dismiss(id)
          toast.error(typeof detail === 'string' ? detail : 'Не удалось импортировать')
          // 409: тот же импорт уже идёт (с другой вкладки, до перезагрузки) — покажем его.
          if (status === 409) get().resume()
          return { accepted: false }
        }
        if (status === 500) {
          // Бэкенд сам записал stage=error — опрос его подхватит; на случай,
          // если записать не успел, ставим ошибку сразу.
          const entry = get().imports[id]
          if (entry && !isFinal(entry.state)) {
            patch(id, { state: { ...entry.state, stage: 'error', error: detail || 'Внутренняя ошибка импорта' } })
            finish(id)
          }
          return { accepted: false }
        }
        // Обрыв связи, 502/504 от прокси, рестарт: импорт мог продолжиться —
        // судим по прогрессу, а не по запросу.
        patch(id, { lost: true })
        schedule()
        return { accepted: true }
      }
    },

    /** Подхватить идущие импорты с сервера (после входа и перезагрузки). */
    resume: async () => {
      let list
      try {
        const response = await api.get('/import/active', { skipErrorToast: true })
        list = response.data
      } catch {
        return
      }
      if (!Array.isArray(list)) return
      set((s) => {
        const imports = { ...s.imports }
        for (const { id, ...state } of list) {
          if (imports[id] || isFinal(state)) continue
          imports[id] = { id, title: state.collection, state, lost: true }
        }
        return { imports }
      })
      schedule()
    },

    reset: () => {
      clearTimeout(pollTimer)
      pollTimer = null
      set({ imports: {}, openId: null })
    },
  }
})

export { useImportStore }
