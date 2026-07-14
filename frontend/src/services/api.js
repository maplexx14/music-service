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

const api = axios.create({
  baseURL: API_URL,
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
    if (status === 401) {
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

export default api
