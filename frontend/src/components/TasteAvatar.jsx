import { useEffect, useId, useState } from 'react'
import api from '../services/api'

// Аватарка, нарисованная по музыкальному вкусу: главный жанр задаёт палитру и
// узор, второй — подмешивает свой узор поверх, а имя пользователя сдвигает
// поворот и положение, чтобы у двух фанатов фонка картинки не совпадали.
// Жанры — ключи из backend/app/genre_keywords.py (GENRE_KEYWORDS).

const GENRES = {
  phonk: { colors: ['#2a0a3d', '#7b1fa2', '#ff3df5'], motif: 'shards' },
  trap: { colors: ['#14080a', '#b3121f', '#ff5a3c'], motif: 'bars' },
  'hip-hop': { colors: ['#1c1408', '#b8860b', '#ffd54a'], motif: 'vinyl' },
  rock: { colors: ['#121212', '#5a1010', '#ff4433'], motif: 'distortion' },
  electronic: { colors: ['#04102a', '#1440c8', '#21f0ff'], motif: 'wave' },
  lofi: { colors: ['#3b2f4a', '#c48b9f', '#ffe3c2'], motif: 'moon' },
  pop: { colors: ['#ff4f9a', '#ff9f43', '#fff35c'], motif: 'bubbles' },
  jazz: { colors: ['#0b1a33', '#1f4e79', '#f2a541'], motif: 'swirl' },
  classical: { colors: ['#2b2216', '#8c7651', '#f5ead0'], motif: 'staff' },
  reggae: { colors: ['#0f6b2f', '#f2c418', '#d6261c'], motif: 'bands' },
  folk: { colors: ['#22301a', '#6b7f3a', '#e0c48a'], motif: 'leaves' },
  chill: { colors: ['#123a46', '#4fa3a5', '#d6c6ff'], motif: 'blobs' },
}

// Явные предпочтения бывают тегами Last.fm («drum and bass», «хип-хоп») —
// сводим их к нашим ключам по тем же словам, что и бэкенд.
const KEYWORDS = [
  ['phonk', ['phonk', 'фонк']],
  ['trap', ['trap', 'трэп', 'треп']],
  ['hip-hop', ['rap', 'hip hop', 'hip-hop', 'рэп', 'хип']],
  ['lofi', ['lofi', 'lo-fi', 'lo fi']],
  ['rock', ['rock', 'рок', 'metal', 'метал', 'punk', 'панк']],
  ['electronic', ['edm', 'techno', 'техно', 'dubstep', 'house', 'хаус', 'electro', 'электро', 'dnb', 'drum and bass', 'hardstyle']],
  ['pop', ['pop', 'поп']],
  ['jazz', ['jazz', 'джаз']],
  ['classical', ['classical', 'классика', 'orchestra', 'оркестр', 'symphony', 'симфони']],
  ['reggae', ['reggae', 'регги']],
  ['folk', ['folk', 'фолк', 'народн']],
  ['chill', ['chill', 'ambient', 'эмбиент', 'релакс', 'relax']],
]

const toKey = (tag) => {
  const t = String(tag || '').toLowerCase()
  if (GENRES[t]) return t
  const hit = KEYWORDS.find(([, words]) => words.some((w) => t.includes(w)))
  return hit ? hit[0] : null
}

