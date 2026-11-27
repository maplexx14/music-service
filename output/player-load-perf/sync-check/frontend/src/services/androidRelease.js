export const ANDROID_RELEASE_DISMISSED_KEY = 'android-release-dismissed-version'

export function isAndroidReleaseClient(userAgent) {
  // Старым APK тоже нужна веб-подсказка: нативная проверка срабатывает
  // только при холодном запуске и есть не во всех старых оболочках.
  return /Android/i.test(userAgent)
}

export function parseAndroidRelease(value) {
  if (!value || !Number.isSafeInteger(value.versionCode) || value.versionCode <= 0) return null
  if (typeof value.versionName !== 'string' || !value.versionName.trim()) return null
  return {
    versionCode: value.versionCode,
    versionName: value.versionName.trim(),
    notes: typeof value.notes === 'string' ? value.notes.trim() : '',
  }
}

export function isAndroidUpdateAvailable(release, installedVersion) {
  if (!release || !installedVersion) return false
  // Старые оболочки передают в UA только versionName, без versionCode.
  // Сравниваем числовые части: 1.10 новее 1.6, а 1.6.0 равна 1.6.
  const versions = [release.versionName, installedVersion]
  if (!versions.every((version) => /^\d+(?:\.\d+)*$/.test(version))) return false
  const [latest, installed] = versions.map((version) => version.split('.').map(Number))
  for (let i = 0; i < Math.max(latest.length, installed.length); i += 1) {
    const difference = (latest[i] ?? 0) - (installed[i] ?? 0)
    if (difference !== 0) return difference > 0
  }
  return false
}

export function shouldShowAndroidRelease(release, dismissedVersionCode, installedVersion = null) {
  return !!release && release.versionCode > dismissedVersionCode
    && (installedVersion === null || isAndroidUpdateAvailable(release, installedVersion))
}

export function androidDownloadUrl(release, browserOrigin = null) {
  const path = release ? `/bolt.apk?v=${release.versionCode}` : '/bolt.apk'
  if (!browserOrigin) return path
  // Старый DownloadListener запускает ACTION_VIEW: обычную https-ссылку
  // App Link вернёт в bolt. MIME text/html выбирает браузер, поскольку
  // intent-filter оболочки не принимает ссылки с MIME-типом.
  const url = new URL(path, browserOrigin)
  return `intent://${url.host}${url.pathname}${url.search}#Intent;scheme=${url.protocol.slice(0, -1)};type=text/html;end`
}

export function installedAndroidVersion(userAgent) {
  return userAgent.match(/BoltAndroid\/([^\s]+)/i)?.[1] ?? null
}
