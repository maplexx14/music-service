import { create } from 'zustand'
import api, { setApiAuthToken, setDeviceToken } from '../services/api'
import { useSearchStore } from './searchStore'
import { invalidateFlowPreload } from './playerStore'

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

          // 2FA включена: пароль принят, но входа ещё нет. mfa_token не
          // работает как обычный токен (бэк его отклоняет), поэтому в стор
          // не кладём — держим в памяти формы до ввода кода.
          if (response.data?.mfa_required) {
            return {
              success: false,
              mfaRequired: true,
              mfaToken: response.data.mfa_token,
              mfaMethods: response.data.mfa_methods || [],
              // Когда почта — единственный фактор, бэк уже отправил письмо.
              emailCodeSent: Boolean(response.data.email_code_sent),
              emailMasked: response.data.email_masked || '',
              // Код спрашивают из-за незнакомого устройства, а не потому что
              // юзер включал 2FA — форма объясняет это отдельным текстом.
              newDevice: Boolean(response.data.new_device),
            }
          }

          return await useAuthStore.getState().finalizeLogin(response.data.access_token)
        } catch (error) {
          // 403 = почта не подтверждена. Отдельный флаг, чтобы форма показала
          // кнопку повторной отправки вместо голой ошибки.
          if (error.response?.status === 403) {
            return {
              success: false,
              emailUnverified: true,
              error: error.response?.data?.detail || 'Подтвердите почту',
            }
          }
          return { success: false, error: error.response?.data?.detail || 'Login failed' }
        }
      },

      // Повторная отправка письма. Пароль нужен бэку, чтобы перебором
      // username нельзя было спамить чужой ящик.
      resendVerification: async (username, password) => {
        try {
          const response = await api.post('/auth/resend-verification', {
            username,
            password,
          }, { skipErrorToast: true, skipAuthRedirect: true })
          return { success: true, message: response.data?.message }
        } catch (error) {
          return {
            success: false,
            error: error.response?.data?.detail || 'Не удалось отправить письмо',
          }
        }
      },

      verifyEmail: async (token) => {
        try {
          const response = await api.post('/auth/verify-email', { token }, {
            skipErrorToast: true,
            skipAuthRedirect: true,
          })
          if (response.data?.access_token) {
            const loginResult = await useAuthStore.getState().finalizeLogin(
              response.data.access_token,
            )
            if (!loginResult.success) {
              return { success: true, authenticated: false }
            }
          }
          return { success: true, authenticated: Boolean(response.data?.access_token) }
        } catch (error) {
          return {
            success: false,
            error: error.response?.data?.detail || 'Ссылка недействительна',
          }
        }
      },

      // Отправка кода на почту на втором шаге входа. sent: false с
      // cooldownSeconds — не ошибка: предыдущее письмо ещё живо.
      sendEmailCode: async (mfaToken) => {
        try {
          const response = await api.post('/auth/mfa/email/send', {
            mfa_token: mfaToken,
          }, { skipErrorToast: true, skipAuthRedirect: true })
          return {
            success: true,
            sent: Boolean(response.data?.sent),
            cooldownSeconds: response.data?.cooldown_seconds || 0,
            emailMasked: response.data?.email_masked || '',
          }
        } catch (error) {
          const status = error.response?.status
          const expired = status === 401
          // 503 — код выписан, но доставить его нечем (на сервере не настроен
          // SMTP). Юзеру важно понять, что ждать письма бессмысленно.
          if (status === 503) {
            return {
              success: false,
              error: 'Код отправить нечем: почта на сервере не настроена',
            }
          }
          return {
            success: false,
            expired,
            error: expired
              ? 'Сессия входа истекла — войдите заново'
              : error.response?.data?.detail || 'Не удалось отправить код',
          }
        }
      },

      // Второй шаг входа: TOTP-код, код из письма либо резервный код.
      verifyMfa: async (mfaToken, code, method) => {
        try {
          const response = await api.post('/auth/mfa/verify', {
            mfa_token: mfaToken,
            code,
            ...(method ? { method } : {}),
          }, { skipErrorToast: true, skipAuthRedirect: true })
          // Устройство подтверждено — запоминаем его, чтобы следующий вход
          // не требовал код заново.
          if (response.data?.device_token) {
            setDeviceToken(response.data.device_token)
          }
          return await useAuthStore.getState().finalizeLogin(response.data.access_token)
        } catch (error) {
          const status = error.response?.status
          // mfa_token живёт минуты — по истечении надо начинать с пароля,
          // иначе юзер бесконечно тыкает код в мёртвую форму.
          const expired = status === 401 && error.response?.data?.detail === 'Invalid mfa_token'
          return {
            success: false,
            expired,
            error: expired
              ? 'Сессия входа истекла — войдите заново'
              : error.response?.data?.detail || 'Неверный код',
          }
        }
      },

      // Общий хвост обоих путей входа: сохранить токен и подтянуть профиль.
      finalizeLogin: async (accessToken) => {
        try {
          setApiAuthToken(accessToken)
          const userResponse = await api.get('/auth/me')

          const newState = {
            token: accessToken,
            user: userResponse.data,
            isAuthenticated: true,
          }
          set(newState)
          setStoredAuth(newState)

          return { success: true }
        } catch (error) {
          setApiAuthToken(null)
          return { success: false, error: error.response?.data?.detail || 'Login failed' }
        }
      },
      
      // Настройки каптчи для формы регистрации. Ключ виджета живёт на бэке
      // (см. backend/app/captcha.py), поэтому спрашиваем его, а не берём из
      // сборки: фронт не может показать виджет, который бэк не проверяет.
      fetchCaptchaConfig: async () => {
        try {
          const response = await api.get('/auth/captcha-config', {
            skipErrorToast: true,
            skipAuthRedirect: true,
          })
          return {
            success: true,
            required: Boolean(response.data?.required),
            siteKey: response.data?.site_key || '',
          }
        } catch {
          // Конфиг не прочитан — неизвестно, нужна ли каптча. Форма скажет об
          // этом прямо: без виджета регистрация упрётся в 400 от бэка, и
          // молчаливая форма выглядела бы просто сломанной.
          return { success: false, required: false, siteKey: '' }
        }
      },

      register: async (username, email, password, captchaToken) => {
        try {
          await api.post('/auth/register', {
            username,
            email,
            password,
            captcha_token: captchaToken || null,
          })

          // Авто-входа больше нет: бэк не пускает до подтверждения почты.
          // Форма показывает экран "проверьте письмо".
          return { success: true, verificationRequired: true }
        } catch (error) {
          const status = error.response?.status
          const detail = error.response?.data?.detail
          // Каптча: бэк отвечает англоязычными кодами (они же в логах), но на
          // форме нужен человеческий текст. 503 — проверка недоступна, а не
          // «вы не прошли»: подсказываем повторить, а не искать ошибку в себе.
          if (status === 503 && detail === 'Captcha temporarily unavailable') {
            return {
              success: false,
              error: 'Проверка «я не робот» сейчас недоступна — попробуйте ещё раз',
            }
          }
          if (detail === 'Captcha required' || detail === 'Captcha verification failed') {
            return {
              success: false,
              error: 'Подтвердите, что вы не робот, и повторите отправку',
            }
          }
          return { success: false, error: detail || 'Registration failed' }
        }
      },
      
      // --- Двухфакторка (TOTP) ---
      // Секрет и QR приходят с бэка; коды восстановления показываются ровно
      // один раз при включении, поэтому наружу их отдаёт вызывающий экран.
      setupTwoFactor: async () => {
        try {
          const response = await api.post('/auth/2fa/setup', null, { skipErrorToast: true })
          return { success: true, data: response.data }
        } catch (error) {
          return { success: false, error: error.response?.data?.detail || 'Не удалось начать настройку' }
        }
      },

      enableTwoFactor: async (code, password) => {
        try {
          const response = await api.post('/auth/2fa/enable', { code, password }, {
            skipErrorToast: true,
            skipAuthRedirect: true,
          })
          // Профиль поменялся (totp_enabled) — обновляем, чтобы настройки и
          // остальной UI не показывали устаревшее состояние.
          await useAuthStore.getState().refreshUser()
          return { success: true, recoveryCodes: response.data.recovery_codes || [] }
        } catch (error) {
          return { success: false, error: error.response?.data?.detail || 'Не удалось включить 2FA' }
        }
      },

      disableTwoFactor: async (password) => {
        try {
          await api.post('/auth/2fa/disable', { password }, {
            skipErrorToast: true,
            skipAuthRedirect: true,
          })
          await useAuthStore.getState().refreshUser()
          return { success: true }
        } catch (error) {
          return { success: false, error: error.response?.data?.detail || 'Не удалось выключить 2FA' }
        }
      },

      // --- Двухфакторка по почте ---
      // Ключ отдельный от TOTP: факторы включаются независимо друг от друга.
      setupEmailTwoFactor: async () => {
        try {
          const response = await api.post('/auth/2fa/email/setup', null, {
            skipErrorToast: true,
            skipAuthRedirect: true,
          })
          return {
            success: true,
            sent: Boolean(response.data?.sent),
            cooldownSeconds: response.data?.cooldown_seconds || 0,
            emailMasked: response.data?.email_masked || '',
          }
        } catch (error) {
          return {
            success: false,
            error:
              error.response?.status === 503
                ? 'Код отправить нечем: почта на сервере не настроена'
                : error.response?.data?.detail || 'Не удалось отправить код',
          }
        }
      },

      enableEmailTwoFactor: async (code, password) => {
        try {
          await api.post('/auth/2fa/email/enable', { code, password }, {
            skipErrorToast: true,
            skipAuthRedirect: true,
          })
          await useAuthStore.getState().refreshUser()
          return { success: true }
        } catch (error) {
          return {
            success: false,
            error: error.response?.data?.detail || 'Не удалось включить вход по коду из почты',
          }
        }
      },

      disableEmailTwoFactor: async (password) => {
        try {
          await api.post('/auth/2fa/email/disable', { password }, {
            skipErrorToast: true,
            skipAuthRedirect: true,
          })
          await useAuthStore.getState().refreshUser()
          return { success: true }
        } catch (error) {
          return {
            success: false,
            error: error.response?.data?.detail || 'Не удалось выключить вход по коду из почты',
          }
        }
      },

      // --- Доверенные устройства ---
      // Список нужен, чтобы юзер видел, откуда в его аккаунт уже входили, и
      // мог отозвать доверие: следующий вход с отозванного устройства снова
      // потребует код. В сторе не кешируем — экран настроек читает свежий
      // список сам, а держать его в памяти после ухода со страницы незачем.
      fetchTrustedDevices: async () => {
        try {
          const response = await api.get('/auth/devices', {
            dedupe: false,
            skipErrorToast: true,
          })
          return { success: true, devices: response.data || [] }
        } catch (error) {
          return {
            success: false,
            error: error.response?.data?.detail || 'Не удалось загрузить устройства',
          }
        }
      },

      revokeTrustedDevice: async (deviceId) => {
        try {
          await api.delete(`/auth/devices/${deviceId}`, { skipErrorToast: true })
          return { success: true }
        } catch (error) {
          return {
            success: false,
            error: error.response?.data?.detail || 'Не удалось отозвать устройство',
          }
        }
      },

      // Отзывает все устройства, кроме текущего: бэк оставляет то, с которого
      // пришёл запрос, — иначе кнопка выкидывала бы юзера из своего браузера.
      revokeOtherDevices: async () => {
        try {
          const response = await api.post('/auth/devices/revoke-all', null, {
            skipErrorToast: true,
          })
          return { success: true, revoked: response.data?.revoked || 0 }
        } catch (error) {
          return {
            success: false,
            error: error.response?.data?.detail || 'Не удалось отозвать устройства',
          }
        }
      },

      refreshUser: async () => {
        try {
          const response = await api.get('/auth/me', { dedupe: false })
          set({ user: response.data })
          setStoredAuth({ token: get().token, user: response.data })
        } catch {
          // Профиль подтянется при следующем checkAuth — не рушим текущий экран.
        }
      },

      updatePreferences: async (preferredGenres, preferredArtists, excludedArtists) => {
        try {
          const response = await api.put('/users/me/preferences', {
            preferred_genres: preferredGenres || [],
            preferred_artists: preferredArtists || [],
            excluded_artists: excludedArtists || [],
          })
          const newUser = response.data
          set({ user: newUser })
          const token = get().token
          setStoredAuth({ token, user: newUser })
          invalidateFlowPreload()
          return { success: true }
        } catch (error) {
          return {
            success: false,
            error: error.response?.data?.detail || 'Не удалось сохранить предпочтения',
          }
        }
      },

      logout: () => {
        setApiAuthToken(null)
        set({
          user: null,
          token: null,
          isAuthenticated: false,
        })
        setStoredAuth(null)
        // Выдача поиска переживает размонтирование страницы, поэтому её надо
        // гасить явно — иначе следующий вход открывает чужой запрос.
        useSearchStore.getState().resetSearch()
      },
      
      checkAuth: async () => {
        const stored = getStoredAuth()
        if (stored && stored.token) {
          try {
            setApiAuthToken(stored.token)
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
  window.addEventListener('auth:unauthorized', () => {
    useAuthStore.setState({
      user: null,
      token: null,
      isAuthenticated: false,
    })
  })

  // Load initial state from storage
  const stored = getStoredAuth()
  if (stored) {
    useAuthStore.setState({
      token: stored.token,
      user: stored.user,
      isAuthenticated: !!stored.token,
    })
    if (stored.token) {
      setApiAuthToken(stored.token)
      // Verify token is still valid
      useAuthStore.getState().checkAuth()
    }
  }
}

export { useAuthStore }