const hash = (str) => {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

// Детерминированный ГПСЧ от имени: одна и та же картинка на всех устройствах.
const rng = (seed) => () => {
  seed = (seed + 0x6d2b79f5) >>> 0
  let t = seed
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

// Узоры в координатах 0..100. color — акцент, rand — ГПСЧ пользователя.
const MOTIFS = {
  shards: (c, r) =>
    [0, 1, 2].map((i) => {
      const x = 15 + r() * 70
      const y = 15 + r() * 70
      const s = 18 + r() * 22
      return <polygon key={i} points={`${x},${y - s} ${x + s * 0.6},${y + s * 0.5} ${x - s * 0.5},${y + s * 0.3}`} fill={c} opacity={0.35 + i * 0.15} />
    }),
  bars: (c, r) =>
    [0, 1, 2, 3].map((i) => (
      <rect key={i} x={-20 + i * 30 + r() * 8} y="-20" width={6 + r() * 8} height="140" fill={c} opacity="0.45" transform="rotate(30 50 50)" />
    )),
  vinyl: (c) =>
    [38, 30, 22, 14].map((rad, i) => (
      <circle key={i} cx="50" cy="50" r={rad} fill="none" stroke={c} strokeWidth={i === 3 ? 10 : 2.5} opacity={0.4 + i * 0.12} />
    )),
  // Рваная волна перегруза. Молния — эмблема самого сервиса, поэтому главным
  // элементом её не делаем: изредка (по имени) она мелькает маленькой в углу.
  distortion: (c, r) => (
    <>
      {[0, 1, 2].map((i) => {
        const y = 32 + i * 18
        let d = `M-5 ${y}`
        for (let x = 5; x <= 105; x += 10) d += ` L${x} ${y + (x % 20 ? -1 : 1) * (4 + r() * 8)}`
        return <path key={i} d={d} fill="none" stroke={c} strokeWidth="3" strokeLinejoin="miter" opacity={0.35 + i * 0.2} />
      })}
      {r() < 0.3 && <polygon points="76,12 68,26 74,26 70,38 82,22 76,22 80,12" fill={c} opacity="0.6" />}
    </>
  ),
  wave: (c, r) =>
    [0, 1, 2].map((i) => {
      const y = 30 + i * 20
      const a = 6 + r() * 8
      return <path key={i} d={`M-5 ${y} Q 12 ${y - a} 25 ${y} T 55 ${y} T 85 ${y} T 115 ${y}`} fill="none" stroke={c} strokeWidth="3" opacity={0.4 + i * 0.2} />
    }),
  moon: (c) => (
    <>
      <circle cx="60" cy="40" r="20" fill={c} opacity="0.85" />
      {[66, 76, 86].map((y, i) => <rect key={y} x="0" y={y} width="100" height="4" fill={c} opacity={0.5 - i * 0.12} />)}
    </>
  ),
  bubbles: (c, r) =>
    [0, 1, 2, 3, 4].map((i) => (
      <circle key={i} cx={10 + r() * 80} cy={10 + r() * 80} r={6 + r() * 16} fill={c} opacity={0.3 + r() * 0.4} />
    )),
  swirl: (c) => (
    <path d="M50 50 m0 -6 a6 6 0 1 1 -6 6 a12 12 0 1 1 12 12 a20 20 0 1 1 -20 -20 a30 30 0 1 1 30 30" fill="none" stroke={c} strokeWidth="4" strokeLinecap="round" opacity="0.75" />
  ),
  staff: (c) => (
    <>
      {[34, 42, 50, 58, 66].map((y) => <line key={y} x1="0" y1={y} x2="100" y2={y} stroke={c} strokeWidth="1.5" opacity="0.55" />)}
      <ellipse cx="40" cy="62" rx="7" ry="5" fill={c} transform="rotate(-20 40 62)" opacity="0.9" />
      <line x1="46" y1="61" x2="46" y2="26" stroke={c} strokeWidth="2.5" opacity="0.9" />
    </>
  ),
  bands: (c, r, colors) =>
    colors.map((col, i) => <rect key={i} x="-20" y={20 + i * 22} width="140" height="14" fill={col} opacity="0.75" transform="rotate(-15 50 50)" />),
  leaves: (c, r) =>
    [0, 1, 2].map((i) => {
      const x = 20 + r() * 60
      const y = 20 + r() * 60
      return <path key={i} d={`M${x} ${y} q 14 -18 28 0 q -14 18 -28 0 z`} fill={c} opacity={0.4 + i * 0.15} transform={`rotate(${r() * 360} ${x + 14} ${y})`} />
    }),
  blobs: (c, r) =>
    [0, 1, 2].map((i) => (
      <ellipse key={i} cx={20 + r() * 60} cy={20 + r() * 60} rx={18 + r() * 14} ry={12 + r() * 10} fill={c} opacity="0.3" />
    )),
}

// Вкус меняется медленно: держим последний ответ в localStorage, чтобы
// аватарка рисовалась сразу, и один раз за сессию освежаем его.
const STORAGE_KEY = 'taste-avatar-genres'
let tastePromise = null

const readStored = (userId) => {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')
    return saved?.userId === userId ? saved.genres : null
  } catch {
    return null
  }
}

function useDetectedGenres(userId) {
  const [genres, setGenres] = useState(() => (userId ? readStored(userId) : null))
  useEffect(() => {
    if (!userId) return
    let active = true
    if (!tastePromise || tastePromise.userId !== userId) {
      tastePromise = api.get('/users/me/taste').then((res) => res.data?.genres || [])
      tastePromise.userId = userId
      tastePromise.catch(() => {
        tastePromise = null
      })
    }
    tastePromise
      .then((list) => {
        if (!active) return
        setGenres(list)
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify({ userId, genres: list }))
        } catch {
          // Ignore storage errors
        }
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [userId])
  return genres
}

function TasteAvatar({ user, className }) {
  const gradId = useId()
  const detected = useDetectedGenres(user?.id)
  // Слушает сервис — верим ему; выбор в онбординге — запасной вариант.
  const keys = [...new Set([...(detected || []), ...(user?.preferred_genres || [])].map(toKey).filter(Boolean))]
  const name = user?.username || ''
  const rand = rng(hash(name))

  let colors
  if (keys.length) {
    colors = GENRES[keys[0]].colors
  } else {
    // Вкус ещё не известен — нейтральный градиент своего оттенка.
    const hue = hash(name) % 360
    colors = [`hsl(${hue} 35% 18%)`, `hsl(${(hue + 40) % 360} 45% 38%)`, `hsl(${(hue + 80) % 360} 70% 70%)`]
  }
  const primary = keys[0] && GENRES[keys[0]]
  const secondary = keys[1] && GENRES[keys[1]]
  const angle = Math.round(rand() * 360)

  return (
    <svg className={className} viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={gradId} gradientTransform={`rotate(${angle} 0.5 0.5)`}>
          <stop offset="0" stopColor={colors[0]} />
          <stop offset="1" stopColor={colors[1]} />
        </linearGradient>
      </defs>
      <rect width="100" height="100" fill={`url(#${gradId})`} />
      {primary && <g transform={`rotate(${Math.round(rand() * 40 - 20)} 50 50)`}>{MOTIFS[primary.motif](colors[2], rand, colors)}</g>}
      {secondary && (
        <g opacity="0.45" transform={`rotate(${Math.round(rand() * 360)} 50 50)`}>
          {MOTIFS[secondary.motif](secondary.colors[2], rand, secondary.colors)}
        </g>
      )}
      {!primary && (
        <text x="50" y="50" dy="0.35em" textAnchor="middle" fontSize="42" fontWeight="700" fill="#fff" fontFamily="inherit">
          {(name || 'U').charAt(0).toUpperCase()}
        </text>
      )}
    </svg>
  )
}

export default TasteAvatar
