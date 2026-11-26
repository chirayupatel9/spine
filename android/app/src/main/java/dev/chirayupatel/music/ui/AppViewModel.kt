package dev.chirayupatel.music.ui

import android.app.Application
import android.content.ComponentName
import android.content.Context
import android.net.Uri
import android.os.Bundle
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import dev.chirayupatel.music.App
import dev.chirayupatel.music.net.Album
import dev.chirayupatel.music.net.AlbumDetail
import dev.chirayupatel.music.net.NotSignedIn
import dev.chirayupatel.music.net.SpotifyState
import dev.chirayupatel.music.net.Status
import dev.chirayupatel.music.playback.PlaybackService
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.builtins.ListSerializer
import java.io.File
import java.io.IOException
import java.text.Collator
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.random.Random

enum class Sort(val label: String) {
    ARTIST("By artist"), DECADE("By decade"), ADDED("Recently added"), TITLE("By title"), COLOR("By colour"), MANUAL("Manual order")
}

/** A track in Up next: where it is in the player's list, and what to show for it. */
data class QueueItem(val index: Int, val id: String, val title: String, val number: Int, val durationMs: Long)

class AppViewModel(app: Application) : AndroidViewModel(app) {
    private val api = (app as App).api
    private val prefs = app.getSharedPreferences("ui", Context.MODE_PRIVATE)
    private val cacheFile = File(app.filesDir, "albums.json")

    /** null while starting, then whether this device is signed in. */
    var signedIn by mutableStateOf<Boolean?>(null); private set
    var albums by mutableStateOf<List<Album>>(emptyList()); private set
    var loaded by mutableStateOf(false); private set
    var status by mutableStateOf<Status?>(null); private set

    var source by mutableStateOf(prefs.getString("source", "all") ?: "all")
        private set
    var sort by mutableStateOf(runCatching { Sort.valueOf(prefs.getString("sort", "ARTIST")!!) }.getOrDefault(Sort.ARTIST))
        private set
    var query by mutableStateOf("")
    var openId by mutableStateOf<String?>(null)
    var sheet by mutableStateOf<AlbumDetail?>(null)
    var showSettings by mutableStateOf(false)
    var showPlayer by mutableStateOf(false)   // the full-screen player
    var wallMode by mutableStateOf(false)
    var message by mutableStateOf<String?>(null)

    // what's playing (mirrors the background player, or Spotify)
    var nowAlbumId by mutableStateOf<String?>(null); private set
    var nowTrackId by mutableStateOf<String?>(null); private set
    var nowTitle by mutableStateOf(""); private set
    var nowArtist by mutableStateOf(""); private set
    var nowArt by mutableStateOf<String?>(null); private set
    var isPlaying by mutableStateOf(false); private set
    var position by mutableLongStateOf(0L); private set
    var duration by mutableLongStateOf(0L); private set
    var upNext by mutableStateOf<List<QueueItem>>(emptyList()); private set
    /** Shuffle and repeat as the playing source has them (repeat: Player.REPEAT_MODE_*). */
    var shuffleOn by mutableStateOf(prefs.getBoolean("shuffle", false)); private set
    var repeatMode by mutableIntStateOf(prefs.getInt("repeat", Player.REPEAT_MODE_OFF)); private set
    var spotifyMode by mutableStateOf(false); private set
    private var foreground = true

    val server: String get() = api.server
    fun artUrl(path: String?): String? = path?.let { api.url(it) }

    val hasDemo by derivedStateOf { albums.any { it.source == "demo" } }

    val visible: List<Album> by derivedStateOf {
        val q = query.trim().lowercase()
        val src = if (source == "demo" && !hasDemo) "all" else source
        arrange(albums.filter { (src == "all" || it.source == src) && (q.isEmpty() || it.title.lowercase().contains(q) || it.artist.lowercase().contains(q)) }, sort)
    }

    /** The A-Z (or decade) jumps: each key with the index of its first album. */
    val railKeys: List<Pair<String, Int>> by derivedStateOf {
        val list = visible
        if (list.size < 8) return@derivedStateOf emptyList()
        val seen = LinkedHashMap<String, Int>()
        list.forEachIndexed { i, a -> indexKey(a, sort)?.let { k -> if (k !in seen) seen[k] = i } }
        if (seen.size < 2) emptyList() else seen.entries.map { it.key to it.value }
    }

    private var controllerFuture: ListenableFuture<MediaController>? = null
    private var controller: MediaController? = null
    private val details = HashMap<String, AlbumDetail>()

