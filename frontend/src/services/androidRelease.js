export const ANDROID_RELEASE_DISMISSED_KEY = 'android-release-dismissed-version'

export function isAndroidReleaseBrowser(userAgent) {
  // В APK обновление предлагает нативный Updater. Android PWA тоже получает
  // уведомление на сайте: standalone не означает, что установлен APK.
  return /Android/i.test(userAgent) && !/BoltAndroid\//i.test(userAgent)
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

export function shouldShowAndroidRelease(release, dismissedVersionCode) {
  return !!release && release.versionCode > dismissedVersionCode
}

export function androidDownloadUrl(release) {
  return release ? `/bolt.apk?v=${release.versionCode}` : '/bolt.apk'
}

export function installedAndroidVersion(userAgent) {
  return userAgent.match(/BoltAndroid\/([^\s]+)/i)?.[1] ?? null
}
