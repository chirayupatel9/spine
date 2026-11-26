package dev.chirayupatel.music.net

import android.content.Context
import android.net.Uri
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.FormBody
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.TimeUnit

/* ---------------------------------------------------------------- what the server sends */

@Serializable
data class Album(
    val id: String,
    val source: String = "local",            // local | spotify | demo | device (on this phone)
    val kind: String = "album",              // album | playlist
    val title: String = "",
    val artist: String = "",
    val year: String? = null,
    val uri: String? = null,
    val color: String = "#333333",
    @SerialName("text_color") val textColor: String = "#f4f1ea",
    val art: String? = null,
    val hidden: Boolean = false,
    @SerialName("added_at") val addedAt: Double? = null,
    val tracks: Int? = null,
    val pos: Int? = null,
)

@Serializable
data class Track(
    val id: String,
    val title: String = "",
    val artist: String? = null,
    @SerialName("track_no") val trackNo: Int? = null,
    @SerialName("disc_no") val discNo: Int? = null,
    val duration: Double? = null,
    val uri: String? = null,
)

@Serializable
data class AlbumDetail(
    val id: String,
    val source: String = "local",
    val kind: String = "album",
    val tracks: Int? = null,
    @SerialName("tracks_shared") val tracksShared: Boolean = true,   // Spotify lists a playlist's tracks only for its owner
    val title: String = "",
    val artist: String = "",
    val year: String? = null,
    val uri: String? = null,
    val color: String = "#333333",
    @SerialName("text_color") val textColor: String = "#f4f1ea",
    val art: String? = null,
    @SerialName("track_list") val trackList: List<Track> = emptyList(),
)

@Serializable data class DemoStatus(val loading: Boolean = false, val albums: Int = 0, val total: Int = 0, val error: String? = null)
@Serializable data class SpotifyStatus(val configured: Boolean = false, val connected: Boolean = false, val syncing: Boolean = false)
@Serializable data class Status(val admin: Boolean = false, val demo: DemoStatus = DemoStatus(), val spotify: SpotifyStatus = SpotifyStatus())

/** Who is signed in. */
@Serializable
data class Me(
    val id: Int = 0,
    val name: String = "",
    val email: String = "",
    val picture: String = "",
    val admin: Boolean = false,
    val google: Boolean = false,
    @SerialName("spotify_id") val spotifyId: String? = null,
    val spotify: SpotifyStatus = SpotifyStatus(),
)

@Serializable data class Order(val ids: List<String> = emptyList())
@Serializable data class Link(val url: String)

/** What Spotify is playing, as the server reports it (all empty when nothing is). */
@Serializable
data class SpotifyState(
    @SerialName("is_playing") val isPlaying: Boolean? = null,
    @SerialName("progress_ms") val progressMs: Long? = null,
    @SerialName("duration_ms") val durationMs: Long? = null,
    val track: String? = null,
    val artist: String? = null,
    @SerialName("album_id") val albumId: String? = null,
    val album: String? = null,
    val image: String? = null,
    val device: String? = null,
    val shuffle: Boolean? = null,
    val repeat: String? = null,
)

class NotSignedIn : IOException("Not signed in")
class ServerError(message: String) : IOException(message)

/* ---------------------------------------------------------------- the signed-in session */

/** The server address and its sign-in cookie, in this app's private storage. */
class Session(context: Context) {
    private val prefs = context.getSharedPreferences("session", Context.MODE_PRIVATE)

    var server: String
        get() = prefs.getString("server", DEFAULT_SERVER) ?: DEFAULT_SERVER
        set(v) { prefs.edit().putString("server", v.trimEnd('/')).apply() }

    fun saveCookies(cookies: List<Cookie>) {
        prefs.edit().putStringSet("cookies", cookies.map { it.toString() }.toSet()).apply()
    }

    fun loadCookies(): List<Cookie> {
        val url = server.toHttpUrlOrNull() ?: return emptyList()
        return prefs.getStringSet("cookies", emptySet()).orEmpty().mapNotNull { Cookie.parse(url, it) }
    }

    fun clearCookies() { prefs.edit().remove("cookies").apply() }

    companion object { const val DEFAULT_SERVER = "https://music.chirayupatel.dev" }
}

private class PersistentCookieJar(private val session: Session) : CookieJar {
    private val cookies = session.loadCookies().toMutableList()

    @Synchronized
    override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
        val now = System.currentTimeMillis()
        for (c in cookies) {
            this.cookies.removeAll { it.name == c.name && it.domain == c.domain && it.path == c.path }
            if (c.expiresAt > now) this.cookies.add(c)
        }
        session.saveCookies(this.cookies)
    }

    @Synchronized
    override fun loadForRequest(url: HttpUrl): List<Cookie> {
        val now = System.currentTimeMillis()
        cookies.removeAll { it.expiresAt <= now }
        return cookies.filter { it.matches(url) }
    }

    @Synchronized
    fun clear() { cookies.clear(); session.clearCookies() }
}

/* ---------------------------------------------------------------- the API */

class Api(context: Context) {
    val session = Session(context)
    private val jar = PersistentCookieJar(session)

    val client: OkHttpClient = OkHttpClient.Builder()
        .cookieJar(jar)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()
    private val noRedirects = client.newBuilder().followRedirects(false).followSslRedirects(false).build()

