package lat.boltmusic.app

import android.app.Notification
import android.app.NotificationManager
import android.net.wifi.WifiManager
import android.os.Looper
import android.os.PowerManager
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.TextView
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ServiceController
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import org.robolectric.util.ReflectionHelpers
import org.robolectric.util.ReflectionHelpers.ClassParameter
import java.time.Duration

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29, 30, 35])
@LooperMode(LooperMode.Mode.PAUSED)
class PlaybackServiceTest {
    private lateinit var controller: ServiceController<PlaybackService>
    private lateinit var service: PlaybackService
    private val commands = mutableListOf<String>()

    @Before
    fun setUp() {
        PlayerHub.reset()
        PlayerHub.setMetadata(PlayerHub.Metadata("Композиция", "Исполнитель", "Альбом", ""))
        PlayerHub.setPlaybackState("playing")
        // Старые страницы могут объявлять перемотку: нативная сессия всё
        // равно должна показывать предыдущую и следующую композиции.
        PlayerHub.setActions(setOf("play", "pause", "previoustrack", "nexttrack", "seekto", "seekforward", "seekbackward"))
        PlayerHub.setPosition(180.0, 45.0, 1.0)
        PlayerHub.actionSink = { action, _ -> commands += action }
        controller = Robolectric.buildService(PlaybackService::class.java).create()
        service = controller.get()
        service.onStartCommand(null, 0, 1)
    }

    @After
    fun tearDown() {
        controller.destroy()
        PlayerHub.actionSink = null
        PlayerHub.reset()
    }

    private fun notification(): Notification = shadowOf(service).lastForegroundNotification

    private fun assertProtection(active: Boolean) {
        assertEquals(active, ReflectionHelpers.getField<Boolean>(service, "isForeground"))
        assertEquals(active, ReflectionHelpers.getField<PowerManager.WakeLock>(service, "wakeLock").isHeld)
        assertEquals(active, ReflectionHelpers.getField<WifiManager.WifiLock>(service, "wifiLock").isHeld)
    }

    private fun playbackState(): PlaybackStateCompat =
        ReflectionHelpers.callInstanceMethod(service, "buildPlaybackState")

    private fun sessionCallback(): MediaSessionCompat.Callback {
        val session = ReflectionHelpers.getField<MediaSessionCompat>(service, "session")
        val implementation = ReflectionHelpers.getField<Any>(session, "mImpl")
        return ReflectionHelpers.getField(implementation, "mCallback")
    }