    init {
        val ok = api.hasSession()
        if (ok) showCached()
        signedIn = ok
        if (ok) refresh()
        connectPlayer()
        viewModelScope.launch {   // keep the position moving while something plays
            var tick = 0
            while (true) {
                if (spotifyMode) {
                    if (isPlaying && duration > 0) position = min(duration, position + 500)
                    if (foreground && tick % 6 == 0) pollSpotify()
                } else controller?.let { if (it.isPlaying) { position = it.currentPosition; duration = max(0L, it.duration) } }
                tick++
                delay(500)
            }
        }
    }

    fun onForeground(on: Boolean) {
        foreground = on
        if (on && spotifyMode) viewModelScope.launch { pollSpotify() }
    }

    /* ------------------------------------------------ signing in and loading */

    suspend fun signIn(server: String, password: String): String? = try {
        api.signIn(server, password)
        signedIn = true
        refresh()
        null
    } catch (e: IOException) {
        e.message ?: "Couldn't reach the server"
    }

    fun signOut() = viewModelScope.launch {
        controller?.run { stop(); clearMediaItems() }
        api.signOut()
        withContext(Dispatchers.IO) { cacheFile.delete() }
        albums = emptyList(); loaded = false; openId = null; sheet = null; showSettings = false; showPlayer = false
        nowAlbumId = null; nowTitle = ""; spotifyMode = false; upNext = emptyList()
        signedIn = false
    }

    private fun showCached() {   // the last shelf this device saw: on screen instantly
        runCatching { if (cacheFile.exists()) { albums = api.parseAlbums(cacheFile.readText()); loaded = true } }
    }

    fun refresh() = viewModelScope.launch {
        try {
            val text = api.albumsJson()
            val list = withContext(Dispatchers.Default) { api.parseAlbums(text) }
            if (list != albums) albums = list
            loaded = true
            withContext(Dispatchers.IO) { cacheFile.writeText(text) }
            status = runCatching { api.status() }.getOrNull()
            // Pick up whatever Spotify is already playing, unless this phone is playing something.
            if (status?.spotify?.connected == true && !spotifyMode && (controller?.mediaItemCount ?: 0) == 0) {
                val s = runCatching { api.spotifyState() }.getOrNull()
                if (s?.track != null && s.isPlaying == true) { spotifyMode = true; applySpotify(s) }
            }
        } catch (e: NotSignedIn) {
            signedIn = false
        } catch (e: IOException) {
            if (albums.isEmpty()) message = "Can't reach ${Uri.parse(api.server).host ?: "the server"}"
        }
    }

    fun loadDemo() = viewModelScope.launch {
        try {
            api.loadDemo()
            message = "Loading the demo shelf…"
            repeat(60) {
                delay(1500)
                val st = runCatching { api.status() }.getOrNull() ?: return@repeat
                status = st
                if (it % 2 == 1 || !st.demo.loading) refresh()
                if (!st.demo.loading) return@launch
            }
        } catch (e: IOException) { message = e.message }
    }

    fun chooseSource(s: String) { source = s; prefs.edit().putString("source", s).apply() }
    fun chooseSort(s: Sort) {
        if (s == Sort.MANUAL && sort != Sort.MANUAL) message = "Hold an album, then drag it to a new place"
        sort = s; prefs.edit().putString("sort", s.name).apply()
    }

    /**
     * Save a dragged-into-place order. `shown` is the order on screen; albums the current filter or
     * search hides keep their slots, as on the web. The shelf switches to the manual order, starting
     * from what was on screen, so nothing jumps.
     */
    fun saveOrder(shown: List<String>) {
        val shownSet = shown.toHashSet()
        var k = 0
        val ids = arrange(albums, Sort.MANUAL).map { if (it.id in shownSet && k < shown.size) shown[k++] else it.id }
        val pos = ids.withIndex().associate { (i, id) -> id to i }
        albums = albums.map { it.copy(pos = pos[it.id]) }
        if (sort != Sort.MANUAL) { sort = Sort.MANUAL; prefs.edit().putString("sort", Sort.MANUAL.name).apply() }
        val snapshot = albums
        viewModelScope.launch {
            try {
                api.saveOrder(ids)
                withContext(Dispatchers.IO) { cacheFile.writeText(api.json.encodeToString(ListSerializer(Album.serializer()), snapshot)) }
            } catch (e: IOException) {
                if (e is NotSignedIn) signedIn = false else message = "Couldn't save the order: ${e.message}"
            }
        }
    }

