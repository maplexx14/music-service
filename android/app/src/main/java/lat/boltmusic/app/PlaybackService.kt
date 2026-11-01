package lat.boltmusic.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.AudioManager
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import android.util.Log
import android.view.View
import android.widget.RemoteViews
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.media.app.NotificationCompat.MediaStyle
import androidx.media.session.MediaButtonReceiver
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale
import java.util.concurrent.Executors

/**
 * Системный плеер для звука из WebView: уведомление, экран блокировки,
 * гарнитура. Пока играет — foreground service, иначе Android усыпит процесс
 * вместе с WebView и музыка оборвётся при выключенном экране.
 */
class PlaybackService : Service() {

    private lateinit var session: MediaSessionCompat
    private val mainHandler = Handler(Looper.getMainLooper())
    private val artworkExecutor = Executors.newSingleThreadExecutor()
    private var artworkUrl: String? = null
    private var artwork: Bitmap? = null
    private var isForeground = false
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    private val listener: () -> Unit = { render() }

    override fun onCreate() {
        super.onCreate()
        createChannel()
        session = MediaSessionCompat(this, "bolt").apply {
            setSessionActivity(openAppIntent())
            setPlaybackToLocal(AudioManager.STREAM_MUSIC)
            // Android 13+ и прошивки OEM строят кнопки из сессии. Резервируем
            // места previous/next, чтобы их не занимали лайк или дизлайк.
            setExtras(Bundle().apply {
                putBoolean("android.media.playback.ALWAYS_RESERVE_SPACE_FOR.ACTION_SKIP_TO_PREVIOUS", true)
                putBoolean("android.media.playback.ALWAYS_RESERVE_SPACE_FOR.ACTION_SKIP_TO_NEXT", true)
            })
            setCallback(object : MediaSessionCompat.Callback() {
                override fun onPlay() = PlayerHub.dispatch("play")
                override fun onPause() = PlayerHub.dispatch("pause")
                override fun onSkipToNext() = PlayerHub.dispatch("nexttrack")
                override fun onSkipToPrevious() = PlayerHub.dispatch("previoustrack")
                // Старые прошивки могут прислать rewind/fast-forward даже
                // для стрелок перехода между песнями.
                override fun onFastForward() = PlayerHub.dispatch("nexttrack")
                override fun onRewind() = PlayerHub.dispatch("previoustrack")
                override fun onStop() {
                    // Смахнули уведомление на паузе: убираем плеер до следующего play.
                    PlayerHub.dispatch("pause")
                    stopSelf()
                }
                override fun onSeekTo(pos: Long) = PlayerHub.dispatch("seekto", pos / 1000.0)
                override fun onCustomAction(action: String, extras: Bundle?) = PlayerHub.dispatch(action)
            })
            isActive = true
        }
        PlayerHub.addListener(listener)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Кнопки уведомления запускают foreground service напрямую;
        // startForeground обязателен сразу, иначе система уронит процесс.
        goForeground()
        // Явные команды обходят преобразование кнопок уведомления в media-key
        // события прошивкой. Гарнитура и системная сессия остаются на callbacks.
        when (intent?.action) {
            ACTION_PREVIOUS -> PlayerHub.dispatch("previoustrack")
            ACTION_NEXT -> PlayerHub.dispatch("nexttrack")
            ACTION_TOGGLE -> PlayerHub.dispatch(if (PlayerHub.isPlaying) "pause" else "play")
            ACTION_STOP -> {
                PlayerHub.dispatch("pause")
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_LIKE, ACTION_DISLIKE -> PlayerHub.dispatch(intent.action!!)
            else -> MediaButtonReceiver.handleIntent(session, intent)
        }
        render()
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onTaskRemoved(rootIntent: Intent?) {
        stopSelf()
    }

    override fun onDestroy() {
        PlayerHub.removeListener(listener)
        releaseLocks()
        session.isActive = false
        session.release()
        artworkExecutor.shutdownNow()
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        NotificationManagerCompat.from(this).cancel(NOTIFICATION_ID)
        super.onDestroy()
    }

    private fun render() {
        val meta = PlayerHub.metadata
        if (meta == null || PlayerHub.playbackState == "none") {
            stopSelf()
            return
        }
        loadArtwork(meta.artworkUrl)
        session.setMetadata(buildMetadata(meta))
        session.setPlaybackState(buildPlaybackState())

        val notification = buildNotification(meta)
        if (PlayerHub.isPlaying) {
            acquireLocks()
            goForeground(notification)
        } else {
            releaseLocks()
            if (isForeground) {
                // На паузе уведомление остаётся, но его можно смахнуть.
                ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_DETACH)
                isForeground = false
            }
            notify(notification)
        }
    }

    private fun goForeground(notification: Notification = buildNotification(PlayerHub.metadata)) {
        try {
            ServiceCompat.startForeground(
                this,
                NOTIFICATION_ID,
                notification,
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
                } else {
                    0
                },
            )
            isForeground = true
        } catch (e: Exception) {
            // Android 12+ не даёт поднять foreground из фона без жеста
            // пользователя — показываем хотя бы обычное уведомление.
            Log.w(TAG, "startForeground refused", e)
            notify(notification)
        }
    }

