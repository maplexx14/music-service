import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiUrl = env.VITE_API_URL || 'http://localhost:8000/api'
  const serverUrl = apiUrl.replace(/\/api\/?$/, '') || 'http://localhost:8000'

  return {
    plugins: [react()],
    build: {
      target: 'es2020',
      cssCodeSplit: true,
      sourcemap: false,

    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      // Явно событийный file-watcher (без поллинга): поллинг опрашивает
      // весь дерево файлов по таймеру и постоянно грузит CPU/диск даже
      // в простое. (Ранее здесь был недействующий server.usePolling —
      // опция читается только из server.watch.usePolling.)
      watch: {
        usePolling: false,
      },
      allowedHosts: true,
      port: 3000,
      proxy: {
        '/api': {
          target: serverUrl,
          changeOrigin: true,
        },
      },
    },
  }
})
