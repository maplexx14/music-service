import { useCallback, useEffect, useRef, useState } from 'react'

// Запас до конца списка, при заходе в который тянется следующая страница:
// запрос успевает отработать до того, как пользователь доскроллит до пустоты.
const DEFAULT_MARGIN = '400px'

/**
 * Подгрузка следующей страницы, когда пользователь доскроллил до конца списка.
 *
 * Возвращает ref для маячка — пустого элемента после последней строки.
 *
 * enabled обязан выключаться на время самого запроса (`hasMore && !loadingMore`)
 * и это не просто защита от дублей: IntersectionObserver сообщает только о
 * смене видимости, а не о том, что маячок всё ещё виден. Если подгруженная
 * страница коротка и маячок из зоны предзагрузки не вышел, второго события не
 * будет и лента встанет. Пересборка наблюдателя на выключении/включении даёт
 * ровно то, что нужно: новый наблюдатель сразу докладывает текущее состояние —
 * и цепочка продолжается сама.
 *
 * По той же причине вызывающий обязан гасить enabled при ошибке запроса: иначе
 * снятие loadingMore пересоберёт наблюдатель, тот снова упрётся в видимый
 * маячок — и страница уйдёт в бесконечный цикл падающих запросов.
 */
export function useInfiniteScroll(onReachEnd, { enabled = true, rootMargin = DEFAULT_MARGIN } = {}) {
  // Маячок держим в состоянии, а не в useRef: смену ref.current эффект не
  // замечает, и после размонтирования/возврата секции наблюдатель остался бы
  // висеть на узле вне документа.
  const [sentinel, setSentinel] = useState(null)
  const sentinelRef = useCallback((node) => setSentinel(node), [])

  // Колбэк — в ref: на странице он пересоздаётся каждый рендер, а
  // пересобирать из-за этого наблюдателя незачем.
  const handlerRef = useRef(onReachEnd)
  useEffect(() => {
    handlerRef.current = onReachEnd
  })

  useEffect(() => {
    if (!sentinel || !enabled) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) handlerRef.current()
      },
      { rootMargin },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [sentinel, enabled, rootMargin])

  return sentinelRef
}

export default useInfiniteScroll