    private fun notify(notification: Notification) {
        try {
            NotificationManagerCompat.from(this).notify(NOTIFICATION_ID, notification)
        } catch (e: SecurityException) {
            // Нет разрешения на уведомления — плеер работает и без них.
        }
    }

    private fun buildMetadata(meta: PlayerHub.Metadata): MediaMetadataCompat {
        val builder = MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, meta.title)
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, meta.artist)
            .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, meta.album)
            .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_TITLE, meta.title)
            .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_SUBTITLE, meta.artist)
            .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_DESCRIPTION, meta.album)
        if (meta.artworkUrl.isNotBlank()) {
            builder.putString(MediaMetadataCompat.METADATA_KEY_ALBUM_ART_URI, meta.artworkUrl)
                .putString(MediaMetadataCompat.METADATA_KEY_ART_URI, meta.artworkUrl)
                .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_ICON_URI, meta.artworkUrl)
        }
        if (PlayerHub.duration > 0) {
            builder.putLong(MediaMetadataCompat.METADATA_KEY_DURATION, (PlayerHub.duration * 1000).toLong())
        }
        artwork?.let {
            builder.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, it)
                .putBitmap(MediaMetadataCompat.METADATA_KEY_ART, it)
                .putBitmap(MediaMetadataCompat.METADATA_KEY_DISPLAY_ICON, it)
        }
        return builder.build()
    }

    private fun buildPlaybackState(): PlaybackStateCompat {
        val actions = PlayerHub.actions
        var mask = PlaybackStateCompat.ACTION_PLAY or
            PlaybackStateCompat.ACTION_PAUSE or
            PlaybackStateCompat.ACTION_PLAY_PAUSE
        if ("nexttrack" in actions) mask = mask or PlaybackStateCompat.ACTION_SKIP_TO_NEXT
        if ("previoustrack" in actions) mask = mask or PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
        if ("seekto" in actions) mask = mask or PlaybackStateCompat.ACTION_SEEK_TO
        // Перемотка остаётся на ползунке (SEEK_TO). FAST_FORWARD/REWIND
        // заставляют некоторые системные виджеты подменять previous/next.

        val state = when (PlayerHub.playbackState) {
            "playing" -> PlaybackStateCompat.STATE_PLAYING
            "paused" -> PlaybackStateCompat.STATE_PAUSED
            else -> PlaybackStateCompat.STATE_NONE
        }
        val rate = if (PlayerHub.isPlaying) PlayerHub.rate.toFloat() else 0f
        val builder = PlaybackStateCompat.Builder()
            .setActions(mask)
            .setState(state, (PlayerHub.currentPosition() * 1000).toLong(), rate)
        feedbackButtons().forEach { button ->
            builder.addCustomAction(
                PlaybackStateCompat.CustomAction.Builder(button.action, button.label, button.icon).build(),
            )
        }
        return builder.build()
    }

    private class FeedbackButton(val action: String, val label: String, val icon: Int)

    /** Дизлайк и лайк — если страница их обрабатывает (handlers bolt-*). */
    private fun feedbackButtons(): List<FeedbackButton> = buildList {
        if (ACTION_DISLIKE in PlayerHub.actions) {
            add(
                if (PlayerHub.disliked) {
                    FeedbackButton(ACTION_DISLIKE, "Убрать дизлайк", R.drawable.ic_action_disliked)
                } else {
                    FeedbackButton(ACTION_DISLIKE, "Не нравится", R.drawable.ic_action_dislike)
                },
            )
        }
        if (ACTION_LIKE in PlayerHub.actions) {
            add(
                if (PlayerHub.liked) {
                    FeedbackButton(ACTION_LIKE, "Убрать из понравившихся", R.drawable.ic_action_liked)
                } else {
                    FeedbackButton(ACTION_LIKE, "Нравится", R.drawable.ic_action_like)
                },
            )
        }
    }

    private fun buildNotification(meta: PlayerHub.Metadata?): Notification {
        val playing = PlayerHub.isPlaying
        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_bolt)
            .setContentTitle(meta?.title ?: getString(R.string.app_name))
            .setContentText(meta?.artist ?: "")
            .setSubText(meta?.album?.takeIf { it.isNotBlank() })
            .setLargeIcon(artwork)
            .setContentIntent(openAppIntent())
            .setDeleteIntent(
                servicePendingIntent(ACTION_STOP),
            )
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setShowWhen(false)
            .setOngoing(playing)
            .setColor(getColor(R.color.notification_background))
            .setColorized(true)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            // Собственная компоновка использует всю выделенную уведомлению
            // ширину; MediaStyle сохраняет системный плеер и его сессию.
            .setCustomContentView(buildNotificationView(meta, expanded = false))
            .setCustomBigContentView(buildNotificationView(meta, expanded = true))

        val compact = mutableListOf<Int>()
        var index = 0
        if ("previoustrack" in PlayerHub.actions) {
            builder.addAction(
                R.drawable.ic_action_previous,
                "Предыдущий",
                servicePendingIntent(ACTION_PREVIOUS),
            )
            compact += index++
        }
        builder.addAction(
            if (playing) R.drawable.ic_action_pause else R.drawable.ic_action_play,
            if (playing) "Пауза" else "Играть",
            servicePendingIntent(ACTION_TOGGLE),
        )
        compact += index++
        if ("nexttrack" in PlayerHub.actions) {
            builder.addAction(
                R.drawable.ic_action_next,
                "Следующий",
                servicePendingIntent(ACTION_NEXT),
            )
            compact += index
        }
        feedbackButtons().forEach { button ->
            builder.addAction(button.icon, button.label, servicePendingIntent(button.action))
        }
        builder.setStyle(
            MediaStyle()
                .setMediaSession(session.sessionToken)
                .setShowActionsInCompactView(*compact.toIntArray()),
        )
        return builder.build()
    }

    private fun buildNotificationView(meta: PlayerHub.Metadata?, expanded: Boolean): RemoteViews {
        val layout = if (expanded) R.layout.notification_player_expanded else R.layout.notification_player
        return RemoteViews(packageName, layout).apply {
            setTextViewText(R.id.notification_title, meta?.title ?: getString(R.string.app_name))
            setTextViewText(R.id.notification_artist, meta?.artist ?: "")
            artwork?.let { setImageViewBitmap(R.id.notification_cover, it) }
                ?: setImageViewResource(R.id.notification_cover, R.mipmap.ic_launcher)
            setOnClickPendingIntent(R.id.notification_metadata, openAppIntent())

            bindNotificationButton(this, R.id.notification_previous, ACTION_PREVIOUS, "previoustrack" in PlayerHub.actions)
            bindNotificationButton(this, R.id.notification_next, ACTION_NEXT, "nexttrack" in PlayerHub.actions)
            bindNotificationButton(this, R.id.notification_toggle, ACTION_TOGGLE, enabled = true)
            setImageViewResource(
                R.id.notification_toggle,
                if (PlayerHub.isPlaying) R.drawable.ic_action_pause else R.drawable.ic_action_play,
            )
            setContentDescription(
                R.id.notification_toggle,
                getString(if (PlayerHub.isPlaying) R.string.playback_pause else R.string.playback_play),
            )

            if (expanded) {
                for ((id, action) in listOf(R.id.notification_dislike to ACTION_DISLIKE, R.id.notification_like to ACTION_LIKE)) {
                    val button = feedbackButtons().firstOrNull { it.action == action }
                    setViewVisibility(id, if (button != null) View.VISIBLE else View.INVISIBLE)
                    if (button != null) {
                        setImageViewResource(id, button.icon)
                        setContentDescription(id, button.label)
                        bindNotificationButton(this, id, action, enabled = true)
                    }
                }
                val duration = PlayerHub.duration.takeIf { it.isFinite() && it > 0 } ?: 0.0
                val position = PlayerHub.currentPosition().takeIf { it.isFinite() }?.coerceIn(0.0, duration) ?: 0.0
                val progress = if (duration > 0) (position / duration * 1000).toInt() else 0
                setProgressBar(R.id.notification_progress, 1000, progress, false)
                setViewVisibility(R.id.notification_timeline, if (duration > 0) View.VISIBLE else View.GONE)
                setTextViewText(R.id.notification_position, formatNotificationTime(position))
                setTextViewText(R.id.notification_duration, formatNotificationTime(duration))
            }
        }
    }

    private fun bindNotificationButton(view: RemoteViews, id: Int, action: String, enabled: Boolean) {
        view.setBoolean(id, "setEnabled", enabled)
        view.setFloat(id, "setAlpha", if (enabled) 1f else 0.35f)
        if (enabled) view.setOnClickPendingIntent(id, servicePendingIntent(action))
    }

    private fun formatNotificationTime(time: Double): String {
        val seconds = time.toLong().coerceAtLeast(0)
        return if (seconds >= 3600) {
            String.format(Locale.ROOT, "%d:%02d:%02d", seconds / 3600, seconds / 60 % 60, seconds % 60)
        } else {
            String.format(Locale.ROOT, "%d:%02d", seconds / 60, seconds % 60)
        }
    }

    private fun servicePendingIntent(action: String): PendingIntent {
        val intent = Intent(this, PlaybackService::class.java).setAction(action)
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        // Сервис мог уже остановиться (пауза, смахнули приложение) — поднимаем
        // его как foreground, иначе Android 8+ запрет фонового старта уронит вызов.
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            PendingIntent.getForegroundService(this, action.hashCode(), intent, flags)
        } else {
            PendingIntent.getService(this, action.hashCode(), intent, flags)
        }
    }

    private fun openAppIntent(): PendingIntent {
        val intent = Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        return PendingIntent.getActivity(
            this,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun loadArtwork(url: String) {
        if (url == artworkUrl) return
        artworkUrl = url
        artwork = null
        if (url.isBlank()) return
        artworkExecutor.execute {
            val bitmap = try {
                val connection = URL(url).openConnection() as HttpURLConnection
                connection.connectTimeout = 10_000
                connection.readTimeout = 15_000
                connection.inputStream.use { stream ->
                    BitmapFactory.decodeStream(stream)?.let { scaleDown(it) }
                }
            } catch (e: Exception) {
                Log.w(TAG, "artwork load failed: $url", e)
                null
            }
            mainHandler.post {
                if (artworkUrl == url && bitmap != null) {
                    artwork = bitmap
                    render()
                }
            }
        }
    }

    private fun scaleDown(bitmap: Bitmap): Bitmap {
        val max = 512
        if (bitmap.width <= max && bitmap.height <= max) return bitmap
        val scale = max.toFloat() / maxOf(bitmap.width, bitmap.height)
        return Bitmap.createScaledBitmap(
            bitmap,
            (bitmap.width * scale).toInt(),
            (bitmap.height * scale).toInt(),
            true,
        )
    }

    @Suppress("DEPRECATION")
    private fun acquireLocks() {
        if (wakeLock == null) {
            wakeLock = (getSystemService(Context.POWER_SERVICE) as PowerManager)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "bolt:playback")
                .apply { setReferenceCounted(false) }
        }
        if (wifiLock == null) {
            val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                WifiManager.WIFI_MODE_FULL_LOW_LATENCY
            } else {
                WifiManager.WIFI_MODE_FULL_HIGH_PERF
            }
            wifiLock = (applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager)
                .createWifiLock(mode, "bolt:playback")
                .apply { setReferenceCounted(false) }
        }
        wakeLock?.takeIf { !it.isHeld }?.acquire()
        wifiLock?.takeIf { !it.isHeld }?.acquire()
    }

    private fun releaseLocks() {
        wakeLock?.takeIf { it.isHeld }?.release()
        wifiLock?.takeIf { it.isHeld }?.release()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.channel_playback),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            setShowBadge(false)
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    companion object {
        private const val TAG = "BoltPlayback"
        private const val CHANNEL_ID = "playback"
        private const val NOTIFICATION_ID = 1
        private const val ACTION_PREVIOUS = "lat.boltmusic.app.PREVIOUS"
        private const val ACTION_NEXT = "lat.boltmusic.app.NEXT"
        private const val ACTION_TOGGLE = "lat.boltmusic.app.TOGGLE"
        private const val ACTION_STOP = "lat.boltmusic.app.STOP"
        const val ACTION_LIKE = "bolt-like"
        const val ACTION_DISLIKE = "bolt-dislike"
    }
}
