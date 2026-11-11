package lat.boltmusic.app

import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import android.util.Log

/** Foreground service и wake lock сами по себе не исключают приложение из Doze. */
class BackgroundPlayback(private val activity: Activity) {
    private val prefs = activity.getSharedPreferences("bolt", Activity.MODE_PRIVATE)

    private fun isUnrestricted(): Boolean =
        activity.getSystemService(PowerManager::class.java)
            .isIgnoringBatteryOptimizations(activity.packageName)

    /** Предлагаем один раз, только при воспроизведении и видимом окне без другого диалога. */
    fun offerIfNeeded() {
        if (activity.isFinishing || activity.isDestroyed || !activity.hasWindowFocus()) return
        if (!PlayerHub.isPlaying || !PlayerHub.isPlaybackRequested) return
        if (prefs.getBoolean(PREF_OFFERED, false) || isUnrestricted()) return

        prefs.edit().putBoolean(PREF_OFFERED, true).apply()
        AlertDialog.Builder(activity)
            .setTitle("Музыка в фоне")
            .setMessage(
                "Чтобы музыка продолжала играть при выключенном экране, " +
                    "разрешите bolt работать без ограничений батареи. " +
                    "Это может увеличить расход заряда.",
            )
            .setPositiveButton("Настроить") { _, _ -> openSettings() }
            .setNegativeButton("Позже", null)
            .show()
    }

    /** Повторный вход доступен из настроек приложения, в том числе после отказа. */
    fun openSettings() {
        if (activity.isFinishing || activity.isDestroyed) return
        val packageUri = Uri.parse("package:${activity.packageName}")
        if (!isUnrestricted() && launch(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, packageUri))) return
        // На Samsung здесь также доступны ручной режим «Без ограничений» и
        // ограничения прошивки. Уже выданное исключение повторно не запрашиваем.
        if (launch(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, packageUri))) return
        launch(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
    }

    private fun launch(intent: Intent): Boolean = try {
        activity.startActivity(intent)
        true
    } catch (e: ActivityNotFoundException) {
        Log.w("BoltPlayback", "Battery settings unavailable: ${intent.action}", e)
        false
    } catch (e: SecurityException) {
        Log.w("BoltPlayback", "Battery settings refused: ${intent.action}", e)
        false
    }

    companion object {
        private const val PREF_OFFERED = "background_playback_offered"
    }
}
