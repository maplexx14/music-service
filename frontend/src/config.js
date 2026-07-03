function getApiUrl() {
  if (typeof window !== 'undefined') {
    const runtime = window.__APP_CONFIG__?.VITE_API_URL
    if (runtime && runtime.trim()) return runtime.trim()
    const buildTime = import.meta.env.VITE_API_URL
    if (buildTime && buildTime.trim()) return buildTime.trim()
    return window.location.origin + '/api'
  }
  return import.meta.env.VITE_API_URL || 'http://localhost:8000/api'
}

const API_URL = getApiUrl()
const SERVER_URL = API_URL.replace(/\/api\/?$/, '') || API_URL

export { API_URL, SERVER_URL }