    @Test
    fun sourceReloadInBackgroundKeepsProtectionAndShowsBuffering() {
        PlayerHub.setPlaybackRequested(true)
        PlayerHub.setPlaybackState("paused")
        PlayerHub.setMetadata(PlayerHub.Metadata("Следующая композиция", "Исполнитель", "Альбом", ""))
        PlayerHub.setPosition(200.0, 0.0, 1.0)

        assertProtection(true)
        assertEquals(PlaybackStateCompat.STATE_BUFFERING, playbackState().state)
        assertEquals(0f, playbackState().playbackSpeed)
        val context = RuntimeEnvironment.getApplication()
        for (remoteViews in listOf(notification().contentView, notification().bigContentView)) {
            val view = remoteViews.apply(context, FrameLayout(context))
            assertEquals(context.getString(R.string.playback_pause), view.findViewById<View>(R.id.notification_toggle).contentDescription)
        }
        val toggle = notification().actions.first { it.title == "Пауза" }
        service.onStartCommand(shadowOf(toggle.actionIntent).savedIntent, 0, 2)
        assertEquals("pause", commands.last())
        assertProtection(false)

        PlayerHub.setPlaybackRequested(true)
        PlayerHub.setPlaybackState("playing")
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMinutes(2))
        assertProtection(true)
        assertEquals(PlaybackStateCompat.STATE_PLAYING, playbackState().state)
    }

    @Test
    fun initialLoadIsProtectedBeforeTheFirstPlayingEvent() {
        PlayerHub.setPlaybackRequested(true)
        PlayerHub.setPlaybackState("none")
        assertProtection(true)
        assertEquals(PlaybackStateCompat.STATE_BUFFERING, playbackState().state)
        assertFalse(shadowOf(service).isStoppedBySelf)
    }

    @Test
    fun explicitPauseReleasesProtectionBeforeTheMediaPauseEventArrives() {
        PlayerHub.setPlaybackRequested(true)
        PlayerHub.setPlaybackRequested(false)
        assertProtection(false)
        PlayerHub.setPlaybackState("paused")
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMinutes(2))
        assertProtection(false)
        assertEquals(PlaybackStateCompat.STATE_PAUSED, playbackState().state)
    }

    @Test
    fun failedLoadTimesOutEvenWhenMetadataAndPositionKeepUpdating() {
        PlayerHub.setPlaybackRequested(true)
        PlayerHub.setPlaybackState("paused")
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(30))
        assertProtection(true)
        PlayerHub.setPosition(200.0, 0.0, 1.0)
        PlayerHub.setMetadata(PlayerHub.metadata!!.copy(title = "Следующая композиция"))
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(31))
        assertProtection(false)
        assertEquals(PlaybackStateCompat.STATE_PAUSED, playbackState().state)

        val updated = shadowOf(service.getSystemService(NotificationManager::class.java)).getNotification(1)
        val toggle = updated.actions.first { it.title == "Играть" }
        service.onStartCommand(shadowOf(toggle.actionIntent).savedIntent, 0, 2)
        assertEquals("play", commands.last())
        assertProtection(true)
        assertEquals(PlaybackStateCompat.STATE_BUFFERING, playbackState().state)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(30))
        assertProtection(true)
        PlayerHub.setPlaybackState("playing")
        assertProtection(true)
    }

    @Test
    fun systemPlayAndPauseUpdateProtectionBeforeTheWebViewResponds() {
        PlayerHub.setPlaybackRequested(false)
        PlayerHub.setPlaybackState("paused")
        sessionCallback().onPlay()
        assertEquals("play", commands.last())
        assertProtection(true)
        assertEquals(PlaybackStateCompat.STATE_BUFFERING, playbackState().state)
        sessionCallback().onPause()
        assertEquals("pause", commands.last())
        assertProtection(false)
    }

    @Test
    fun olderFrontendsStillReleaseProtectionWhenTheirPlaybackStateIsPaused() {
        PlayerHub.setPlaybackState("paused")
        assertProtection(false)
        PlayerHub.setPlaybackState("playing")
        assertProtection(true)
    }

    @Test
    fun destroyedServiceCannotReacquireLocksAfterItsReplacementStarts() {
        PlayerHub.setPlaybackRequested(true)
        PlayerHub.setPlaybackState("paused")
        val previous = service
        controller.destroy()
        controller = Robolectric.buildService(PlaybackService::class.java).create()
        service = controller.get()
        service.onStartCommand(null, 0, 2)
        assertProtection(true)
        // Загрузка обложки может завершиться уже после onDestroy старого сервиса.
        ReflectionHelpers.callInstanceMethod<Unit>(previous, "render")
        assertFalse(ReflectionHelpers.getField<PowerManager.WakeLock>(previous, "wakeLock").isHeld)
        assertFalse(ReflectionHelpers.getField<WifiManager.WifiLock>(previous, "wifiLock").isHeld)
        assertProtection(true)
    }

    @Test
    fun notificationButtonsDispatchPreviousPauseAndNextAsDistinctCommands() {
        val buttons = notification().actions.take(3)
        assertEquals(3, buttons.map { it.actionIntent }.toSet().size)
        buttons.forEachIndexed { index, action ->
            val intent = shadowOf(action.actionIntent).savedIntent
            service.onStartCommand(intent, 0, index + 2)
        }
        assertEquals(listOf("previoustrack", "pause", "nexttrack"), commands)
    }

    @Test
    fun systemSessionAndLegacyArrowsBothSwitchTracks() {
        // Robolectric не реализует Binder-команды MediaController. Вызываем
        // callback, который сервис действительно зарегистрировал в сессии.
        val callback = sessionCallback()
        callback.onSkipToPrevious()
        callback.onSkipToNext()
        callback.onRewind()
        callback.onFastForward()
        assertEquals(listOf("previoustrack", "nexttrack", "previoustrack", "nexttrack"), commands)

        val state = ReflectionHelpers.callInstanceMethod<PlaybackStateCompat>(service, "buildPlaybackState")
        assertTrue(state.actions and PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS != 0L)
        assertTrue(state.actions and PlaybackStateCompat.ACTION_SKIP_TO_NEXT != 0L)
        assertTrue(state.actions and PlaybackStateCompat.ACTION_SEEK_TO != 0L)
        assertEquals(0L, state.actions and PlaybackStateCompat.ACTION_REWIND)
        assertEquals(0L, state.actions and PlaybackStateCompat.ACTION_FAST_FORWARD)
        val artworkUrl = "https://example.invalid/cover.jpg"
        val metadata = ReflectionHelpers.callInstanceMethod<MediaMetadataCompat>(
            service, "buildMetadata", ClassParameter.from(PlayerHub.Metadata::class.java, PlayerHub.metadata!!.copy(artworkUrl = artworkUrl)),
        )
        assertEquals("Композиция", metadata.getString(MediaMetadataCompat.METADATA_KEY_DISPLAY_TITLE))
        assertEquals("Исполнитель", metadata.getString(MediaMetadataCompat.METADATA_KEY_DISPLAY_SUBTITLE))
        assertEquals(180_000L, metadata.getLong(MediaMetadataCompat.METADATA_KEY_DURATION))
        assertEquals(artworkUrl, metadata.getString(MediaMetadataCompat.METADATA_KEY_DISPLAY_ICON_URI))
        assertNotNull(notification().extras.getParcelable<android.os.Parcelable>("android.mediaSession"))
    }

    @Test
    fun bothNotificationLayoutsFillTheAvailableWidthAndKeepArrowOrder() {
        val context = RuntimeEnvironment.getApplication()
        val width = (360 * context.resources.displayMetrics.density).toInt()
        for (remoteViews in listOf(notification().contentView, notification().bigContentView)) {
            assertNotNull(remoteViews)
            val view = remoteViews.apply(context, FrameLayout(context))
            view.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED))
            view.layout(0, 0, view.measuredWidth, view.measuredHeight)
            val previous = view.findViewById<View>(R.id.notification_previous)
            val toggle = view.findViewById<View>(R.id.notification_toggle)
            val next = view.findViewById<View>(R.id.notification_next)
            assertTrue(previous.left < toggle.left)
            assertTrue(toggle.left < next.left)
            assertTrue(next.right <= width)
            assertTrue(view.findViewById<TextView>(R.id.notification_title).width > 0)
            assertEquals("Композиция", view.findViewById<TextView>(R.id.notification_title).text.toString())
            assertEquals(context.getString(R.string.playback_pause), toggle.contentDescription)
            // Проверяем именно клики RemoteViews, которыми пользуется шторка.
            previous.performClick()
            val intent = shadowOf(context).nextStartedService
            service.onStartCommand(intent, 0, 10)
            assertEquals("previoustrack", commands.last())
        }
    }

    @Test
    fun unavailableTrackButtonsAreDisabledAndDimmedInBothLayouts() {
        PlayerHub.setActions(setOf("play", "pause"))
        val context = RuntimeEnvironment.getApplication()
        for (remoteViews in listOf(notification().contentView, notification().bigContentView)) {
            val view = remoteViews.apply(context, FrameLayout(context))
            for (id in listOf(R.id.notification_previous, R.id.notification_next)) {
                val button = view.findViewById<ImageView>(id)
                assertFalse(button.isEnabled)
                assertEquals(89, button.imageAlpha)
            }
            val toggle = view.findViewById<ImageView>(R.id.notification_toggle)
            assertTrue(toggle.isEnabled)
            assertEquals(255, toggle.imageAlpha)
        }
    }
}
