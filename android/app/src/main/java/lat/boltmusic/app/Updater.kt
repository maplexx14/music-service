package lat.boltmusic.app

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.widget.ProgressBar
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * Обновление мимо Play Store. Сайт публикует /bolt-version.json
 * ({versionCode, versionName, notes}) рядом с /bolt.apk; если там версия
 * новее установленной — предлагаем скачать и открываем системный установщик.
 * «Позже» откладывает вопрос на сутки.
 */
class Updater(private val activity: Activity) {

    private val main = Handler(Looper.getMainLooper())
    private val executor = Executors.newSingleThreadExecutor()
    private val prefs = activity.getSharedPreferences("bolt", Activity.MODE_PRIVATE)

    /** Скачано, но установщик отказал: не было разрешения на установку. */
    private var waitingForPermission: File? = null

    fun checkOnStart() {
        if (System.currentTimeMillis() - prefs.getLong(PREF_POSTPONED_AT, 0) < POSTPONE_MS) return
        executor.execute {
            val info = try {
                fetchVersion()
            } catch (e: Exception) {
                Log.w(TAG, "version check failed", e)
                null
            } ?: return@execute
            if (info.versionCode <= BuildConfig.VERSION_CODE) return@execute
            main.post { if (!activity.isFinishing) offer(info) }
        }
    }

    private class VersionInfo(val versionCode: Int, val versionName: String, val notes: String)

    private fun fetchVersion(): VersionInfo? {
        val url = URL("${origin()}/bolt-version.json?t=${System.currentTimeMillis()}")
        val connection = url.openConnection() as HttpURLConnection
        connection.connectTimeout = 10_000
        connection.readTimeout = 10_000
        connection.useCaches = false
        try {
            if (connection.responseCode != 200) return null
            val json = JSONObject(connection.inputStream.bufferedReader().use { it.readText() })
            return VersionInfo(
                versionCode = json.optInt("versionCode", 0),
                versionName = json.optString("versionName"),
                notes = json.optString("notes"),
            )
        } finally {
            connection.disconnect()
        }
    }

    private fun offer(info: VersionInfo) {
        val message = buildString {
            append("Доступна версия ${info.versionName}, у вас ${BuildConfig.VERSION_NAME}.")
            if (info.notes.isNotBlank()) append("\n\n").append(info.notes)
        }
        AlertDialog.Builder(activity)
            .setTitle("Обновление bolt")
            .setMessage(message)
            .setPositiveButton("Обновить") { _, _ -> download() }
            .setNegativeButton("Позже") { _, _ ->
                prefs.edit().putLong(PREF_POSTPONED_AT, System.currentTimeMillis()).apply()
            }
            .show()
    }

    private fun download() {
        val bar = ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal).apply {
            isIndeterminate = true
            max = 100
            val pad = (24 * activity.resources.displayMetrics.density).toInt()
            setPadding(pad, pad / 2, pad, 0)
        }
        val dialog = AlertDialog.Builder(activity)
            .setTitle("Скачиваем обновление")
            .setView(bar)
            .setCancelable(false)
            .show()
        executor.execute {
            val file = try {
                fetchApk { percent ->
                    main.post {
                        bar.isIndeterminate = false
                        bar.progress = percent
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "update download failed", e)
                null
            }
            main.post {
                dialog.dismiss()
                if (activity.isFinishing) return@post
                when {
                    file == null -> fail("Не удалось скачать обновление. Проверьте интернет и попробуйте ещё раз.")
                    // Версию на сайте подняли, а APK ещё старый — не гоняем по кругу.
                    archiveVersion(file) <= BuildConfig.VERSION_CODE -> fail("У вас уже последняя версия.")
                    else -> install(file)
                }
            }
        }
    }

    private fun fetchApk(onProgress: (Int) -> Unit): File {
        val dir = File(activity.cacheDir, "update").apply { mkdirs() }
        val target = File(dir, "bolt.apk")
        val connection = URL("${origin()}/bolt.apk").openConnection() as HttpURLConnection
        connection.connectTimeout = 15_000
        connection.readTimeout = 30_000
        connection.useCaches = false
        try {
            if (connection.responseCode != 200) error("HTTP ${connection.responseCode}")
            val total = connection.contentLengthLong
            var done = 0L
            var lastPercent = -1
            connection.inputStream.use { input ->
                target.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        output.write(buffer, 0, read)
                        done += read
                        if (total > 0) {
                            val percent = (done * 100 / total).toInt()
                            if (percent != lastPercent) {
                                lastPercent = percent
                                onProgress(percent)
                            }
                        }
                    }
                }
            }
        } finally {
            connection.disconnect()
        }
        return target
    }

    @Suppress("DEPRECATION")
    private fun archiveVersion(file: File): Long {
        val info = activity.packageManager.getPackageArchiveInfo(file.path, 0) ?: return -1
        if (info.packageName != activity.packageName) return -1
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else info.versionCode.toLong()
    }

    /**
     * Из настроек «Установка неизвестных приложений» установщик сам не
     * продолжает — возвращаемся в приложение. Если разрешение дали, ставим.
     */
    fun onResume() {
        val file = waitingForPermission ?: return
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        if (!activity.packageManager.canRequestPackageInstalls()) return
        waitingForPermission = null
        install(file)
    }

    // Разрешение «Установка из этого источника» система спросит сама: при
    // первом обновлении установщик покажет переход в настройки.
    private fun install(file: File) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            !activity.packageManager.canRequestPackageInstalls()
        ) {
            waitingForPermission = file
        }
        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.files", file)
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            activity.startActivity(intent)
        } catch (e: Exception) {
            Log.w(TAG, "installer not available", e)
            fail("Не удалось открыть установщик.")
        }
    }

    private fun fail(message: String) {
        AlertDialog.Builder(activity)
            .setMessage(message)
            .setPositiveButton("OK", null)
            .show()
    }

    private fun origin() = BuildConfig.START_URL.trimEnd('/')

    companion object {
        private const val TAG = "BoltUpdate"
        private const val PREF_POSTPONED_AT = "update_postponed_at"
        private const val POSTPONE_MS = 24 * 60 * 60 * 1000L
    }
}
