import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const result = await build({
  absWorkingDir: root,
  entryPoints: ['player-setup-preview.js'],
  bundle: true,
  write: false,
  outfile: 'preview.js',
  format: 'iife',
  target: 'es2020',
  minify: true,
  jsx: 'automatic',
  loader: { '.webp': 'dataurl', '.png': 'dataurl', '.jpg': 'dataurl', '.svg': 'dataurl', '.woff2': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
})
const js = result.outputFiles.find((f) => f.path.endsWith('.js')).text.replace(/<\/script/gi, '<\\/script')
const css = result.outputFiles.find((f) => f.path.endsWith('.css')).text
const output = path.resolve(root, '../output/player-setup-preview.html')
await mkdir(path.dirname(output), { recursive: true })
await writeFile(output, `<!doctype html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>BOLT — распаковка проигрывателя</title><style>${css}</style></head><body><div id="root"></div><script>${js}</script></body></html>`)
console.log(`Standalone preview: ${output}`)
