import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import Grainient from './src/components/Grainient'

// Считаем реальные вызовы отрисовки на каждый canvas: так видно, сработал ли
// кап FPS (сравниваем число draw-вызовов с числом тиков rAF).
for (const Ctor of [window.WebGL2RenderingContext, window.WebGLRenderingContext]) {
  if (!Ctor) continue
  for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
    const orig = Ctor.prototype[name]
    if (!orig) continue
    Ctor.prototype[name] = function patched(...args) {
      this.canvas.__draws = (this.canvas.__draws || 0) + 1
      return orig.apply(this, args)
    }
  }
}

let rafTicks = 0
const tick = () => {
  rafTicks += 1
  requestAnimationFrame(tick)
}
requestAnimationFrame(tick)

const TILES = [
  { name: 'чёрная обложка (idle)', colors: ['#242424', '#121212', '#050505'], active: false },
  { name: 'синяя + оранж (playing)', colors: ['#e68228', '#2846aa', '#1a264f'], active: true },
  { name: 'дефолт (playing)', colors: ['#b070ff', '#8929ff', '#440f85'], active: true },
]

function Tile({ name, colors, active }) {
  const holderRef = useRef(null)
  const [info, setInfo] = useState('…')

  useEffect(() => {
    const id = setInterval(() => {
      const canvas = holderRef.current?.querySelector('canvas')
      const host = holderRef.current
      if (!canvas || !host) return
      setInfo(
        [
          `css ${host.clientWidth}×${host.clientHeight}`,
          `backing ${canvas.width}×${canvas.height}`,
          `scale ${(canvas.width / host.clientWidth).toFixed(3)}`,
          `draws ${canvas.__draws || 0}`,
          `raf ${rafTicks}`,
          `draws/raf ${((canvas.__draws || 0) / Math.max(rafTicks, 1)).toFixed(3)}`,
        ].join('  '),
      )
    }, 400)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="tile" ref={holderRef}>
      <Grainient
        color1={colors[0]}
        color2={colors[1]}
        color3={colors[2]}
        timeSpeed={5}
        colorBalance={-0.32}
        blendAngle={-49}
        noiseScale={1.95}
        grainAmount={0}
        grainScale={0.2}
        active={active}
      />
      <div className="cap">{name}</div>
      <div className="cap" style={{ bottom: 18 }}>{info}</div>
    </div>
  )
}

function App() {
  return (
    <div className="row">
      {TILES.map((t) => (
        <Tile key={t.name} {...t} />
      ))}
    </div>
  )
}

createRoot(document.getElementById('root')).render(<App />)
