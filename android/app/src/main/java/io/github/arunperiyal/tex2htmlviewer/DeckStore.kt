package io.github.arunperiyal.tex2htmlviewer

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import android.text.Html
import android.webkit.WebResourceResponse
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.zip.ZipFile

/**
 * Decks kept by the app, read straight from their zip:
 *
 *   files/decks/<id>.zip    the pack, copied once at import
 *   files/decks/<id>.json   written last: id, name, title, bytes, importedAt, root
 *
 * A deck's files are served from the zip on request (ZipFile jumps to the
 * entry; a pack's images are stored uncompressed), so nothing is unpacked:
 * an import is one sequential copy, and a deck takes its zip's size once.
 */
class DeckStore(context: Context) {

    class ImportError(message: String) : Exception(message)

    private val resolver = context.contentResolver
    private val dir = File(context.filesDir, "decks").apply { mkdirs() }
    private class Open(val zip: ZipFile, val root: String)
    private val open = ConcurrentHashMap<String, Open>()

    @Volatile var cancelled = false

    fun list(): JSONArray {
        val decks = dir.listFiles { f -> f.name.endsWith(".json") }.orEmpty()
            .mapNotNull { f ->
                if (!File(dir, f.nameWithoutExtension + ".zip").isFile) null
                else try { JSONObject(f.readText()) } catch (_: Exception) { null }
            }
            .sortedByDescending { it.optLong("importedAt") }
        // leftovers of an interrupted import
        dir.listFiles { f -> f.name.endsWith(".part") }.orEmpty().forEach { it.delete() }
        return JSONArray(decks)
    }

    fun delete(id: String) {
        open.remove(id)?.zip?.close()
        File(dir, "$id.json").delete()
        File(dir, "$id.zip").delete()
    }

    /** Copy the zip in, check it is a pack, and record it. Replaces a deck of
     *  the same name once complete. Runs on a background thread. */
    fun import(uri: Uri, fileName: String, onProgress: (Long, Long) -> Unit): JSONObject {
        cancelled = false
        val total = size(uri)
        if (total > 0 && dir.usableSpace < total * 1.05) {
            throw ImportError("not enough storage: the deck needs ${mb(total)}, ${mb(dir.usableSpace)} is free")
        }
        val stamp = System.currentTimeMillis()
        val part = File(dir, "import-$stamp.part")
        try {
            resolver.openInputStream(uri).use { input ->
                input ?: throw ImportError("cannot read the file")
                part.outputStream().use { out ->
                    val buf = ByteArray(1 shl 20)
                    var done = 0L
                    var last = 0L
                    while (true) {
                        if (cancelled) throw ImportError("cancelled")
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        done += n
                        val now = System.nanoTime()
                        if (now - last > 150_000_000) { onProgress(done, total); last = now }
                    }
                    onProgress(done, if (total > 0) total else done)
                }
            }
            val (root, title) = ZipFile(part).use { zip ->
                val page = zip.entries().asSequence().map { it.name }
                    .filter { it == "slides.html" || it.endsWith("/slides.html") }
                    .minByOrNull { it.count { c -> c == '/' } }
                    ?: throw ImportError("no slides.html in this zip -- is it a tex2html --pack zip?")
                val html = zip.getInputStream(zip.getEntry(page)).use { it.readBytes() }.toString(Charsets.UTF_8)
                val t = Regex("<title>([^<]*)</title>", RegexOption.IGNORE_CASE).find(html)?.groupValues?.get(1)
                page.removeSuffix("slides.html") to t
            }
            val name = slug(root.trimEnd('/').ifEmpty { fileName.removeSuffix(".zip").removeSuffix(".ZIP") })
            val id = "$name-$stamp"
            if (!part.renameTo(File(dir, "$id.zip"))) throw ImportError("cannot store the deck")
            val deck = JSONObject()
                .put("id", id).put("name", name)
                .put("title", title?.trim()?.takeIf { it.isNotEmpty() }
                    ?.let { Html.fromHtml(it, Html.FROM_HTML_MODE_LEGACY).toString() } ?: name)
                .put("bytes", File(dir, "$id.zip").length()).put("importedAt", stamp).put("root", root)
            File(dir, "$id.json").writeText(deck.toString())
            val decks = list()
            for (i in 0 until decks.length()) {                        // the replaced deck
                val old = decks.optJSONObject(i) ?: continue
                if (old.optString("name") == name && old.optString("id") != id) delete(old.optString("id"))
            }
            return deck
        } catch (e: IOException) {
            throw ImportError(if (e is java.util.zip.ZipException) "not a zip file" else (e.message ?: "cannot read the file"))
        } finally {
            part.delete()                                              // only left if it failed
        }
    }

    /** A file of a deck, read from its zip; null if there is no such file. */
    fun serve(id: String, path: String): WebResourceResponse? {
        val deck = open[id] ?: run {
            val meta = File(dir, "$id.json")
            val file = File(dir, "$id.zip")
            if (!meta.isFile || !file.isFile) return null
            val root = try { JSONObject(meta.readText()).optString("root") } catch (_: Exception) { "" }
            Open(ZipFile(file), root).also { open[id] = it }
        }
        val zip = deck.zip
        val entry = zip.getEntry(deck.root + path) ?: return null
        if (entry.isDirectory) return null
        val mime = MainActivity.mimeType(path)
        return WebResourceResponse(mime, if (MainActivity.isText(path)) "utf-8" else null, zip.getInputStream(entry))
            .apply { responseHeaders = mapOf("Cache-Control" to "no-cache", "Content-Length" to entry.size.toString()) }
    }

    private fun size(uri: Uri): Long = try {
        resolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use {
            if (it.moveToFirst() && !it.isNull(0)) it.getLong(0) else -1L
        } ?: -1L
    } catch (_: Exception) { -1L }

    companion object {
        fun slug(s: String) = s.replace(Regex("[^A-Za-z0-9._-]+"), "-").trim('-').ifEmpty { "deck" }
        fun mb(n: Long) = if (n >= 1_000_000_000) "%.1f GB".format(n / 1e9) else "%.1f MB".format(maxOf(0.1, n / 1e6))
    }
}
