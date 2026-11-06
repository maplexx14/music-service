import { useCallback, useState } from 'react'
import { useIntersectionLoad } from './useIntersectionLoad'

// Запас до конца списка, при заходе в который тянется следующая страница:
// запрос успевает отработать до того, как пользователь доскроллит до пустоты.
const DEFAULT_MARGIN = '400px'

/**
 * Подгрузка следующей страницы, когда пользователь доскроллил до конца списка.
 *
 * Возвращает ref для маячка — пустого элемента после последней строки.
 *
 * enabled выключается на время запроса (`hasMore && !loadingMore`).
 * itemCount — число уже загруженных элементов: новый блок проверяет маячок
 * повторно, даже если быстрый ответ объединил loading=true/false в один
 * React-коммит. Это нужно и при восстановлении глубокой прокрутки, когда
 * маячок всё время виден и нового события пересечения не будет.
 *
 * По той же причине вызывающий обязан гасить enabled при ошибке запроса: иначе
 * снятие loadingMore пересоберёт наблюдатель, тот снова упрётся в видимый
 * маячок — и страница уйдёт в бесконечный цикл падающих запросов.
 */
export function useInfiniteScroll(onReachEnd, { enabled = true, rootMargin = DEFAULT_MARGIN, itemCount } = {}) {
  // Маячок держим в состоянии, а не в useRef: смену ref.current эффект не
  // замечает, и после размонтирования/возврата секции наблюдатель остался бы
  // висеть на узле вне документа.
  const [sentinel, setSentinel] = useState(null)
  const sentinelRef = useCallback((node) => setSentinel(node), [])

  useIntersectionLoad(sentinel, onReachEnd, { enabled, rootMargin, revision: itemCount })

  return sentinelRef
}

export default useInfiniteScroll
