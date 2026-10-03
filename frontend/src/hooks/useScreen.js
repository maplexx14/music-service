import { createContext, useContext } from 'react'

// Экран, внутри которого рендерится компонент (components/ScreenStack.jsx).
// Корни вкладок живут смонтированными и скрытыми, пока открыта другая
// вкладка, — active говорит, виден ли экран сейчас; scrollerRef — его
// собственный контейнер прокрутки. Вне стека (вход, онбординг) — активен,
// без контейнера.
export const ScreenContext = createContext({ active: true, scrollerRef: null })

export const useScreen = () => useContext(ScreenContext)