    val json = Json { ignoreUnknownKeys = true; explicitNulls = false; coerceInputValues = true }

    val server: String get() = session.server
    fun url(path: String): String =
        if (path.startsWith("http") || path.startsWith("file:") || path.startsWith("content:")) path else server + path

    fun hasSession(): Boolean {
        val u = server.toHttpUrlOrNull() ?: return false
        return jar.loadForRequest(u).any { it.name == "av_session" }
    }

    /** "music.example.com" -> "https://music.example.com"; null if it isn't a web address. */
    fun normalize(serverInput: String): String? {
        val base = serverInput.trim().trimEnd('/').let { if (it.startsWith("http://") || it.startsWith("https://")) it else "https://$it" }
        return base.takeIf { it.toHttpUrlOrNull() != null }
    }

    /** Finish a Google or Spotify sign-in made in the browser: trade its one-time code (and the secret
     *  only this app knows) for a session of the app's own. */
    suspend fun exchangeAppCode(base: String, code: String, verifier: String) = withContext(Dispatchers.IO) {
        val body = buildJsonObject { put("code", code); put("verifier", verifier) }.toString()
        val req = Request.Builder().url("$base/auth/app/exchange").post(body.toRequestBody("application/json".toMediaType())).build()
        noRedirects.newCall(req).execute().use { r ->
            if (!r.isSuccessful) throw ServerError("That sign-in didn't go through. Try again.")
            session.server = base
        }
    }

    suspend fun signIn(serverInput: String, password: String) = withContext(Dispatchers.IO) {
        val base = normalize(serverInput) ?: throw ServerError("That isn't a web address")
        val req = Request.Builder().url("$base/login").post(FormBody.Builder().add("password", password).build()).build()
        noRedirects.newCall(req).execute().use { r ->
            when (r.code) {
                302, 303 -> session.server = base
                401 -> throw ServerError("Wrong password")
                429 -> throw ServerError("Too many attempts. Try again in a few minutes.")
                else -> throw ServerError("The server answered ${r.code}")
            }
        }
    }

    suspend fun signOut() = withContext(Dispatchers.IO) {
        runCatching { noRedirects.newCall(Request.Builder().url(url("/logout")).post(FormBody.Builder().build()).build()).execute().close() }
        jar.clear()
    }

    suspend fun albumsJson(includeHidden: Boolean = false): String = getText("/api/albums?include_hidden=$includeHidden")
    fun parseAlbums(text: String): List<Album> = json.decodeFromString(text)
    suspend fun album(id: String): AlbumDetail = json.decodeFromString(getText("/api/albums/" + Uri.encode(id)))
    suspend fun status(): Status = json.decodeFromString(getText("/api/status"))
    suspend fun me(): Me = json.decodeFromString(getText("/api/me"))
    suspend fun order(): List<String> = json.decodeFromString<Order>(getText("/api/order")).ids
    /** A one-time address that connects Spotify to this account in a browser tab, then returns here. */
    suspend fun spotifyConnectLink(): String = withContext(Dispatchers.IO) {
        val req = Request.Builder().url(url("/api/spotify/connect-link")).post("{}".toRequestBody("application/json".toMediaType())).build()
        client.newCall(req).execute().use { r -> check(r); json.decodeFromString<Link>(r.body?.string().orEmpty()).url }
    }
    suspend fun loadDemo() = post("/api/demo/load")
    suspend fun spotifyPlay(uri: String?, offset: Int) =
        post("/api/spotify/play", buildJsonObject { put("uri", uri); put("offset", offset) }.toString())
    /** pause, resume, next, previous; seek (value: ms), shuffle (value: on/off), repeat (value: off, context, track). */
    suspend fun spotifyControl(action: String, value: Any? = null) = post("/api/spotify/control", buildJsonObject {
        put("action", action)
        when (value) {
            is Boolean -> put("value", value)
            is Number -> put("value", value)
            is String -> put("value", value)
        }
    }.toString())
    suspend fun spotifyState(): SpotifyState = json.decodeFromString(getText("/api/spotify/state"))

    /** The manual shelf order, shared by every screen (the web app reads the same list). */
    suspend fun saveOrder(ids: List<String>) =
        send("PUT", "/api/order", buildJsonObject { putJsonArray("ids") { ids.forEach { add(it) } } }.toString())

    fun streamUrl(trackId: String) = url("/api/local/stream/" + Uri.encode(trackId))

    private suspend fun getText(path: String): String = withContext(Dispatchers.IO) {
        client.newCall(Request.Builder().url(url(path)).build()).execute().use { r -> check(r); r.body?.string().orEmpty() }
    }

    private suspend fun post(path: String, body: String = "{}") = send("POST", path, body)

    private suspend fun send(method: String, path: String, body: String) = withContext(Dispatchers.IO) {
        val req = Request.Builder().url(url(path)).method(method, body.toRequestBody("application/json".toMediaType())).build()
        client.newCall(req).execute().use { r -> check(r) }
    }

    private fun check(r: Response) {
        if (r.code == 401) throw NotSignedIn()
        if (!r.isSuccessful) {
            val detail = runCatching { json.decodeFromString<JsonObject>(r.peekBody(4096).string())["detail"]?.jsonPrimitive?.content }.getOrNull()
            throw ServerError(detail ?: "The server answered ${r.code}")
        }
    }
}
