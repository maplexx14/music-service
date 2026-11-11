package lat.boltmusic.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import kotlin.math.roundToInt

/**
 * Оболочка над мобильной версией сайта: тот же интерфейс и те же функции,
 * плюс то, чего нет у вкладки браузера — фоновое воспроизведение, системный
 * плеер, «Поделиться», загрузка файлов.
 */
class MainActivity : ComponentActivity() {

    private lateinit var root: FrameLayout
    private lateinit var webView: WebView
    private lateinit var offlineView: View
    private var fullscreenView: View? = null
    private var fullscreenCallback: WebChromeClient.CustomViewCallback? = null
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var bridgeScript: String = ""
    private var injectedAtDocumentStart = false
    private var askedNotifications = false
    private var notificationPermissionPending = false
    private var safeTopCss = 0
    private val updater by lazy { Updater(this) }
    private val backgroundPlayback by lazy { BackgroundPlayback(this) }

    private val startOrigin: Uri = Uri.parse(BuildConfig.START_URL)

    // Сеть вернулась (метро, смена Wi-Fi) — экран ошибки перезагружается сам.
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            runOnUiThread {
                if (!isDestroyed && offlineView.visibility == View.VISIBLE) webView.reload()
            }
        }
    }

    private val fileChooser =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val uris = WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
            fileCallback?.onReceiveValue(if (result.resultCode == Activity.RESULT_OK) uris else null)
            fileCallback = null
        }

    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) {
            notificationPermissionPending = false
            offerBackgroundPlayback()
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Страница растянута под статус-бар, как PWA на iPhone с black-translucent:
        // под часами виден сам экран, а не сплошная полоса.
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = BG
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = false
        }

        bridgeScript = assets.open("bridge.js").bufferedReader().use { it.readText() }

        root = FrameLayout(this).apply { setBackgroundColor(BG) }
        webView = createWebView()
        offlineView = createOfflineView()
        root.addView(webView, matchParent())
        root.addView(offlineView, matchParent())
        // Сверху отступа нет — его высота уходит в CSS (--safe-top): env() в
        // WebView часто отдаёт 0. Снизу отступ под навигацию и клавиатуру:
        // без decorFitsSystemWindows окно само под клавиатуру не ужимается.
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
            )
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, 0, bars.right, maxOf(bars.bottom, ime.bottom))
            val top = (bars.top / resources.displayMetrics.density).roundToInt()
            if (top != safeTopCss) {
                safeTopCss = top
                pushSafeTop()
            }
            WindowInsetsCompat.CONSUMED
        }
        setContentView(root)

        PlayerHub.actionSink = { action, seekTime -> runMediaAction(action, seekTime) }
        getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(networkCallback)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (fullscreenView != null) {
                    fullscreenCallback?.onCustomViewHidden()
                    return
                }
                handlePageBack()
            }
        })

        if (savedInstanceState == null) {
            suggestWebViewUpdate()
            updater.checkOnStart()
        }

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState)
        }
        if (webView.url == null) {
            webView.loadUrl(urlFromIntent(intent) ?: BuildConfig.START_URL)
        }
    }

    /** Сначала закрыть окна SPA; canGoBack() WebView не знает о плеере. */
    private fun handlePageBack() {
        val url = webView.url?.let { Uri.parse(it) }
        if (url == null || !isOwnUrl(url) || offlineView.visibility == View.VISIBLE) {
            fallbackBack()
            return
        }
        webView.evaluateJavascript(
            "typeof window.__boltHandleBack === 'function' ? window.__boltHandleBack() : null",
        ) { handled ->
            if (isDestroyed || isFinishing) return@evaluateJavascript
            when (handled) {
                "true" -> Unit
                // Страница явно сообщила: главная, история пуста, окон нет.
                "false" -> moveTaskToBack(true)
                // Старый фронт или ещё загружающаяся страница.
                else -> fallbackBack()
            }
        }
    }

    private fun fallbackBack() {
        if (webView.canGoBack()) webView.goBack()
        else moveTaskToBack(true)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        urlFromIntent(intent)?.let { openInPage(it) }
    }

    /**
     * Ссылка, «Поделиться» или ярлык при уже открытой странице: переход внутри
     * SPA, без перезагрузки — иначе оборвалась бы музыка.
     */
    private fun openInPage(url: String) {
        val current = webView.url?.let { Uri.parse(it) }
        if (current == null || !isOwnUrl(current) || offlineView.visibility == View.VISIBLE) {
            webView.loadUrl(url)
            return
        }
        val target = Uri.parse(url)
        val path = target.encodedPath.orEmpty().ifEmpty { "/" } +
            (target.encodedQuery?.let { "?$it" } ?: "")
        val js = "window.__boltNavigate ? (window.__boltNavigate(${JSONObject.quote(path)}), true) : false"
        webView.evaluateJavascript(js) { handled ->
            if (handled != "true") webView.loadUrl(url)
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    // WebView.onPause()/pauseTimers() намеренно не вызываются: они ставят
    // на паузу и звук, а плеер должен играть со свёрнутым приложением.
    override fun onResume() {
        super.onResume()
        updater.onResume()
    }

    override fun onStop() {
        super.onStop()
        CookieManager.getInstance().flush()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        // В том числе после закрытия запроса уведомлений: не ставим два
        // системных запроса поверх друг друга и не открываем их из фона.
        if (hasFocus) offerBackgroundPlayback()
    }

    private fun offerBackgroundPlayback() {
        if (!notificationPermissionPending) backgroundPlayback.offerIfNeeded()
    }

    override fun onDestroy() {
        getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(networkCallback)
        if (PlayerHub.actionSink != null) PlayerHub.actionSink = null
        if (isFinishing) {
            // Вместе со страницей умирает и звук — системный плеер тоже убираем.
            PlayerHub.reset()
            stopService(Intent(this, PlaybackService::class.java))
        }
        root.removeView(webView)
        webView.destroy()
        super.onDestroy()
    }

    /** Высота статус-бара для страницы: CSS берёт её вместо env(safe-area-inset-top). */
    private fun pushSafeTop() {
        val url = webView.url ?: return
        if (!isOwnUrl(Uri.parse(url))) return
        webView.evaluateJavascript(
            "document.documentElement.style.setProperty('--safe-top','${safeTopCss}px')",
            null,
        )
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView(): WebView {
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        val view = WebView(this)
        view.setBackgroundColor(BG)
        view.overScrollMode = View.OVER_SCROLL_NEVER
        view.isVerticalScrollBarEnabled = false
        view.isHorizontalScrollBarEnabled = false

        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            loadWithOverviewMode = true
            useWideViewPort = true
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            allowFileAccess = false
            allowContentAccess = true
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            cacheMode = WebSettings.LOAD_DEFAULT
            textZoom = 100
            userAgentString = "$userAgentString BoltAndroid/${BuildConfig.VERSION_NAME}"
        }
        // У сайта своя тёмная тема — принудительное затемнение WebView её портит.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
            WebSettingsCompat.setAlgorithmicDarkeningAllowed(view.settings, false)
        }

        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(view, true)
        }

        installBridge(view)
        view.webViewClient = Client()
        view.webChromeClient = ChromeClient()
        view.setDownloadListener { url, _, _, _, _ -> openExternal(Uri.parse(url)) }
        return view
    }

    /** JS-мост ограничен своим доменом: чужие страницы его не увидят. */
    @SuppressLint("JavascriptInterface")
    private fun installBridge(view: WebView) {
        val origin = "${startOrigin.scheme}://${startOrigin.host}"
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(view, "BoltAndroid", setOf(origin)) { _, message, _, _, _ ->
                message.data?.let { handleBridgeMessage(it) }
            }
        } else {
            view.addJavascriptInterface(LegacyBridge(), "BoltAndroid")
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(view, bridgeScript, setOf(origin))
            injectedAtDocumentStart = true
        }
    }

    private inner class LegacyBridge {
        @JavascriptInterface
        fun postMessage(data: String) {
            runOnUiThread { handleBridgeMessage(data) }
        }
    }

    private fun handleBridgeMessage(data: String) {
        val message = try {
            JSONObject(data)
        } catch (e: Exception) {
            return
        }
        when (message.optString("t")) {
            "meta" -> {
                val value = message.optJSONObject("v")
                PlayerHub.setMetadata(
                    value?.let {
                        PlayerHub.Metadata(
                            title = it.optString("title"),
                            artist = it.optString("artist"),
                            album = it.optString("album"),
                            artworkUrl = it.optString("artwork"),
                        )
                    },
                )
                syncPlaybackService()
            }
            "state" -> {
                PlayerHub.setPlaybackState(message.optString("v", "none"))
                syncPlaybackService()
                offerBackgroundPlayback()
            }
            "requested" -> {
                PlayerHub.setPlaybackRequested(message.optBoolean("v"))
                syncPlaybackService()
                offerBackgroundPlayback()
            }
            "pos" -> PlayerHub.setPosition(
                message.optDouble("d", 0.0),
                message.optDouble("p", 0.0),
                message.optDouble("r", 1.0),
            )
            "actions" -> {
                val list = message.optJSONArray("v")
                val set = buildSet { if (list != null) for (i in 0 until list.length()) add(list.optString(i)) }
                PlayerHub.setActions(set)
            }
            "feedback" -> PlayerHub.setFeedback(
                message.optBoolean("liked"),
                message.optBoolean("disliked"),
            )
            "background-settings" -> if (hasWindowFocus()) backgroundPlayback.openSettings()
            "share" -> share(
                message.optString("title"),
                message.optString("text"),
                message.optString("url"),
            )
        }
    }

    private fun syncPlaybackService() {
        if (!PlayerHub.isPlaybackRequested || PlayerHub.metadata == null || PlaybackService.isRunning) return
        askNotificationPermission()
        try {
            ContextCompat.startForegroundService(this, Intent(this, PlaybackService::class.java))
        } catch (e: Exception) {
            Log.w(TAG, "playback service start refused", e)
        }
    }

    /**
     * Сайт рисуется движком Android System WebView, а не Chrome. На старых
     * телефонах он часто не обновлялся годами, и без color-mix/oklch (111+)
     * пропадают фоны и цвета. Подсказываем обновить — раз в версию WebView.
     */
    private fun suggestWebViewUpdate() {
        val pkg = WebViewCompat.getCurrentWebViewPackage(this) ?: return
        val major = pkg.versionName?.substringBefore('.')?.toIntOrNull() ?: return
        if (major >= MIN_WEBVIEW_MAJOR) return
        val prefs = getSharedPreferences("bolt", MODE_PRIVATE)
        if (prefs.getString("webview_prompted", null) == pkg.versionName) return
        prefs.edit().putString("webview_prompted", pkg.versionName).apply()
        AlertDialog.Builder(this)
            .setTitle("Обновите движок страниц")
            .setMessage(
                "На телефоне устаревший Android System WebView (${pkg.versionName}). " +
                    "Из-за него часть оформления bolt может отображаться неправильно.",
            )
            .setPositiveButton("Обновить") { _, _ ->
                val market = Uri.parse("market://details?id=${pkg.packageName}")
                val web = Uri.parse("https://play.google.com/store/apps/details?id=${pkg.packageName}")
                try {
                    startActivity(Intent(Intent.ACTION_VIEW, market))
                } catch (e: ActivityNotFoundException) {
                    openExternal(web)
                }
            }
            .setNegativeButton("Позже", null)
            .show()
    }

    private fun askNotificationPermission() {
        if (askedNotifications || Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        askedNotifications = true
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermissionPending = true
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    private fun runMediaAction(action: String, seekTime: Double?) {
        val arg = seekTime?.toString() ?: "undefined"
        val js = "window.__boltMediaAction && window.__boltMediaAction(${JSONObject.quote(action)}, $arg)"
        webView.evaluateJavascript(js) { handled ->
            // Если у страницы нет обработчика play/pause — жмём сами элементам.
            if (handled != "true" && (action == "play" || action == "pause")) {
                webView.evaluateJavascript(
                    "document.querySelectorAll('audio,video').forEach(function(m){m.$action()})",
                    null,
                )
            }
        }
    }

    private fun share(title: String, text: String, url: String) {
        val body = listOf(text, url).filter { it.isNotBlank() }.joinToString("\n")
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, body)
            if (title.isNotBlank()) putExtra(Intent.EXTRA_SUBJECT, title)
        }
        startActivity(Intent.createChooser(intent, title.ifBlank { null }))
    }

    private fun isOwnUrl(uri: Uri): Boolean =
        uri.scheme == "https" && uri.host.equals(startOrigin.host, ignoreCase = true)

    private fun urlFromIntent(intent: Intent?): String? {
        if (intent?.action == Intent.ACTION_SEND) return sharedTextUrl(intent)
        val data = intent?.data ?: return null
        // Ссылка на сам APK: приложение уже стоит, качать нечего. Грузить её в
        // WebView нельзя — загрузка ушла бы в браузер и по App Link вернулась сюда.
        if (data.path.orEmpty().endsWith(".apk")) return null
        return if (isOwnUrl(data)) data.toString() else null
    }

    /**
     * «Поделиться» → bolt: ссылку из Spotify, Deezer, Яндекса открывает поиск
     * (он узнаёт ссылки и ведёт на /link), остальной текст становится запросом.
     */
    private fun sharedTextUrl(intent: Intent): String? {
        val text = intent.getStringExtra(Intent.EXTRA_TEXT)?.trim().orEmpty()
        if (text.isEmpty()) return null
        val link = Regex("https?://\\S+").find(text)?.value
        // Ссылку на сам сайт открываем как есть.
        if (link != null && isOwnUrl(Uri.parse(link))) return link
        return startOrigin.buildUpon()
            .path("/search")
            .clearQuery()
            .appendQueryParameter("q", link ?: text.take(200))
            .build()
            .toString()
    }

    private fun openExternal(uri: Uri) {
        try {
            val intent = if (uri.scheme == "intent") {
                Intent.parseUri(uri.toString(), Intent.URI_INTENT_SCHEME).apply {
                    addCategory(Intent.CATEGORY_BROWSABLE)
                    component = null
                    selector = null
                }
            } else {
                Intent(Intent.ACTION_VIEW, uri)
            }
            startActivity(intent)
        } catch (e: ActivityNotFoundException) {
            Log.w(TAG, "no app for $uri")
        } catch (e: Exception) {
            Log.w(TAG, "cannot open $uri", e)
        }
    }

    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val uri = request.url
            if (isOwnUrl(uri)) return false
            if (uri.scheme == "about" || uri.scheme == "blob" || uri.scheme == "data") return false
            openExternal(uri)
            return true
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
            if (!injectedAtDocumentStart && url != null && isOwnUrl(Uri.parse(url))) {
                view.evaluateJavascript(bridgeScript, null)
            }
        }

        override fun onPageCommitVisible(view: WebView, url: String?) {
            pushSafeTop()
        }

        override fun onPageFinished(view: WebView, url: String?) {
            pushSafeTop()
            if (offlineView.visibility == View.VISIBLE && !pageFailed) {
                offlineView.visibility = View.GONE
            }
            pageFailed = false
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (!request.isForMainFrame) return
            pageFailed = true
            offlineView.visibility = View.VISIBLE
        }

        @androidx.annotation.RequiresApi(Build.VERSION_CODES.O)
        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            // Рендер WebView упал или убит системой — пересоздаём экран, иначе
            // приложение упадёт следом.
            Log.w(TAG, "render process gone, crashed=${detail.didCrash()}")
            PlayerHub.reset()
            recreate()
            return true
        }
    }

    private var pageFailed = false

    private inner class ChromeClient : WebChromeClient() {
        override fun onShowFileChooser(
            webView: WebView,
            filePathCallback: ValueCallback<Array<Uri>>,
            fileChooserParams: FileChooserParams,
        ): Boolean {
            fileCallback?.onReceiveValue(null)
            fileCallback = filePathCallback
            return try {
                fileChooser.launch(fileChooserParams.createIntent())
                true
            } catch (e: ActivityNotFoundException) {
                fileCallback = null
                false
            }
        }

        override fun onShowCustomView(view: View, callback: CustomViewCallback) {
            fullscreenView?.let { root.removeView(it) }
            fullscreenView = view
            fullscreenCallback = callback
            root.addView(view, matchParent())
            WindowCompat.getInsetsController(window, window.decorView).apply {
                systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                hide(WindowInsetsCompat.Type.systemBars())
            }
        }

        override fun onHideCustomView() {
            fullscreenView?.let { root.removeView(it) }
            fullscreenView = null
            fullscreenCallback = null
            WindowCompat.getInsetsController(window, window.decorView)
                .show(WindowInsetsCompat.Type.systemBars())
        }
    }

    private fun createOfflineView(): View {
        val density = resources.displayMetrics.density
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(BG)
            visibility = View.GONE
            isClickable = true
            addView(TextView(context).apply {
                text = getString(R.string.offline_title)
                setTextColor(Color.WHITE)
                textSize = 17f
                gravity = Gravity.CENTER
            })
            addView(
                Button(context).apply {
                    text = getString(R.string.offline_retry)
                    isAllCaps = false
                    setOnClickListener { webView.reload() }
                },
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                ).apply { topMargin = (16 * density).toInt() },
            )
        }
    }

    private fun matchParent() = FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT,
    )

    companion object {
        private const val TAG = "Bolt"
        private const val MIN_WEBVIEW_MAJOR = 111
        private val BG = Color.parseColor("#050505")
    }
}
