package lat.boltmusic.app

import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import org.robolectric.shadows.ShadowAlertDialog

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29, 35])
@LooperMode(LooperMode.Mode.PAUSED)
class BackgroundPlaybackTest {
    class TestActivity : Activity() {
        var focused = true
        var rejectedAction: String? = null

        override fun hasWindowFocus(): Boolean = focused

        override fun startActivity(intent: Intent) {
            if (intent.action == rejectedAction) throw ActivityNotFoundException()
            super.startActivity(intent)
        }
    }

    private lateinit var controller: ActivityController<TestActivity>
    private lateinit var activity: TestActivity
    private lateinit var backgroundPlayback: BackgroundPlayback

    @Before
    fun setUp() {
        PlayerHub.reset()
        controller = Robolectric.buildActivity(TestActivity::class.java).setup()
        activity = controller.get()
        activity.getSharedPreferences("bolt", Activity.MODE_PRIVATE).edit().clear().commit()
        backgroundPlayback = BackgroundPlayback(activity)
    }

    @After
    fun tearDown() {
        ShadowAlertDialog.getLatestAlertDialog()?.dismiss()
        controller.pause().stop().destroy()
        PlayerHub.reset()
    }

    private fun clickDialogButton(button: Int) {
        ShadowAlertDialog.getLatestAlertDialog().getButton(button).performClick()
        // AlertDialog отправляет callback и dismiss в очередь главного потока.
        shadowOf(Looper.getMainLooper()).idle()
    }

    @Test
    fun offerWaitsForAudiblePlaybackAndForegroundThenAppearsOnlyOnce() {
        backgroundPlayback.offerIfNeeded()
        assertNull(ShadowAlertDialog.getLatestAlertDialog())
        PlayerHub.setPlaybackRequested(true)
        backgroundPlayback.offerIfNeeded()
        assertNull(ShadowAlertDialog.getLatestAlertDialog())
        PlayerHub.setPlaybackState("playing")
        activity.focused = false
        backgroundPlayback.offerIfNeeded()
        assertNull(ShadowAlertDialog.getLatestAlertDialog())
        activity.focused = true
        backgroundPlayback.offerIfNeeded()
        val dialog = ShadowAlertDialog.getLatestAlertDialog()
        assertNotNull(dialog)
        assertNull(shadowOf(activity).nextStartedActivity)
        clickDialogButton(AlertDialog.BUTTON_NEGATIVE)
        assertFalse(dialog.isShowing)
        assertNull(shadowOf(activity).nextStartedActivity)
        assertTrue(PlayerHub.isPlaybackRequested)
        assertTrue(PlayerHub.isPlaying)
        // Даже новый экземпляр после пересоздания Activity помнит «Позже».
        BackgroundPlayback(activity).offerIfNeeded()
        assertSame(dialog, ShadowAlertDialog.getLatestAlertDialog())
        assertFalse(dialog.isShowing)
    }

    @Test
    fun acceptingTheOfferRequestsExemptionOnlyForThisPackage() {
        PlayerHub.setPlaybackState("playing")
        backgroundPlayback.offerIfNeeded()
        clickDialogButton(AlertDialog.BUTTON_POSITIVE)
        val intent = shadowOf(activity).nextStartedActivity
        assertEquals(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, intent.action)
        assertEquals("package:${activity.packageName}", intent.data.toString())
    }

    @Test
    fun unrestrictedPlaybackNeedsNoOfferAndManualEntryOpensAppSettings() {
        shadowOf(activity.getSystemService(PowerManager::class.java))
            .setIgnoringBatteryOptimizations(activity.packageName, true)
        PlayerHub.setPlaybackState("playing")
        backgroundPlayback.offerIfNeeded()
        assertNull(ShadowAlertDialog.getLatestAlertDialog())
        backgroundPlayback.openSettings()
        assertEquals(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, shadowOf(activity).nextStartedActivity.action)
    }

    @Test
    fun unavailableExemptionDialogFallsBackToAppSettings() {
        activity.rejectedAction = Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS
        backgroundPlayback.openSettings()
        val intent = shadowOf(activity).nextStartedActivity
        assertEquals(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, intent.action)
        assertEquals("package:${activity.packageName}", intent.data.toString())
    }

    @Test
    fun manualEntryCanRequestAgainAfterDecliningTheOffer() {
        PlayerHub.setPlaybackState("playing")
        backgroundPlayback.offerIfNeeded()
        clickDialogButton(AlertDialog.BUTTON_NEGATIVE)
        backgroundPlayback.openSettings()
        assertEquals(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, shadowOf(activity).nextStartedActivity.action)
    }
}
