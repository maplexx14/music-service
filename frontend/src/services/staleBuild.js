import { lazy } from 'react'

// Восстановление после «устаревшей сборки». SW на медленной сети отдаёт
// каркас (index.html) из Cache Storage, а тот может ссылаться на хэшированные
// чанки прошлого деплоя, которых на сервере уже нет (404). Без обработки
// lazy-страница падает, React размонтирует дерево — на iOS-PWA это чёрный
// экран (фон html #000) без единой подсказки.
//
// Лечение: выбрасываем кэш каркаса SW (кэши обложек не трогаем) и один раз
// перезагружаемся — навигация уйдёт в сеть за свежим index.html. Флаг в
// sessionStorage не даёт зациклиться, если чанк не грузится по другой
// причине (сеть пропала): вторая ошибка за минуту уже не перезагружает.
// Дубль этой логики (без импорта — бандл может не загрузиться вовсе) есть
// инлайн-скриптом в index.html; ключ флага общий.

const RELOAD_KEY = 'bolt-stale-reload-at'
const RELOAD_WINDOW_MS = 60000

function recentlyReloaded() {
  try {
    const at = Number(sessionStorage.getItem(RELOAD_KEY) || 0)
    return Date.now() - at < RELOAD_WINDOW_MS
  } catch {
    return false
  }
}

function markReload() {
  try {
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
  } catch {
    // приватный режим — без защиты от цикла, но recentlyReloaded тогда тоже false
  }
}

async function dropShellCache() {
  if (typeof caches === 'undefined') return
  try {
    const keys = await caches.keys()
    await Promise.all(keys.filter((k) => k.startsWith('bolt-shell')).map((k) => caches.delete(k)))
  } catch {
    // Cache Storage недоступен — перезагрузка всё равно попробует сеть
  }
}

// true — перезагрузка запущена; false — уже пробовали, показываем ошибку.
export async function reloadForStaleBuild() {
  if (recentlyReloaded()) return false
  markReload()
  await dropShellCache()
  window.location.reload()
  return true
}

export function isChunkLoadError(error) {
  const message = String(error?.message || error || '')
  return /dynamically imported module|Importing a module script failed|Failed to fetch|error loading dynamically|Unable to preload|Load failed/i.test(
    message,
  )
}

// React.lazy с перезагрузкой при пропавшем чанке. Пока перезагрузка идёт,
// промис не резолвится — Suspense держит спиннер вместо вспышки ошибки.
export function lazyWithReload(factory) {
  return lazy(() =>
    factory().catch(async (error) => {
      if (isChunkLoadError(error) && (await reloadForStaleBuild())) {
        return new Promise(() => {})
      }
      throw error
    }),
  )
}
