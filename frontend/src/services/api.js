import axios from 'axios'
import { API_URL } from '../config'
import { toast } from '../store/toastStore'

let authToken = null

try {
  const stored = localStorage.getItem('auth-storage')
  const parsed = stored ? JSON.parse(stored) : null
  authToken = parsed?.token || null
} catch {
  authToken = null
}

// Токен доверенного устройства. Живёт отдельно от auth-storage и НЕ чистится
// при logout: он помнит устройство, а не сессию — иначе каждый выход требовал
// бы заново подтверждать код на входе.
const DEVICE_TOKEN_KEY = 'device-token'

export const getDeviceToken = () => {
  try {
    return localStorage.getItem(DEVICE_TOKEN_KEY) || null
  } catch {
    return null
  }
}

export const setDeviceToken = (token) => {
  try {
    if (token) {
      localStorage.setItem(DEVICE_TOKEN_KEY, token)
    } else {
      localStorage.removeItem(DEVICE_TOKEN_KEY)
    }
  } catch {
    // Приватный режим блокирует запись — тогда каждый вход просит код.
    // Хуже по UX, но безопасно, поэтому просто игнорируем.
  }
}

const api = axios.create({
  baseURL: API_URL,
  timeout: 60000,
  headers: {
    'Content-Type': 'application/json',
    // Обход предупреждающих страниц туннелей (tuna.am / ngrok free): без этих
    // заголовков свежий браузер получает HTML-заглушку вместо JSON/аудио.
    'tuna-skip-browser-warning': '1',
    'ngrok-skip-browser-warning': '1',
  },
})

// Request interceptor to add auth token
api.interceptors.request.use(
  (config) => {
    if (authToken) {
      config.headers.Authorization = `Bearer ${authToken}`
    }
    // Заголовок ставим всегда: по нему бэк узнаёт знакомое устройство на
    // логине и помечает «это устройство» в списке настроек.
    const deviceToken = getDeviceToken()
    if (deviceToken) {
      config.headers['X-Device-Token'] = deviceToken
    }
    return config
  },
  (error) => {
    return Promise.reject(error)
  }
)

// Response interceptor for error handling
api.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error.response?.status
    // skipAuthRedirect — для запросов, где 401 означает «неверные данные в
    // форме», а не «сессия умерла»: шаг 2FA при входе, подтверждение пароля.
    // Без флага опечатка в TOTP-коде выкидывала бы на экран входа.
    if (status === 401 && error.config?.skipAuthRedirect !== true) {
      // Не делаем полный reload: он уничтожает <audio>, очередь и Media Session.
      // Store обработает событие и React Router покажет экран входа без перезагрузки.
      localStorage.removeItem('auth-storage')
      setApiAuthToken(null)
      window.dispatchEvent(new CustomEvent('auth:unauthorized'))
    } else if (error.config?.skipErrorToast !== true) {
      const detail = error.response?.data?.detail
      const message =
        (typeof detail === 'string' && detail) ||
        (status ? `Ошибка запроса (${status})` : 'Сервер недоступен. Проверьте соединение')
      toast.error(message)
    }
    return Promise.reject(error)
  }
)

export const setApiAuthToken = (token) => {
  authToken = token || null
  if (authToken) {
    api.defaults.headers.common.Authorization = `Bearer ${authToken}`
  } else {
    delete api.defaults.headers.common.Authorization
  }
}

// Reuse identical concurrent GET requests. This prevents route remounts and
// neighbouring components from issuing duplicate work while preserving Axios' API.
const pendingGets = new Map()
const rawGet = api.get.bind(api)

api.get = (url, config = {}) => {
  if (config.signal || config.dedupe === false) {
    const { dedupe: _dedupe, ...axiosConfig } = config
    return rawGet(url, axiosConfig)
  }

  const params = new URLSearchParams()
  Object.entries(config.params || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([key, value]) => params.append(key, String(value)))
  const key = `${authToken || 'anonymous'}:${url}?${params.toString()}`
  const pending = pendingGets.get(key)
  if (pending) return pending

  const { dedupe: _dedupe, ...axiosConfig } = config
  const request = rawGet(url, axiosConfig).finally(() => pendingGets.delete(key))
  pendingGets.set(key, request)
  return request
}

export default api
