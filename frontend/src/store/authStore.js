import { create } from 'zustand'
import api from '../services/api'

// Simple localStorage persistence
const getStoredAuth = () => {
  try {
    const stored = localStorage.getItem('auth-storage')
    return stored ? JSON.parse(stored) : null
  } catch {
    return null
  }
}

const setStoredAuth = (data) => {
  try {
    localStorage.setItem('auth-storage', JSON.stringify(data))
  } catch {
    // Ignore storage errors
  }
}

const useAuthStore = create((set, get) => ({
  user: null,
  token: null,
  isAuthenticated: false,

  login: async (username, password) => {
    try {
      const response = await api.post('/auth/login', new URLSearchParams({
        username,
        password,
      }), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      })

      const { access_token } = response.data
      api.defaults.headers.common['Authorization'] = `Bearer ${access_token}`

      // Get user info
      const userResponse = await api.get('/auth/me')

      const newState = {
        token: access_token,
        user: userResponse.data,
        isAuthenticated: true,
      }
      set(newState)
      setStoredAuth(newState)

      return { success: true }
    } catch (error) {
      // Handle email not verified (403)
      if (error.response?.status === 403 && error.response?.data?.detail === 'email_not_verified') {
        // Extract email from headers or response
        const email = error.response?.headers?.['x-verify-email'] || ''
        return { success: false, needsVerification: true, email, error: 'Email не подтверждён' }
      }
      return { success: false, error: error.response?.data?.detail || 'Login failed' }
    }
  },

  register: async (username, email, password, fullName) => {
    try {
      await api.post('/auth/register', {
        username,
        email,
        password,
        full_name: fullName,
      })

      // Auto login after registration
      return await useAuthStore.getState().login(username, password)
    } catch (error) {
      return { success: false, error: error.response?.data?.detail || 'Registration failed' }
    }
  },

  logout: () => {
    delete api.defaults.headers.common['Authorization']
    set({
      user: null,
      token: null,
      isAuthenticated: false,
    })
    setStoredAuth(null)
  },

  checkAuth: async () => {
    const stored = getStoredAuth()
    if (stored && stored.token) {
      try {
        api.defaults.headers.common['Authorization'] = `Bearer ${stored.token}`
        const response = await api.get('/auth/me')
        set({
          user: response.data,
          token: stored.token,
          isAuthenticated: true,
        })
      } catch (error) {
        get().logout()
      }
    }
  },
})
)

// Persist state changes
useAuthStore.subscribe((state) => {
  if (state.token) {
    setStoredAuth({
      token: state.token,
      user: state.user,
    })
  }
})

// Initialize auth on load
if (typeof window !== 'undefined') {
  // Load initial state from storage
  const stored = getStoredAuth()
  if (stored) {
    useAuthStore.setState({
      token: stored.token,
      user: stored.user,
      isAuthenticated: !!stored.token,
    })
    if (stored.token) {
      api.defaults.headers.common['Authorization'] = `Bearer ${stored.token}`
      // Verify token is still valid
      useAuthStore.getState().checkAuth()
    }
  }
}

export { useAuthStore }