    /* ------------------------------------------------ the shelf */

    fun tap(a: Album) {
        if (openId == a.id) { openSheet(a.id); return }
        openId = a.id
        play(a.id)
    }

    fun openSheet(id: String) = viewModelScope.launch {
        try { sheet = detail(id) } catch (e: IOException) { handle(e) }
    }

    private suspend fun detail(id: String): AlbumDetail = details[id] ?: api.album(id).also { details[id] = it }

    /* ------------------------------------------------ playing */

    private fun connectPlayer() {
        val ctx = getApplication<Application>()
        val token = SessionToken(ctx, ComponentName(ctx, PlaybackService::class.java))
        val future = MediaController.Builder(ctx, token).buildAsync()
        controllerFuture = future
        future.addListener({
            val c = runCatching { future.get() }.getOrNull() ?: return@addListener
            controller = c
            c.addListener(object : Player.Listener {
                override fun onEvents(player: Player, events: Player.Events) = sync(player)
            })
            sync(c)
        }, ContextCompat.getMainExecutor(ctx))
    }

    private fun sync(p: Player) {
        // While Spotify plays, this phone's own player (paused, or empty) has nothing to say,
        // until it starts playing again itself.
        if (spotifyMode && !p.isPlaying) return
        isPlaying = p.isPlaying
        val item = p.currentMediaItem
        nowTrackId = item?.mediaId
        val m = item?.mediaMetadata
        if (m != null) {
            spotifyMode = false
            nowTitle = m.title?.toString().orEmpty()
            nowArtist = m.artist?.toString().orEmpty()
            nowArt = m.artworkUri?.toString()
            m.extras?.getString("albumId")?.let { nowAlbumId = it }
        }
        position = p.currentPosition
        duration = max(0L, p.duration)
        if (p.mediaItemCount > 0) {
            if (p.shuffleModeEnabled != shuffleOn) { shuffleOn = p.shuffleModeEnabled; prefs.edit().putBoolean("shuffle", shuffleOn).apply() }
            if (p.repeatMode != repeatMode) { repeatMode = p.repeatMode; prefs.edit().putInt("repeat", repeatMode).apply() }
            val q = upNextOf(p)
            if (q != upNext) upNext = q
        }
    }

    /** What plays after this track, in the player's order (shuffled or not), wrapping if repeating. */
    private fun upNextOf(p: Player): List<QueueItem> {
        val tl = p.currentTimeline
        if (tl.isEmpty) return emptyList()
        val tracks = nowAlbumId?.let { details[it]?.trackList }.orEmpty().associateBy { it.id }
        val mode = if (p.repeatMode == Player.REPEAT_MODE_ONE) Player.REPEAT_MODE_OFF else p.repeatMode
        val start = p.currentMediaItemIndex
        val out = ArrayList<QueueItem>()
        var i = start
        while (out.size < 60) {
            i = tl.getNextWindowIndex(i, mode, p.shuffleModeEnabled)
            if (i == C.INDEX_UNSET || i == start) break
            val item = p.getMediaItemAt(i)
            val t = tracks[item.mediaId]
            out += QueueItem(i, item.mediaId, item.mediaMetadata.title?.toString().orEmpty(), t?.trackNo ?: (i + 1), ((t?.duration ?: 0.0) * 1000).toLong())
        }
        return out
    }

