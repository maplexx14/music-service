import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import Grainient from './src/components/Grainient'

const PURPLE = ['#d2adff', '#943dff', '#4d287b']
const GREEN = ['#c3ffd8', '#59ff94', '#309350']
const RED = ['#ffc8c3', '#ff6759', '#933830']

const shared = {
  timeSpeed: 5,
  colorBalance: -0.32,
  warpStrength: 1.4,
  warpFrequency: 5,
  warpSpeed: 2,
  warpAmplitude: 50,
  blendAngle: -49,
  blendSoftness: 0.05,
  rotationAmount: 500,
  noiseScale: 1.95,
  grainAmount: 0,
  grainScale: 0.2,
  grainAnimated: false,
  contrast: 1.5,
  gamma: 1,
  saturation: 1,
  centerX: 0,
  centerY: 0,
  zoom: 0.9,
  active: true,
}

// Меняет палитру на лету — ровно то, что происходит на смене трека.
function Switcher({ from, to, delay }) {
  const [colors, setColors] = useState(from)
  useEffect(() => {
    const t = setTimeout(() => setColors(to), delay)
    return () => clearTimeout(t)
  }, [to, delay])
  return <Grainient {...shared} color1={colors[0]} color2={colors[1]} color3={colors[2]} />
}

function App() {
  return (
    <div style={{ display: 'flex', gap: 8, padding: 8, background: '#111' }}>
      <Box label="purple" node={<Grainient {...shared} color1={PURPLE[0]} color2={PURPLE[1]} color3={PURPLE[2]} />} />
      <Box label="green" node={<Grainient {...shared} color1={GREEN[0]} color2={GREEN[1]} color3={GREEN[2]} />} />
      <Box label="purple→red (live)" node={<Switcher from={PURPLE} to={RED} delay={150} />} />
    </div>
  )
}

function Box({ label, node }) {
  return (
    <div>
      <div style={{ position: 'relative', width: 360, height: 260, overflow: 'hidden', borderRadius: 12 }}>{node}</div>
      <div style={{ font: '12px monospace', color: '#9f9', padding: 4 }}>{label}</div>
    </div>
  )
}

createRoot(document.getElementById('root')).render(<App />)
