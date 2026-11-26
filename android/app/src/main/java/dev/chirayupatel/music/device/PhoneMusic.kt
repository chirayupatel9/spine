package dev.chirayupatel.music.device

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.util.Size
import androidx.core.content.ContextCompat
import dev.chirayupatel.music.net.Album
import dev.chirayupatel.music.net.AlbumDetail
import dev.chirayupatel.music.net.Track
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import kotlin.math.max
import kotlin.math.min

/**
 * The music on this phone, from Android's media library: albums and their tracks, with a cover
 * (saved once in the app's cache) and the spine colour taken from it. Nothing leaves the phone.
 */
class PhoneMusic(private val context: Context) {
    data class Library(val albums: List<Album>, val details: Map<String, AlbumDetail>)

    private val prefs = context.getSharedPreferences("phone_music", Context.MODE_PRIVATE)
    private val artDir = File(context.cacheDir, "phone-art").apply { mkdirs() }

    fun allowed(): Boolean = ContextCompat.checkSelfPermission(context, PERMISSION) == PackageManager.PERMISSION_GRANTED

    suspend fun scan(): Library = withContext(Dispatchers.IO) {
        if (!allowed()) return@withContext Library(emptyList(), emptyMap())
        val cols = buildList {
            add(MediaStore.Audio.Media._ID); add(MediaStore.Audio.Media.TITLE); add(MediaStore.Audio.Media.ARTIST)
            add(MediaStore.Audio.Media.ALBUM); add(MediaStore.Audio.Media.ALBUM_ID); add(MediaStore.Audio.Media.TRACK)
            add(MediaStore.Audio.Media.DURATION); add(MediaStore.Audio.Media.YEAR); add(MediaStore.Audio.Media.DATE_ADDED)
            if (Build.VERSION.SDK_INT >= 30) add(MediaStore.Audio.Media.ALBUM_ARTIST)
        }.toTypedArray()
        class Row(val id: Long, val title: String, val artist: String?, val albumArtist: String?, val album: String?, val albumId: Long,
                  val track: Int, val duration: Long, val year: Int, val added: Long)
        val rows = ArrayList<Row>()
        context.contentResolver.query(
            MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, cols, "${MediaStore.Audio.Media.IS_MUSIC} != 0", null, null,
        )?.use { c ->
            fun str(name: String) = c.getColumnIndex(name).takeIf { it >= 0 }?.let { c.getString(it) }?.takeIf { it.isNotBlank() && it != MediaStore.UNKNOWN_STRING }
            fun num(name: String) = c.getColumnIndex(name).takeIf { it >= 0 }?.let { c.getLong(it) } ?: 0L
            while (c.moveToNext()) {
                rows += Row(
                    num(MediaStore.Audio.Media._ID), str(MediaStore.Audio.Media.TITLE) ?: "Untitled",
                    str(MediaStore.Audio.Media.ARTIST), if (Build.VERSION.SDK_INT >= 30) str(MediaStore.Audio.Media.ALBUM_ARTIST) else null,
                    str(MediaStore.Audio.Media.ALBUM), num(MediaStore.Audio.Media.ALBUM_ID), num(MediaStore.Audio.Media.TRACK).toInt(),
                    num(MediaStore.Audio.Media.DURATION), num(MediaStore.Audio.Media.YEAR).toInt(), num(MediaStore.Audio.Media.DATE_ADDED),
                )
            }
        }
        val albums = ArrayList<Album>()
        val details = HashMap<String, AlbumDetail>()
        for ((albumId, tracks) in rows.groupBy { it.albumId }) {
            val id = "dev_$albumId"
            val artist = tracks.firstNotNullOfOrNull { it.albumArtist }
                ?: tracks.mapNotNull { it.artist }.groupingBy { it }.eachCount().maxByOrNull { it.value }?.key ?: "Unknown Artist"
            val title = tracks.firstNotNullOfOrNull { it.album } ?: "Unknown Album"
            val year = tracks.firstOrNull { it.year > 0 }?.year?.toString()
            val art = cover(albumId)
            val (color, ink) = colors(id, art)
            // MediaStore packs the disc into the track number: 2003 is disc 2, track 3.
            val list = tracks.sortedWith(compareBy({ it.track / 1000 }, { it.track % 1000 }, { it.title })).map { t ->
                Track(
                    id = "devt_${t.id}", title = t.title, artist = t.artist,
                    trackNo = (t.track % 1000).takeIf { it > 0 }, discNo = max(1, t.track / 1000),
                    duration = t.duration / 1000.0,
                    uri = ContentUris.withAppendedId(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, t.id).toString(),
                )
            }
            val artUrl = art?.let { Uri.fromFile(it).toString() }
            albums += Album(id = id, source = "device", title = title, artist = artist, year = year, color = color, textColor = ink,
                            art = artUrl, tracks = list.size, addedAt = tracks.maxOf { it.added }.toDouble())
            details[id] = AlbumDetail(id = id, source = "device", title = title, artist = artist, year = year, color = color,
                                      textColor = ink, art = artUrl, tracks = list.size, trackList = list)
        }
        Library(albums, details)
    }

