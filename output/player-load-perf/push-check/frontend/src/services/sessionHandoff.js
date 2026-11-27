import api from './api'
import { isIOS, isStandalone } from './navigation'

// Сессия из Safari в приложение на экране «Домой» (backend app/session_handoff).
// У установленного веб-приложения на iOS своё хранилище, и после «На экран
// Домой» новичок снова вводил пароль и код из письма. Залогиненный Safari
// берёт одноразовый токен: бэкенд кладёт его в cookie (iOS может скопировать
// её при установке), а мы — в start_url манифеста (iOS берёт его при
// установке). Приложение без сессии при первом запуске меняет токен на вход.

const PARAM = 'handoff'

// Токен из start_url забираем до создания истории роутера и сразу убираем из
// адреса: дальше он не нужен, а в адресной строке и закладках ему не место.
function takeTokenFromUrl() {
  if (typeof window === 'undefined') return null
  try {
    const url = new URL(window.location.href)
    const token = url.searchParams.get(PARAM)
    if (token == null) return null
    url.searchParams.delete(PARAM)
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
    return token || null
  } catch {
    return null
  }
}

const urlToken = takeTokenFromUrl()

// Вход по токену имеет смысл только в установленном приложении без сессии:
// токена в адресе может не быть, а cookie — быть.
export const shouldClaimHandoff = (hasSession) => isStandalone && !hasSession

export async function claimHandoff() {
  const response = await api.post(
    '/auth/handoff/claim',
    { token: urlToken },
    { skipErrorToast: true, skipAuthRedirect: true, timeout: 5000 },
  )
  return response.data?.signed_in ? response.data : null
}

let offered = false

// Safari на iOS, вне приложения, с сессией: готовим токен к установке.
// Раз на загрузку страницы — App монтируется один раз.
export async function offerHandoff() {
  if (offered || !isIOS || isStandalone) return
  offered = true
  try {
    const { data } = await api.post('/auth/handoff', null, { skipErrorToast: true })
    if (data?.token) await pointManifestAt(data.token)
  } catch {
    offered = false
  }
}

// Манифест с start_url, несущим токен. Blob вместо data: — у blob-адреса
// origin страницы, и относительные пути иконок мы сами делаем абсолютными.
async function pointManifestAt(token) {
  const link = document.querySelector('link[rel="manifest"]')
  if (!link) return
  const base = new URL(link.getAttribute('href'), window.location.origin)
  const response = await fetch(base, { cache: 'no-store' })
  if (!response.ok) return
  const manifest = await response.json()
  const absolute = (path) => new URL(path, base).href
  manifest.start_url = absolute(`${manifest.start_url || '/'}?${PARAM}=${encodeURIComponent(token)}`)
  if (manifest.scope) manifest.scope = absolute(manifest.scope)
  // id не трогаем по смыслу, но делаем абсолютным: иначе он считался бы от
  // blob-адреса, и приложение получило бы другую идентичность.
  manifest.id = absolute(manifest.id || '/')
  for (const key of ['icons', 'screenshots', 'shortcuts']) {
    if (!Array.isArray(manifest[key])) continue
    manifest[key] = manifest[key].map((item) => {
      const next = { ...item }
      if (next.src) next.src = absolute(next.src)
      if (next.url) next.url = absolute(next.url)
      if (Array.isArray(next.icons)) next.icons = next.icons.map((icon) => ({ ...icon, src: absolute(icon.src) }))
      return next
    })
  }
  const blob = new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' })
  link.setAttribute('href', URL.createObjectURL(blob))
}
