import tailwindcss from '@tailwindcss/postcss'
import autoprefixer from 'autoprefixer'
import hoverOnly from './postcss/hover-only.js'

export default {
  // hover-only — после Tailwind: он раскрывает @apply и свои варианты, а
  // плагину нужен уже готовый CSS (см. postcss/hover-only.js).
  plugins: [tailwindcss(), hoverOnly(), autoprefixer()],
}