    /** The album's cover, saved once as a small JPEG; null if it has none. */
    private fun cover(albumId: Long): File? {
        val file = File(artDir, "$albumId.jpg")
        if (file.exists()) return file.takeIf { it.length() > 0 }
        val bmp: Bitmap? = try {
            if (Build.VERSION.SDK_INT >= 29) {
                context.contentResolver.loadThumbnail(ContentUris.withAppendedId(MediaStore.Audio.Albums.EXTERNAL_CONTENT_URI, albumId), Size(512, 512), null)
            } else {
                context.contentResolver.openInputStream(Uri.parse("content://media/external/audio/albumart/$albumId"))?.use { BitmapFactory.decodeStream(it) }
            }
        } catch (e: Exception) { null }
        if (bmp == null) { file.writeBytes(ByteArray(0)); return null }   // remembered as "no cover"
        file.outputStream().use { bmp.compress(Bitmap.CompressFormat.JPEG, 88, it) }
        return file
    }

    /** The spine's colour from its cover, weighted towards colourful pixels (as on the web), and a
     *  text colour that reads on it. Kept, so it isn't worked out again on every start. */
    private fun colors(id: String, art: File?): Pair<String, String> {
        val key = "c:$id:${art?.length() ?: 0}"
        prefs.getString(key, null)?.split(",")?.takeIf { it.size == 2 }?.let { return it[0] to it[1] }
        val result = art?.let { f ->
            runCatching {
                val src = BitmapFactory.decodeFile(f.path) ?: return@runCatching null
                val small = Bitmap.createScaledBitmap(src, 24, 24, true)
                var r = 0.0; var g = 0.0; var b = 0.0; var n = 0.0
                for (x in 0 until 24) for (y in 0 until 24) {
                    val p = small.getPixel(x, y)
                    val pr = (p shr 16) and 255; val pg = (p shr 8) and 255; val pb = p and 255
                    val w = 1 + (max(pr, max(pg, pb)) - min(pr, min(pg, pb))) / 32.0
                    r += pr * w; g += pg * w; b += pb * w; n += w
                }
                r /= n; g /= n; b /= n
                "#%02x%02x%02x".format(r.toInt(), g.toInt(), b.toInt()) to (if (0.299 * r + 0.587 * g + 0.114 * b > 150) "#141414" else "#f4f1ea")
            }.getOrNull()
        } ?: placeholder(id)
        prefs.edit().putString(key, "${result.first},${result.second}").apply()
        return result
    }

    private fun placeholder(id: String): Pair<String, String> {
        val hue = (id.hashCode().toLong() and 0xffffffffL) % 360
        val c = android.graphics.Color.HSVToColor(floatArrayOf(hue.toFloat(), .45f, .3f))
        return "#%06x".format(c and 0xffffff) to "#f4f1ea"
    }

    companion object {
        val PERMISSION: String = if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_AUDIO else Manifest.permission.READ_EXTERNAL_STORAGE
    }
}
