import { Download } from 'lucide-react'
import useAndroidRelease from '../hooks/useAndroidRelease'
import { androidDownloadUrl, installedAndroidVersion } from '../services/androidRelease'

export default function AndroidDownload() {
  const release = useAndroidRelease()
  const installed = installedAndroidVersion(navigator.userAgent)
  const native = !!installed || !!window.__boltAndroid

  return (
    <div className="settings-card settings-apk">
      <div className="settings-section-title">bolt для Android</div>
      <p className="settings-apk-description">
        {installed ? `Установлена версия ${installed}. ` : 'Музыка в фоне и с выключенным экраном. '}
        {release && `Доступна версия ${release.versionName}.`}
      </p>
      {release?.notes && <p className="settings-apk-description">{release.notes}</p>}
      {!native && (
        <a className="btn btn--primary" href={androidDownloadUrl(release)} download="bolt.apk">
          <Download size={16} aria-hidden="true" />
          Скачать APK{release ? ` ${release.versionName}` : ''}
        </a>
      )}
      <p className="settings-apk-hint">
        {native
          ? 'bolt предложит скачать и установить новую версию при запуске.'
          : 'Откройте скачанный файл и разрешите установку. Обновление установится поверх приложения.'}
      </p>
    </div>
  )
}
