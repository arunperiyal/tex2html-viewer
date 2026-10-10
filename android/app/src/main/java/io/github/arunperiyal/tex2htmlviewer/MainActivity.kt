package io.github.arunperiyal.tex2htmlviewer

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.ApplicationInfo
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.view.KeyEvent
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.ServiceWorkerClient
import android.webkit.ServiceWorkerController
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.addCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.IntentCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * The viewer's screens are the web app, bundled in the APK (assets/web/) and
 * served under https://appassets.androidplatform.net/. Decks are kept
 * natively (DeckStore: the zip, copied once, read from on request) and served
 * under native/<id>/; the page shows the library and progress through the
 * bridge (window.TexViewer) and gets events on window.t2hvApp. This activity
 * also adds the system file picker, "Open with" and the share menu, immersive
 * full screen in landscape with the screen kept on, Back through the deck's
 * guard, and the volume keys.
 */
class MainActivity : ComponentActivity() {

    private lateinit var web: WebView
    private lateinit var container: FrameLayout
    private lateinit var loader: WebViewAssetLoader

    private var pageReady = false
    private var viewerOpen = false
    private var immersive = false
    private var pendingImport: Uri? = null

    private lateinit var decks: DeckStore
    private val importer = Executors.newSingleThreadExecutor()

    // "Open a pack": the system picker, then the same native import as a zip
    // opened with the app or shared to it
    private val pickZip = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        uri?.let { importUri(it) }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        decks = DeckStore(this)
        if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) {
            WebView.setWebContentsDebuggingEnabled(true)
        }
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.attributes.layoutInDisplayCutoutMode =
            WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES

        loader = WebViewAssetLoader.Builder()
            .setDomain(DOMAIN)
            .addPathHandler("/", AppHandler())
            .build()

        web = WebView(this)
        container = FrameLayout(this).apply {
            addView(web, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                                                ViewGroup.LayoutParams.MATCH_PARENT))
        }
        setContentView(container)
        // keep the library clear of the status and navigation bars (and the cutout)
        ViewCompat.setOnApplyWindowInsetsListener(container) { v, insets ->
            val i = insets.getInsets(WindowInsetsCompat.Type.systemBars() or
                                     WindowInsetsCompat.Type.displayCutout())
            v.setPadding(i.left, i.top, i.right, i.bottom)
            WindowInsetsCompat.CONSUMED
        }

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            mediaPlaybackRequiresUserGesture = false
            setSupportMultipleWindows(true)      // window.open (presenter view) is refused below
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest) =
                serveDeck(request) ?: loader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.host == DOMAIN) return false
                openOutside(request.url)                  // links in a deck: the browser
                return true
            }

            override fun onPageFinished(view: WebView, url: String) {
                pageReady = true
                pendingImport?.let { importUri(it) }
                pendingImport = null
            }
        }
        // the page's service worker fetches the app's files too (sw.js, the cache)
        ServiceWorkerController.getInstance().setServiceWorkerClient(object : ServiceWorkerClient() {
            override fun shouldInterceptRequest(request: WebResourceRequest): WebResourceResponse? =
                serveDeck(request) ?: loader.shouldInterceptRequest(request.url)
        })
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>,
                                           params: FileChooserParams): Boolean {
                callback.onReceiveValue(null)              // the page's input gets nothing
                try {
                    pickZip.launch(arrayOf("application/zip", "application/x-zip-compressed",
                                           "application/octet-stream"))
                } catch (_: ActivityNotFoundException) { }
                return true
            }

            override fun onCreateWindow(view: WebView, dialog: Boolean, userGesture: Boolean,
                                        resultMsg: android.os.Message): Boolean = false
        }
        web.addJavascriptInterface(Bridge(), "TexViewer")

        onBackPressedDispatcher.addCallback(this) {
            // in a deck, the page's guard: the first press warns ("Press back
            // again"), the second closes the deck; in the library, leave
            if (viewerOpen) web.evaluateJavascript("window.t2hvBack && window.t2hvBack()", null)
            else finish()
        }

        if (savedInstanceState == null || web.restoreState(savedInstanceState) == null) {
            web.loadUrl("https://$DOMAIN/")
        }
        handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    /** "Open with" or share: import the zip. */
    private fun handleIntent(intent: Intent?) {
        val uri = when (intent?.action) {
            Intent.ACTION_VIEW -> intent.data
            Intent.ACTION_SEND -> IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)
            else -> null
        } ?: return
        importUri(uri)
        setIntent(Intent())                       // not again after a rotation
    }

    /** Import natively, telling the page (window.t2hvApp) how it goes. */
    private fun importUri(uri: Uri) {
        if (!pageReady) { pendingImport = uri; return }
        val name = displayName(uri) ?: "deck.zip"
        toPage("importStarted", name)
        importer.execute {
            try {
                val deck = decks.import(uri, name) { done, total -> toPage("importProgress", done, total) }
                toPage("importDone", deck)
            } catch (e: Exception) {
                toPage("importFailed", e.message ?: e.javaClass.simpleName)
            }
        }
    }

    /** Call window.t2hvApp.<event>(...args) in the page. */
    private fun toPage(event: String, vararg args: Any) {
        val js = args.joinToString(", ") { a ->
            when (a) {
                is String -> JSONObject.quote(a)
                else -> a.toString()                  // numbers, JSONObject
            }
        }
        runOnUiThread { web.evaluateJavascript("window.t2hvApp && window.t2hvApp.$event($js)", null) }
    }

    private fun displayName(uri: Uri): String? = try {
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
            if (it.moveToFirst()) it.getString(0) else null
        }
    } catch (e: Exception) {
        uri.lastPathSegment
    }

    private fun openOutside(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri))
        } catch (_: ActivityNotFoundException) { }
    }

    // ------------------------------------------------------------ viewer state

    private fun setViewer(open: Boolean) {
        viewerOpen = open
        hideBars(open)
        requestedOrientation = if (open) ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                               else ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        if (open) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    private fun hideBars(on: Boolean) {
        immersive = on
        WindowCompat.getInsetsController(window, window.decorView).apply {
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            if (on) hide(WindowInsetsCompat.Type.systemBars()) else show(WindowInsetsCompat.Type.systemBars())
        }
    }

    /** Volume keys move through the deck while one is open. */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val key = when (event.keyCode) {
            KeyEvent.KEYCODE_VOLUME_DOWN -> "ArrowRight"
            KeyEvent.KEYCODE_VOLUME_UP -> "ArrowLeft"
            else -> null
        }
        if (viewerOpen && key != null) {
            if (event.action == KeyEvent.ACTION_DOWN) {
                web.evaluateJavascript(
                    "window.dispatchEvent(new KeyboardEvent('keydown', {key: '$key', bubbles: true}))", null)
            }
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    /** Called by the web app (window.TexViewer). */
    inner class Bridge {
        @JavascriptInterface fun viewerOpened() = runOnUiThread { setViewer(true) }
        @JavascriptInterface fun viewerClosed() = runOnUiThread { setViewer(false) }
        @JavascriptInterface fun toggleFullscreen() = runOnUiThread { hideBars(!immersive) }
        @JavascriptInterface fun listDecks(): String = decks.list().toString()
        @JavascriptInterface fun deleteDeck(id: String) = decks.delete(id)
        @JavascriptInterface fun storage(): String = decks.storage().toString()
        @JavascriptInterface fun cancelImport() { decks.cancelled = true }
    }

    // ------------------------------------------------------------ files

    /** A deck's file (https://<DOMAIN>/native/<id>/<path>), with the request's
     *  Range header (a video seeking); null for anything else. */
    private fun serveDeck(request: WebResourceRequest): WebResourceResponse? {
        val url = request.url
        if (url.host != DOMAIN || url.path?.startsWith("/native/") != true) return null
        val rest = url.encodedPath!!.removePrefix("/native/")
        val id = Uri.decode(rest.substringBefore('/'))
        val file = Uri.decode(rest.substringAfter('/', ""))
        if (file.isEmpty() || file.split('/').any { it == ".." }) return notFound()
        val range = request.requestHeaders.entries.firstOrNull { it.key.equals("Range", true) }?.value
        return try { decks.serve(id, file, range) } catch (_: Exception) { null } ?: notFound()
    }

    /** The bundled web app (assets/web/). */
    private inner class AppHandler : WebViewAssetLoader.PathHandler {
        override fun handle(path: String): WebResourceResponse? {
            val file = path.ifEmpty { "index.html" }
            return try {
                WebResourceResponse(mimeType(file), if (isText(file)) "utf-8" else null,
                                    assets.open("web/$file"))
            } catch (e: Exception) {
                null
            }
        }
    }

    companion object {
        const val DOMAIN = "appassets.androidplatform.net"
        fun notFound() = WebResourceResponse("text/plain", "utf-8", 404, "Not Found",
                                             emptyMap(), "".byteInputStream())

        private val TYPES = mapOf(
            "html" to "text/html", "css" to "text/css", "js" to "text/javascript",
            "json" to "application/json", "webmanifest" to "application/manifest+json",
            "svg" to "image/svg+xml", "png" to "image/png", "jpg" to "image/jpeg",
            "jpeg" to "image/jpeg", "gif" to "image/gif", "webp" to "image/webp",
            "woff" to "font/woff", "woff2" to "font/woff2",
            "mp4" to "video/mp4", "m4v" to "video/mp4", "webm" to "video/webm",
            "mov" to "video/quicktime", "ogv" to "video/ogg",
        )

        fun mimeType(path: String) = TYPES[path.substringAfterLast('.').lowercase()] ?: "application/octet-stream"
        fun isText(path: String) = mimeType(path).let { it.startsWith("text/") || it.endsWith("json") || it.endsWith("+xml") }
    }
}
