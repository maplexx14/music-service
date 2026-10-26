import { useEffect, useId, useState } from 'react'
import api from '../services/api'
import heartImage from '../assets/loader-heart.webp'
import './TasteAvatar.css'

// Аватарка по музыкальному вкусу в стилистике логотипа: рисунок из жидкого
// металла, как сердце на иконке приложения, поверх живой ауры — размытых
// пятен цвета двух главных жанров, которые медленно кружат. Металл
// подкрашен бликом главного жанра. Имя выбирает рисунок, наклон, свет и
// раскладку пятен, чтобы у двух фанатов фонка картинки не совпадали.
// Жанры — ключи из backend/app/genre_keywords.py (GENRE_KEYWORDS).

// Цвета: тёмная основа под аурой, пятно, яркое пятно и блик металла.
const GENRES = {
  phonk: ['#2a0a3d', '#7b1fa2', '#ff3df5'],
  trap: ['#14080a', '#b3121f', '#ff5a3c'],
  'hip-hop': ['#1c1408', '#b8860b', '#ffd54a'],
  rock: ['#121212', '#8a1414', '#ff4433'],
  electronic: ['#04102a', '#1440c8', '#21f0ff'],
  lofi: ['#3b2f4a', '#c48b9f', '#ffe3c2'],
  pop: ['#3a0820', '#ff4f9a', '#ff9f43'],
  jazz: ['#0b1a33', '#1f4e79', '#f2a541'],
  classical: ['#2b2216', '#8c7651', '#f5ead0'],
  reggae: ['#0f3b1f', '#1f9a4a', '#f2c418'],
  folk: ['#22301a', '#6b7f3a', '#e0c48a'],
  chill: ['#123a46', '#4fa3a5', '#d6c6ff'],
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

const hslHex = (h, s, l) => {
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100)
  const f = (n) => {
    const k = (n + h / 30) % 12
    const c = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return Math.round(c * 255).toString(16).padStart(2, '0')
  }
  return `#${f(0)}${f(8)}${f(4)}`
}

