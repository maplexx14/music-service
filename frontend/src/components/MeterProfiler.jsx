import { Profiler } from 'react'
import { noteRender } from '../utils/frameMeter'

// Время рендера поддерева для замера плавности (utils/frameMeter). Работает
// за счёт profiling-сборки react-dom (см. vite.config.js); при выключенном
// замере onRender сразу выходит.
function MeterProfiler({ id, children }) {
  return (
    <Profiler id={id} onRender={noteRender}>
      {children}
    </Profiler>
  )
}

export default MeterProfiler
