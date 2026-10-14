import { useEffect, useId, useState } from 'react'
import api from '../services/api'

// Аватарка по музыкальному вкусу в стилистике логотипа: у каждого жанра своё
// животное — силуэт головы белым меловым контуром, как сердце в логотипе, без
// черт лица, — на чёрном фоне
// со свечением цвета жанра (как иконка приложения). Второй жанр подмешивает
// второе свечение, а имя пользователя сдвигает его место и наклон головы,
// чтобы у двух фанатов фонка картинки не совпадали.
// Жанры — ключи из backend/app/genre_keywords.py (GENRE_KEYWORDS).

const GENRES = {
  phonk: { colors: ['#2a0a3d', '#7b1fa2', '#ff3df5'], animal: 'cat' },
  trap: { colors: ['#14080a', '#b3121f', '#ff5a3c'], animal: 'fox' },
  'hip-hop': { colors: ['#1c1408', '#b8860b', '#ffd54a'], animal: 'bear' },
  rock: { colors: ['#121212', '#5a1010', '#ff4433'], animal: 'wolf' },
  electronic: { colors: ['#04102a', '#1440c8', '#21f0ff'], animal: 'rabbit' },
  lofi: { colors: ['#3b2f4a', '#c48b9f', '#ffe3c2'], animal: 'panda' },
  pop: { colors: ['#ff4f9a', '#ff9f43', '#fff35c'], animal: 'pig' },
  jazz: { colors: ['#0b1a33', '#1f4e79', '#f2a541'], animal: 'owl' },
  classical: { colors: ['#2b2216', '#8c7651', '#f5ead0'], animal: 'mouse' },
  reggae: { colors: ['#0f6b2f', '#f2c418', '#d6261c'], animal: 'frog' },
  folk: { colors: ['#22301a', '#6b7f3a', '#e0c48a'], animal: 'dog' },
  chill: { colors: ['#123a46', '#4fa3a5', '#d6c6ff'], animal: 'koala' },
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

// Силуэты голов в координатах 0..100 — только формы, без черт лица: контур
// по внешнему краю их объединения рисует фильтр (см. TasteAvatar ниже).
const tri = (points) => <polygon points={points} />

const ANIMALS = {
  cat: (
    <>
      {tri('25,48 29,17 47,34')}
      {tri('75,48 71,17 53,34')}
      <ellipse cx="50" cy="58" rx="28" ry="24" />
    </>
  ),
  fox: (
    <>
      {tri('20,52 25,12 49,40')}
      {tri('80,52 75,12 51,40')}
      <path d="M20 46 Q50 28 80 46 Q78 64 50 88 Q22 64 20 46Z" />
    </>
  ),
  bear: (
    <>
      <circle cx="29" cy="35" r="10" />
      <circle cx="71" cy="35" r="10" />
      <circle cx="50" cy="58" r="27" />
    </>
  ),
  wolf: (
    <>
      {tri('21,54 27,8 48,40')}
      {tri('79,54 73,8 52,40')}
      <path d="M18 50 Q50 26 82 50 L74 70 Q62 90 50 90 Q38 90 26 70Z" />
    </>
  ),
  rabbit: (
    <>
      <ellipse cx="40" cy="26" rx="7" ry="22" transform="rotate(-8 40 26)" />
      <ellipse cx="60" cy="26" rx="7" ry="22" transform="rotate(8 60 26)" />
      <ellipse cx="50" cy="62" rx="24" ry="22" />
    </>
  ),
  panda: (
    <>
      <circle cx="27" cy="36" r="11" />
      <circle cx="73" cy="36" r="11" />
      <ellipse cx="50" cy="59" rx="30" ry="25" />
    </>
  ),
  pig: (
    <>
      {tri('24,44 22,22 42,32')}
      {tri('76,44 78,22 58,32')}
      <ellipse cx="50" cy="56" rx="28" ry="24" />
      <ellipse cx="50" cy="76" rx="12" ry="8" />
    </>
  ),
  owl: <path d="M24 42 L28 14 L44 32 Q50 30 56 32 L72 14 L76 42 Q84 72 50 88 Q16 72 24 42Z" />,
  mouse: (
    <>
      <circle cx="27" cy="38" r="14" />
      <circle cx="73" cy="38" r="14" />
      <path d="M28 58 Q30 38 50 38 Q70 38 72 58 Q68 76 50 86 Q32 76 28 58Z" />
    </>
  ),
  frog: (
    <>
      <circle cx="34" cy="44" r="11" />
      <circle cx="66" cy="44" r="11" />
      <ellipse cx="50" cy="64" rx="33" ry="20" />
    </>
  ),
  dog: (
    <>
      <ellipse cx="50" cy="54" rx="24" ry="26" />
      <ellipse cx="26" cy="56" rx="9" ry="20" transform="rotate(14 26 56)" />
      <ellipse cx="74" cy="56" rx="9" ry="20" transform="rotate(-14 74 56)" />
      <ellipse cx="50" cy="74" rx="13" ry="11" />
    </>
  ),
  koala: (
    <>
      <circle cx="24" cy="42" r="15" />
      <circle cx="76" cy="42" r="15" />
      <ellipse cx="50" cy="58" rx="26" ry="25" />
    </>
  ),
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
    // Вкус ещё не известен — свечение своего оттенка по имени.
    const hue = hash(name) % 360
    colors = [`hsl(${hue} 35% 18%)`, `hsl(${(hue + 40) % 360} 45% 38%)`, `hsl(${(hue + 80) % 360} 70% 70%)`]
  }
  const primary = keys[0] && GENRES[keys[0]]
  const secondary = keys[1] && GENRES[keys[1]]
  const glowX = Math.round(30 + rand() * 40)
  const tilt = Math.round(rand() * 12 - 6)
  const animal = primary ? primary.animal : 'bear'

  return (
    <svg className={className} viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id={`${gradId}-a`} cx={glowX / 100} cy="1.05" r="0.85">
          <stop offset="0" stopColor={colors[1]} stopOpacity="0.95" />
          <stop offset="1" stopColor={colors[1]} stopOpacity="0" />
        </radialGradient>
        {secondary && (
          <radialGradient id={`${gradId}-b`} cx={(100 - glowX) / 100} cy="-0.05" r="0.6">
            <stop offset="0" stopColor={secondary.colors[1]} stopOpacity="0.6" />
            <stop offset="1" stopColor={secondary.colors[1]} stopOpacity="0" />
          </radialGradient>
        )}
        {/* Контур по внешнему краю силуэта (кольцо = расширенная альфа минус
            сама фигура) и неровный край, как у мела в логотипе. Цвет заливки —
            литералом: currentColor/var() во feFlood WebKit не понимает. */}
        <filter id={`${gradId}-chalk`} x="-10%" y="-10%" width="120%" height="120%">
          <feMorphology in="SourceAlpha" operator="dilate" radius="2" result="wide" />
          <feComposite in="wide" in2="SourceAlpha" operator="out" result="ring" />
          <feFlood floodColor="#ffffff" floodOpacity="0.85" />
          <feComposite in2="ring" operator="in" result="line" />
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="3" result="noise" />
          <feDisplacementMap in="line" in2="noise" scale="1.6" />
        </filter>
      </defs>
      <rect width="100" height="100" fill="#000" />
      <rect width="100" height="100" fill={`url(#${gradId}-a)`} />
      {secondary && <rect width="100" height="100" fill={`url(#${gradId}-b)`} />}
      <g
        fill="#fff"
        filter={`url(#${gradId}-chalk)`}
        transform={`translate(50 56) scale(0.82) rotate(${tilt}) translate(-50 -50)`}
      >
        {ANIMALS[animal]}
      </g>
    </svg>
  )
}

export default TasteAvatar
