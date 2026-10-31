import { useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { usePlayerStore } from '../store/playerStore'
import { useAddToPlaylistStore } from '../store/addToPlaylistStore'
import { useCensorDialogStore } from '../store/censorDialogStore'
import { canGoBack, isAndroid, isStandalone, isTabRoot, tabOf } from '../services/navigation'
import { toast } from '../store/toastStore'

/**
 * Обработка жестов и кнопки «Назад» для PWA и Android (включая Vivo OriginOS / FuntouchOS).
 *
 * Проблема: на Android/Vivo краевые свайпы вызывают системный back (`popstate`).
 * Поскольку PWA работает как SPA (Single Page Application), при открытии с домашнего экрана
 * история браузера состоит всего из одной записи (start_url). Любой свайп назад без истории
 * заставлял систему мгновенно закрывать/сворачивать приложение. Также модалки и плеер не имели
 * записей в истории, поэтому свайп назад закрывал всё приложение вместо закрытия плеера/модалки.
 *
 * Решение:
 * 1. Держит буфер в истории (__boltBuffer) только на корневой позиции (когда history.length = 1
 *    или canGoBack() = false), предотвращая немедленный вылет из PWA при краевом свайпе.
 * 2. Синхронизирует модалки (FullScreenPlayer, диалоги) со стеком истории — жест «Назад»
 *    сначала закрывает открытые окна и шторки, не закрывая приложение.
 * 3. На второстепенных вкладках (/search, /liked, /playlists) при отсутствии истории возвращает
 *    на Главную (/), по аналогии с нативными Android-приложениями.
 * 4. На вложенных экранах при холодном старте возвращает в родительскую вкладку.
 * 5. На Главной (/) жест «Назад» показывает подсказку «Нажмите ещё раз, чтобы выйти»
 *    (double back to exit в пределах 2 секунд) вместо моментального закрытия приложения.
 */
export function usePwaBackHandler() {
  const location = useLocation()
  const navigate = useNavigate()

  const isFullScreen = usePlayerStore((s) => s.isFullScreen)
  const closeFullScreen = usePlayerStore((s) => s.closeFullScreen)

  const isAddOpen = useAddToPlaylistStore((s) => s.request !== null)
  const closeAddToPlaylist = useAddToPlaylistStore((s) => s.close)

  const isCensorOpen = useCensorDialogStore((s) => s.track !== null)
  const closeCensor = useCensorDialogStore((s) => s.close)

  const lastBackPressRef = useRef(0)
  const isHandlingPopRef = useRef(false)
  const pushedModalsRef = useRef([])

  const stateRef = useRef({
    isFullScreen,
    isAddOpen,
    isCensorOpen,
    pathname: location.pathname,
  })
  stateRef.current = {
    isFullScreen,
    isAddOpen,
    isCensorOpen,
    pathname: location.pathname,
  }

  // 1. Инициализация и поддержание буфера истории для Android / standalone PWA.
  // Буфер создаётся ТОЛЬКО на корневой позиции стека (idx === 0), чтобы на вложенных
  // страницах сохранялся естественный возврат ровно за 1 жест.
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!isAndroid && !isStandalone) return

    const isRootEntry = (window.history.state?.idx ?? 0) === 0
    if (isRootEntry && !window.history.state?.__boltBuffer) {
      window.history.pushState(
        { ...window.history.state, __boltBuffer: true },
        '',
        window.location.href,
      )
    }
  }, [location.pathname])

  // 2. Синхронизация полноэкранного плеера с историей
  useEffect(() => {
    if (isFullScreen) {
      if (!isHandlingPopRef.current && !pushedModalsRef.current.includes('fullscreen')) {
        window.history.pushState(
          { ...window.history.state, __boltModal: 'fullscreen' },
          '',
          window.location.href,
        )
        pushedModalsRef.current.push('fullscreen')
      }
    } else {
      if (!isHandlingPopRef.current && pushedModalsRef.current.includes('fullscreen')) {
        pushedModalsRef.current = pushedModalsRef.current.filter((m) => m !== 'fullscreen')
        if (window.history.state?.__boltModal === 'fullscreen') {
          window.history.back()
        }
      }
    }
  }, [isFullScreen])

  // 3. Синхронизация диалога «Добавить в плейлист»
  useEffect(() => {
    if (isAddOpen) {
      if (!isHandlingPopRef.current && !pushedModalsRef.current.includes('add-to-playlist')) {
        window.history.pushState(
          { ...window.history.state, __boltModal: 'add-to-playlist' },
          '',
          window.location.href,
        )
        pushedModalsRef.current.push('add-to-playlist')
      }
    } else {
      if (!isHandlingPopRef.current && pushedModalsRef.current.includes('add-to-playlist')) {
        pushedModalsRef.current = pushedModalsRef.current.filter((m) => m !== 'add-to-playlist')
        if (window.history.state?.__boltModal === 'add-to-playlist') {
          window.history.back()
        }
      }
    }
  }, [isAddOpen])

  // 4. Синхронизация диалога цензуры
  useEffect(() => {
    if (isCensorOpen) {
      if (!isHandlingPopRef.current && !pushedModalsRef.current.includes('censor')) {
        window.history.pushState(
          { ...window.history.state, __boltModal: 'censor' },
          '',
          window.location.href,
        )
        pushedModalsRef.current.push('censor')
      }
    } else {
      if (!isHandlingPopRef.current && pushedModalsRef.current.includes('censor')) {
        pushedModalsRef.current = pushedModalsRef.current.filter((m) => m !== 'censor')
        if (window.history.state?.__boltModal === 'censor') {
          window.history.back()
        }
      }
    }
  }, [isCensorOpen])

  // 5. Перехват события popstate (системный жест «Назад»)
  useEffect(() => {
    if (typeof window === 'undefined') return

    const handlePopState = () => {
      isHandlingPopRef.current = true

      try {
        const { isFullScreen: fs, isAddOpen: add, isCensorOpen: cen, pathname } = stateRef.current

        // Приоритет 1: Открытые диалоги
        if (cen) {
          closeCensor()
          pushedModalsRef.current = pushedModalsRef.current.filter((m) => m !== 'censor')
          return
        }

        if (add) {
          closeAddToPlaylist()
          pushedModalsRef.current = pushedModalsRef.current.filter((m) => m !== 'add-to-playlist')
          return
        }

        // Приоритет 2: Полноэкранный плеер
        if (fs) {
          closeFullScreen()
          pushedModalsRef.current = pushedModalsRef.current.filter((m) => m !== 'fullscreen')
          return
        }

        // На десктопе вне PWA стандартную навигацию браузера не меняем
        if (!isAndroid && !isStandalone) return

        // Приоритет 3: Вложенный экран при холодном старте (в истории пусто, но экран вложенный)
        if (!isTabRoot(pathname) && !canGoBack()) {
          navigate(tabOf(pathname), { replace: true })
          return
        }

        // Приоритет 4: Второстепенная вкладка (/search, /liked, /playlists) при отсутствии истории -> возврат на Главную (/)
        if (isTabRoot(pathname) && pathname !== '/' && !canGoBack()) {
          navigate('/', { replace: true })
          return
        }

        // Приоритет 5: Главная (/) -> двойной жест назад для выхода
        if (pathname === '/') {
          const now = Date.now()
          if (now - lastBackPressRef.current < 2000) {
            // Повторный свайп назад в течение 2 секунд — разрешаем закрытие PWA
            window.history.back()
          } else {
            lastBackPressRef.current = now
            toast.info('Нажмите ещё раз, чтобы выйти', 2000)
            // Восстанавливаем буфер, чтобы следующий свайп назад не закрыл PWA без подтверждения
            window.history.pushState(
              { ...window.history.state, __boltBuffer: true },
              '',
              window.location.href,
            )
          }
        }
      } finally {
        setTimeout(() => {
          isHandlingPopRef.current = false
        }, 80)
      }
    }

    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [closeFullScreen, closeAddToPlaylist, closeCensor, navigate])
}

export default usePwaBackHandler
