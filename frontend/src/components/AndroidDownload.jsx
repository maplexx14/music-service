import { Download } from 'lucide-react'
import useAndroidRelease from '../hooks/useAndroidRelease'
import { androidDownloadUrl, installedAndroidVersion, isAndroidUpdateAvailable } from '../services/androidRelease'

export default function AndroidDownload() {
  const release = useAndroidRelease()
  const installed = installedAndroidVersion(navigator.userAgent)
  const native = !!installed || !!window.__boltAndroid
  const updateAvailable = isAndroidUpdateAvailable(release, installed)

  return (
    <div className="settings-card settings-apk">
      <div className="settings-section-title">bolt для Android</div>
      <p className="settings-apk-description">
        {installed ? `Установлена версия ${installed}. ` : 'Музыка в фоне и с выключенным экраном. '}
        {release && `Доступна версия ${release.versionName}.`}
      </p>
      {release?.notes && <p className="settings-apk-description">{release.notes}</p>}
      {(!native || updateAvailable) && (
        <a
          className="btn btn--primary"
          href={androidDownloadUrl(release, native ? window.location.origin : null)}
          download={native ? undefined : 'bolt.apk'}
        >
          <Download size={16} aria-hidden="true" />
          {updateAvailable ? 'Скачать обновление' : 'Скачать APK'}{release ? ` ${release.versionName}` : ''}
        </a>
      )}
      <p className="settings-apk-hint">
        {native && !updateAvailable
          ? 'Новые версии bolt появятся здесь.'
          : 'Откройте скачанный файл и разрешите установку. Обновление установится поверх приложения.'}
      </p>
    </div>
  )
}