    /** `index`: the track to start on. Leave it out to play the album from the top, or from a random
     *  track when shuffle is on. */
    fun play(albumId: String, index: Int? = null, shuffle: Boolean = false) = viewModelScope.launch {
        try {
            val a = detail(albumId)
            if (a.trackList.isEmpty()) { message = "This album has no playable tracks"; return@launch }
            if (a.source == "spotify") {
                controller?.run { stop(); clearMediaItems() }   // this phone's own queue is done with
                val offset = if (shuffle) Random.nextInt(a.trackList.size) else (index ?: 0)
                api.spotifyPlay(a.uri, offset)
                spotifyMode = true; upNext = emptyList()
                nowAlbumId = a.id; nowTitle = a.trackList.getOrNull(offset)?.title ?: a.title; nowArtist = a.artist
                nowArt = artUrl(a.art); isPlaying = true; position = 0
                duration = ((a.trackList.getOrNull(offset)?.duration ?: 0.0) * 1000).toLong()
                delay(800); pollSpotify()
                return@launch
            }
            val art = a.art?.let { Uri.parse(api.url(it)) }
            val items = a.trackList.map { t ->
                val uri = if (a.source == "demo") t.uri.orEmpty() else api.streamUrl(t.id)
                MediaItem.Builder().setMediaId(t.id).setUri(uri)
                    .setMediaMetadata(
                        MediaMetadata.Builder()
                            .setTitle(t.title).setArtist(t.artist ?: a.artist)
                            .setAlbumTitle(a.title).setAlbumArtist(a.artist)
                            .setArtworkUri(art)
                            .setExtras(Bundle().apply { putString("albumId", a.id) })
                            .build(),
                    ).build()
            }
            val c = controller ?: run { message = "The player isn't ready yet"; return@launch }
            if (shuffle && !shuffleOn) { shuffleOn = true; prefs.edit().putBoolean("shuffle", true).apply() }
            val first = index ?: if (shuffleOn) Random.nextInt(items.size) else 0
            if (spotifyMode) { spotifyMode = false; runCatching { api.spotifyControl("pause") } }
            nowAlbumId = a.id
            c.setMediaItems(items, first.coerceIn(0, items.lastIndex), 0L)
            c.shuffleModeEnabled = shuffleOn
            c.repeatMode = repeatMode
            c.prepare()
            c.play()
        } catch (e: IOException) { handle(e) }
    }

    fun toggle() {
        if (spotifyMode) {
            val action = if (isPlaying) "pause" else "resume"
            isPlaying = !isPlaying
            spotify(action)
            return
        }
        controller?.let { if (it.isPlaying) it.pause() else it.play() }
    }

    fun next() { if (spotifyMode) spotify("next") else controller?.seekToNextMediaItem() }

    fun prev() {
        if (spotifyMode) spotify("previous")
        else controller?.let { if (it.currentPosition > 4000 || !it.hasPreviousMediaItem()) it.seekTo(0) else it.seekToPreviousMediaItem() }
    }

    fun seekTo(fraction: Float) {
        if (spotifyMode) {
            if (duration <= 0) return
            position = (duration * fraction).toLong()
            spotify("seek", position)
            return
        }
        controller?.let { if (it.duration > 0) { it.seekTo((it.duration * fraction).toLong()); position = it.currentPosition } }
    }

    /** Up next: play that track now. */
    fun playQueueItem(index: Int) { controller?.run { seekToDefaultPosition(index); play() } }

    fun toggleShuffle() {
        val on = !shuffleOn
        shuffleOn = on
        if (spotifyMode) { spotify("shuffle", on); return }
        prefs.edit().putBoolean("shuffle", on).apply()
        controller?.shuffleModeEnabled = on
    }

    /** Off, then the whole album, then this track. */
    fun cycleRepeat() {
        val next = when (repeatMode) { Player.REPEAT_MODE_OFF -> Player.REPEAT_MODE_ALL; Player.REPEAT_MODE_ALL -> Player.REPEAT_MODE_ONE; else -> Player.REPEAT_MODE_OFF }
        repeatMode = next
        if (spotifyMode) { spotify("repeat", when (next) { Player.REPEAT_MODE_ALL -> "context"; Player.REPEAT_MODE_ONE -> "track"; else -> "off" }); return }
        prefs.edit().putInt("repeat", next).apply()
        controller?.repeatMode = next
    }

    private fun spotify(action: String, value: Any? = null) = viewModelScope.launch {
        try { api.spotifyControl(action, value) } catch (e: IOException) { handle(e) }
        delay(600)
        pollSpotify()
    }

    private suspend fun pollSpotify() {
        if (!spotifyMode) return
        val s = try { api.spotifyState() } catch (e: IOException) { return }
        if (s.track != null) applySpotify(s)
    }

    private fun applySpotify(s: SpotifyState) {
        nowTitle = s.track.orEmpty()
        nowArtist = s.artist.orEmpty()
        isPlaying = s.isPlaying == true
        position = s.progressMs ?: 0L
        duration = s.durationMs ?: 0L
        shuffleOn = s.shuffle == true
        repeatMode = when (s.repeat) { "context" -> Player.REPEAT_MODE_ALL; "track" -> Player.REPEAT_MODE_ONE; else -> Player.REPEAT_MODE_OFF }
        val mine = albums.firstOrNull { it.id == s.albumId }
        nowArt = mine?.art?.let(::artUrl) ?: s.image   // the server's copy of the cover, so it doesn't load twice
        if (s.albumId != null && s.albumId != nowAlbumId) {
            nowAlbumId = s.albumId
            if (mine != null) openId = mine.id
        }
    }

