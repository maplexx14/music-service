import { create } from 'zustand'
import api, { setApiAuthToken, setDeviceToken } from '../services/api'
import { useSearchStore } from './searchStore'
import { clearPageCache } from '../services/pageCache'
import { invalidateFlowPreload } from './playerStore'
import { dropLocalPushSubscription } from '../services/push'

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

// Ответы бэкенда о смене почты — по-английски; юзеру показываем по-русски.
// 422 — адрес не прошёл валидацию EmailStr.
const EMAIL_CHANGE_ERRORS = {
  'Incorrect password': 'Неверный пароль',
  'Email already registered': 'Эта почта уже привязана к другому аккаунту',
  'This is already your email': 'Это и есть ваша текущая почта',
  'Invalid or expired code': 'Неверный или просроченный код',
  'Email 2FA temporarily unavailable': 'Не получилось отправить письмо, попробуйте позже',
}

const emailChangeError = (error, fallback) => {
  if (error.response?.status === 422) return 'Проверьте адрес почты'
  const detail = error.response?.data?.detail
  return EMAIL_CHANGE_ERRORS[detail] || (typeof detail === 'string' ? detail : fallback)
}

const TOKEN_RENEW_INTERVAL_MS = 6 * 60 * 60 * 1000
let lastTokenRenewAt = 0

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

          // Вход без кода с нового браузера сразу после подтверждения на этом
          // же IP (PWA на iOS, браузер почтового приложения): бэк запомнил
          // устройство — следующий вход отсюда тоже без кода.
          if (response.data?.device_token) {
            setDeviceToken(response.data.device_token)
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

      requestPasswordReset: async (email) => {
        try {
          const response = await api.post('/auth/forgot-password', { email }, {
            skipErrorToast: true,
            skipAuthRedirect: true,
          })
          return { success: true, message: response.data?.message }
        } catch (error) {
          return {
            success: false,
            error: error.response?.data?.detail || 'Не удалось отправить ссылку',
          }
        }
      },

      resetPassword: async (token, newPassword) => {
        try {
          await api.post('/auth/reset-password', {
            token,
            new_password: newPassword,
          }, { skipErrorToast: true, skipAuthRedirect: true })
          return { success: true }
        } catch (error) {
          return {
            success: false,
            error: error.response?.data?.detail || 'Не удалось изменить пароль',
          }
        }
      },

      verifyEmail: async (token) => {
        try {
          const response = await api.post('/auth/verify-email', { token }, {
            skipErrorToast: true,
            skipAuthRedirect: true,
          })
          // Ссылка из письма подтверждает и этот браузер: следующий вход
          // по паролю с него не должен снова спрашивать код.
          if (response.data?.device_token) {
            setDeviceToken(response.data.device_token)
          }
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

      // Второй шаг входа: код из письма.
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
          const response = await api.post('/auth/register', {
            username,
            email,
            password,
            captcha_token: captchaToken || null,
          })

          // Бэк не пускает до подтверждения почты: форма показывает экран
          // «проверьте письмо» и по claimToken сама входит, когда ссылку
          // откроют в любом браузере (см. claimRegistration).
          return {
            success: true,
            verificationRequired: true,
            claimToken: response.data?.claim_token || null,
          }
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
      
      // Вход вкладки регистрации после перехода по ссылке из письма — даже
      // если ссылка открылась в другом браузере (на iPhone — в браузере
      // почтового приложения). verified: false — почту ещё не подтвердили.
      claimRegistration: async (claimToken) => {
        try {
          const response = await api.post('/auth/register/claim', {
            claim_token: claimToken,
          }, { skipErrorToast: true, skipAuthRedirect: true })
          if (!response.data?.verified) return { success: false, verified: false }
          if (response.data.device_token) {
            setDeviceToken(response.data.device_token)
          }
          const result = await useAuthStore.getState().finalizeLogin(response.data.access_token)
          return { ...result, verified: true }
        } catch {
          return { success: false, verified: false }
        }
      },

      // --- Двухфакторка по почте ---
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

      // --- Смена почты ---
      // Код уходит на НОВЫЙ адрес; почта меняется только после него.
      requestEmailChange: async (newEmail, password) => {
        try {
          const response = await api.post('/auth/email/change', {
            new_email: newEmail,
            password,
          }, { skipErrorToast: true, skipAuthRedirect: true })
          return {
            success: true,
            sent: response.data.sent,
            emailMasked: response.data.email_masked,
            cooldownSeconds: response.data.cooldown_seconds,
          }
        } catch (error) {
          return { success: false, error: emailChangeError(error, 'Не удалось отправить код') }
        }
      },

      confirmEmailChange: async (code) => {
        try {
          const response = await api.post('/auth/email/change/confirm', { code }, {
            skipErrorToast: true,
            skipAuthRedirect: true,
          })
          set({ user: response.data })
          setStoredAuth({ token: get().token, user: response.data })
          return { success: true }
        } catch (error) {
          return { success: false, error: emailChangeError(error, 'Не удалось сменить почту') }
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

      // discoveryRatio (мягкий prior на новые имена, 0..1) необязателен:
      // онбординг ползунок не показывает, а отсутствие поля бэкенд трактует как
      // «не менять» — иначе экран регистрации сбрасывал бы настройку в дефолт.
      updatePreferences: async (
        preferredGenres,
        preferredArtists,
        excludedArtists,
        discoveryRatio,
        flowTuning,
      ) => {
        try {
          const response = await api.put('/users/me/preferences', {
            preferred_genres: preferredGenres || [],
            preferred_artists: preferredArtists || [],
            excluded_artists: excludedArtists || [],
            ...(Number.isFinite(discoveryRatio)
              ? { discovery_ratio: discoveryRatio }
              : {}),
            ...(flowTuning ? { flow_tuning: flowTuning } : {}),
          }, {
            // Бэк сразу считает первую порцию волны — под час юзера.
            params: { hour: new Date().getHours() },
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
        dropLocalPushSubscription()
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
        clearPageCache()
        // Сохранённая очередь плеера (services/playerPersist, ключ
        // PLAYER_PERSIST_KEY) — чужому аккаунту на этом устройстве её не видеть.
        try {
          localStorage.removeItem('bolt-player-v1')
        } catch {
          /* noop */
        }
      },
      
      checkAuth: async () => {
        const stored = getStoredAuth()
        if (stored && stored.token) {
          try {
            setApiAuthToken(stored.token)
            const response = await api.get('/auth/me', { skipErrorToast: true })
            set({
              user: response.data,
              token: stored.token,
              isAuthenticated: true,
            })
            get().renewToken()
          } catch (error) {
            // Выходим только на 401 — токен правда умер (сессию уже сбросил
            // перехватчик в services/api). Сеть, таймаут, 502 на деплое или
            // PWA, открытая без интернета, — не повод: раньше любая такая
            // ошибка на старте стирала сессию, и юзеров «выкидывало».
            if (error.response?.status === 401) get().logout()
          }
        }
      },

      // Меняет живой токен на свежий (POST /auth/refresh) не чаще раза в
      // TOKEN_RENEW_INTERVAL_MS: без этого токен истекал через фиксированный
      // срок после входа. Ошибки молча: старый токен ещё действует, попробуем
      // при следующем вызове.
      renewToken: async () => {
        const token = get().token
        if (!token || Date.now() - lastTokenRenewAt < TOKEN_RENEW_INTERVAL_MS) return
        lastTokenRenewAt = Date.now()
        try {
          const response = await api.post('/auth/refresh', null, { skipErrorToast: true })
          const fresh = response.data?.access_token
          // За время запроса могли выйти или войти под другим аккаунтом.
          if (!fresh || get().token !== token) return
          setApiAuthToken(fresh)
          set({ token: fresh })
        } catch {
          lastTokenRenewAt = 0
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