// Детерминированный ГПСЧ от имени: одна и та же картинка на всех устройствах.
const rng = (seed) => () => {
  seed = (seed + 0x6d2b79f5) >>> 0
  let t = seed
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

// Рисунки в координатах 0..100 — одна линия, как сердце в логотипе: её
// обводят толстой трубкой, а фильтр делает из трубки жидкий металл.
const DOODLES = {
  star: <path d="M50 22l7.6 16 17.4 2.4-12.7 12.2 3.1 17.4L50 61.6 34.6 70l3.1-17.4L25 40.4 42.4 38z" />,
  flame: <path d="M50 76c-13 0-20-9-18-20 2-10 10-14 12-24 7 6 8 13 7 18 4-2 6-6 6-9 7 6 11 13 10 20-1 9-8 15-17 15z" />,
  flower: <>
    <ellipse cx="50" cy="32" rx="7" ry="10" />
    <ellipse cx="68" cy="46" rx="10" ry="7" />
    <ellipse cx="32" cy="46" rx="10" ry="7" />
    <ellipse cx="50" cy="60" rx="7" ry="10" />
    <path d="M50 70v10" />
  </>,
  spiral: <path d="M50 50c0-3 4-3 4 0c0 5-8 6-9 0c-1-8 10-11 14-4c5 9-3 19-13 18c-12-1-17-14-11-23c7-11 25-10 31 2c6 13-3 28-18 29" />,
  eye: <>
    <path d="M22 50q28-28 56 0q-28 28-56 0z" />
    <circle cx="50" cy="50" r="6" />
  </>,
  planet: <>
    <circle cx="50" cy="50" r="15" />
    <path d="M28 63c-10 6 2 9 22 3s32-15 22-20" />
  </>,
  // Сердце из логотипа — та же картинка, что у лайка и лоадера: фильтру
  // металла нужна только её альфа, мазок кисти он и превращает в металл.
  heart: <image href={heartImage} x="21" y="22" width="58" height="58" />,
  mic: <>
    <rect x="41" y="24" width="18" height="30" rx="9" />
    <path d="M34 48q0 16 16 16t16-16M50 64v12" />
  </>,
}
const DOODLE_NAMES = Object.keys(DOODLES)

// '#rrggbb' → '0.5 0.2 0.9' для таблиц feComponentTransfer.
const rgb01 = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)

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
  const id = useId()
  const detected = useDetectedGenres(user?.id)
  // Слушает сервис — верим ему; выбор в онбординге — запасной вариант.
  const keys = [...new Set([...(detected || []), ...(user?.preferred_genres || [])].map(toKey).filter(Boolean))]
  const name = user?.username || ''
  const rand = rng(hash(name))

  let colors
  if (keys.length) {
    colors = GENRES[keys[0]]
  } else {
    // Вкус ещё не известен — свой оттенок по имени. Хексом: из него же
    // считаются таблицы металла.
    const hue = hash(name) % 360
    colors = [hslHex(hue, 35, 14), hslHex(hue + 40, 50, 42), hslHex(hue + 80, 75, 70)]
  }
  const second = keys[1] ? GENRES[keys[1]] : colors
  const doodleName = DOODLE_NAMES[hash(`${name}:doodle`) % DOODLE_NAMES.length]
  const doodle = DOODLES[doodleName]
  const tilt = doodleName === 'heart' ? 0 : Math.round(rand() * 24 - 12)
  const lightX = Math.round(20 + rand() * 60)
  const wobbleSeed = hash(name) % 97
  const [tr, tg, tb] = rgb01(colors[2])

  // Четыре пятна кружат вокруг центра с разной скоростью и в разные стороны.
  // Крутятся HTML-слои transform'ом — это композитор без перерисовки; blur
  // внутри SVG пересчитывался бы на каждом кадре.
  const blobs = [colors[1], colors[2], second[1], second[2]].map((color, i) => ({
    color,
    offset: Math.round(14 + rand() * 16),
    size: Math.round(100 + rand() * 40),
    start: Math.round(rand() * 360),
    spin: (9 + rand() * 10).toFixed(1),
    reverse: i % 2 === 1,
    opacity: i % 2 ? 0.75 : 0.95,
  }))

  return (
    <span className={`taste-avatar ${className || ''}`} style={{ backgroundColor: colors[0] }} aria-hidden="true">
      {blobs.map((b, i) => (
        <span
          key={i}
          className="taste-avatar-orbit"
          style={{
            '--start': `${b.start}deg`,
            animationDuration: `${b.spin}s`,
            animationDirection: b.reverse ? 'reverse' : 'normal',
          }}
        >
          <span
            className="taste-avatar-blob"
            style={{
              left: `${50 + b.offset - b.size / 2}%`,
              top: `${50 - b.size / 2}%`,
              width: `${b.size}%`,
              height: `${b.size}%`,
              opacity: b.opacity,
              background: `radial-gradient(circle closest-side, ${b.color} 25%, transparent)`,
              animationDuration: `${(b.spin / 2).toFixed(1)}s`,
            }}
          />
        </span>
      ))}
      <svg viewBox="0 0 100 100" focusable="false">
        <defs>
          {/* Жидкий металл: альфу линии размываем в рельеф, освещаем, и
              немонотонная таблица яркости даёт полосы отражений, как у хрома;
              середина таблицы — цвет блика жанра. Блёстки — точечный свет.
              Цвета литералами: currentColor/var() во feFlood WebKit не
              понимает. */}
          <filter id={`${id}-metal`} x="-20%" y="-20%" width="140%" height="140%" colorInterpolationFilters="sRGB">
            <feGaussianBlur in="SourceAlpha" stdDeviation="2.2" result="bump" />
            <feDiffuseLighting in="bump" surfaceScale="6" diffuseConstant="1" lightingColor="#fff" result="diffuse">
              <feDistantLight azimuth="235" elevation="38" />
            </feDiffuseLighting>
            <feComponentTransfer in="diffuse" result="bands">
              <feFuncR type="table" tableValues={`0.08 ${tr} 1 0.55 1`} />
              <feFuncG type="table" tableValues={`0.06 ${tg} 1 0.5 1`} />
              <feFuncB type="table" tableValues={`0.12 ${tb} 1 0.6 1`} />
            </feComponentTransfer>
            <feSpecularLighting
              in="bump"
              surfaceScale="6"
              specularConstant="1.1"
              specularExponent="28"
              lightingColor="#fff"
              result="spec"
            >
              <fePointLight x={lightX} y="10" z="60" />
            </feSpecularLighting>
            <feComposite in="bands" in2="spec" operator="arithmetic" k2="1" k3="0.9" />
            {/* Рельеф из 8-битной альфы на ретине идёт ступеньками — сглаживаем. */}
            <feGaussianBlur stdDeviation="0.5" result="lit" />
            <feComposite in="lit" in2="SourceAlpha" operator="in" result="metal" />
            <feGaussianBlur in="SourceAlpha" stdDeviation="3" result="glowArea" />
            <feFlood floodColor={colors[2]} floodOpacity="0.45" />
            <feComposite in2="glowArea" operator="in" result="glow" />
            <feOffset in="SourceAlpha" dx="1.5" dy="3" result="shadowArea" />
            <feFlood floodColor="#000" floodOpacity="0.8" />
            <feComposite in2="shadowArea" operator="in" result="shadow" />
            <feMerge>
              <feMergeNode in="glow" />
              <feMergeNode in="shadow" />
              <feMergeNode in="metal" />
            </feMerge>
          </filter>
          {/* Неровный, как от руки, край линии. */}
          <filter id={`${id}-wobble`} x="-10%" y="-10%" width="120%" height="120%">
            <feTurbulence type="fractalNoise" baseFrequency="0.04" seed={wobbleSeed} />
            <feDisplacementMap in="SourceGraphic" scale="4" />
          </filter>
          {/* Мазок сердца тоньше трубок остальных рисунков — расширяем. */}
          <filter id={`${id}-thick`} x="-10%" y="-10%" width="120%" height="120%">
            <feMorphology operator="dilate" radius="1.2" />
          </filter>
        </defs>
        <g filter={`url(#${id}-metal)`}>
          <g
            fill="none"
            stroke="#fff"
            strokeWidth="7.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            filter={`url(#${id}-wobble)`}
            transform={`translate(50 50) scale(1.18) rotate(${tilt}) translate(-50 -50)`}
          >
            {doodleName === 'heart' ? <g filter={`url(#${id}-thick)`}>{doodle}</g> : doodle}
          </g>
        </g>
      </svg>
    </span>
  )
}

export default TasteAvatar