    /** Put the open album back on the shelf: its record goes back in the sleeve, so if it's the album
     *  playing, the music stops too. */
    fun putBack() {
        if (nowAlbumId != null && nowAlbumId == openId) {
            if (spotifyMode) { spotifyMode = false; viewModelScope.launch { runCatching { api.spotifyControl("pause") } } }
            controller?.run { stop(); clearMediaItems() }
            nowAlbumId = null; nowTitle = ""; isPlaying = false; showPlayer = false; upNext = emptyList()
        }
        openId = null
        sheet = null
    }

    private fun handle(e: IOException) { if (e is NotSignedIn) signedIn = false else message = e.message }

    override fun onCleared() {
        controllerFuture?.let { MediaController.releaseFuture(it) }
        super.onCleared()
    }
}

/* ---------------------------------------------------------------- arranging (as on the web) */

private val collator: Collator = Collator.getInstance().apply { strength = Collator.PRIMARY }
private fun cmp(a: String?, b: String?) = collator.compare(a.orEmpty(), b.orEmpty())
fun artistKey(s: String) = s.replace(Regex("^the\\s+", RegexOption.IGNORE_CASE), "").trim()

private fun hueKey(hex: String): Double {
    val c = parseColor(hex)
    val r = c.red.toDouble(); val g = c.green.toDouble(); val b = c.blue.toDouble()
    val mx = maxOf(r, g, b); val mn = minOf(r, g, b); val l = (mx + mn) / 2; val d = mx - mn
    if (d < 0.08) return 1000 + (1 - l)   // greys after colours, light to dark
    var h = when (mx) { r -> ((g - b) / d) % 6; g -> (b - r) / d + 2; else -> (r - g) / d + 4 }
    h = (h * 60 + 360) % 360
    return h + (1 - l) * 0.5
}

fun arrange(list: List<Album>, sort: Sort): List<Album> {
    val byArtist = Comparator<Album> { a, b -> cmp(artistKey(a.artist), artistKey(b.artist)).takeIf { it != 0 } ?: cmp(a.year, b.year).takeIf { it != 0 } ?: cmp(a.title, b.title) }
    val c: Comparator<Album> = when (sort) {
        Sort.ARTIST -> byArtist
        Sort.DECADE -> Comparator { a, b -> ((a.year ?: "9999").compareTo(b.year ?: "9999")).takeIf { it != 0 } ?: byArtist.compare(a, b) }
        Sort.ADDED -> Comparator { a, b -> (b.addedAt ?: 0.0).compareTo(a.addedAt ?: 0.0) }
        Sort.TITLE -> Comparator { a, b -> cmp(a.title, b.title).takeIf { it != 0 } ?: byArtist.compare(a, b) }
        Sort.COLOR -> Comparator { a, b -> hueKey(a.color).compareTo(hueKey(b.color)) }
        Sort.MANUAL -> Comparator { a, b -> ((a.pos ?: Int.MAX_VALUE).compareTo(b.pos ?: Int.MAX_VALUE)).takeIf { it != 0 } ?: byArtist.compare(a, b) }
    }
    return list.sortedWith(c)
}

fun indexKey(a: Album, sort: Sort): String? = when (sort) {
    Sort.ARTIST -> artistKey(a.artist).firstOrNull()?.uppercaseChar()?.let { if (it in 'A'..'Z') it.toString() else "#" }
    Sort.TITLE -> a.title.firstOrNull()?.uppercaseChar()?.let { if (it in 'A'..'Z') it.toString() else "#" }
    Sort.DECADE -> a.year?.takeIf { it.length >= 3 }?.let { it.take(3) + "0s" } ?: "Undated"
    else -> null
}

/* ---------------------------------------------------------------- how a spine looks */

/** FNV-1a, as on the web, so an album keeps its look on every screen. */
fun spineHash(s: String): Long {
    var h = 2166136261L
    for (ch in s) h = ((h xor ch.code.toLong()) * 16777619L) and 0xffffffffL
    return h
}

/** Spine thickness in px for a shelf `cross` px across, from the track count and a stable jitter. */
fun spineThickness(a: Album, cross: Float): Float {
    val n = a.tracks ?: 10
    val f = when { n <= 6 -> 0.8f; n <= 16 -> 1f; n <= 24 -> 1.4f; else -> 1.8f }
    val jitter = 0.92f + (spineHash(a.id) % 100) / 100f * 0.16f
    return max(9, (cross / 12.5f * f * jitter).roundToInt()).toFloat()
}
