package lat.boltmusic.app

import android.app.Notification
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import android.view.View
import android.widget.FrameLayout
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
import org.robolectric.util.ReflectionHelpers
import org.robolectric.util.ReflectionHelpers.ClassParameter

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
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
        val session = ReflectionHelpers.getField<MediaSessionCompat>(service, "session")
        // Robolectric не реализует Binder-команды MediaController. Вызываем
        // callback, который сервис действительно зарегистрировал в сессии.
        val implementation = ReflectionHelpers.getField<Any>(session, "mImpl")
        val callback = ReflectionHelpers.getField<MediaSessionCompat.Callback>(implementation, "mCallback")
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
}
