import { Profiler } from 'react'
import { isFrameMeterEnabled, noteRender } from '../utils/frameMeter'

// Время рендера поддерева для замера плавности (utils/frameMeter). Работает
// за счёт profiling-сборки react-dom (см. vite.config.js).
//
// <Profiler> ставим, только если замер включён на старте: под ним
// profiling-сборка засекает время каждого компонента на каждом рендере, а
// обёртка стоит над всем приложением — это цена в каждом коммите у всех.
// Решение принимается раз за запуск: добавить или убрать <Profiler> на ходу
// значит перемонтировать всё под ним, вместе с плеером. Включённый в
// настройках замер считает рендеры со следующего запуска.
const PROFILE = isFrameMeterEnabled()

function MeterProfiler({ id, children }) {
  if (!PROFILE) return children
  return (
    <Profiler id={id} onRender={noteRender}>
      {children}
    </Profiler>
  )
}

export default MeterProfiler
