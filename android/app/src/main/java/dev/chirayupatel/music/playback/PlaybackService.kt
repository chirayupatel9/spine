package dev.chirayupatel.music.playback

import android.app.PendingIntent
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.Player
import androidx.media3.common.Timeline
import androidx.media3.common.util.BitmapLoader
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.source.ShuffleOrder
import androidx.media3.session.CacheBitmapLoader
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.ListeningExecutorService
import com.google.common.util.concurrent.MoreExecutors
import dev.chirayupatel.music.App
import dev.chirayupatel.music.ui.MainActivity
import dev.chirayupatel.music.ui.NowPlayingWidget
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException
import java.util.concurrent.Callable
import java.util.concurrent.Executors

/**
 * Plays local and demo albums in the background: the notification and lock screen get artwork,
 * a position bar and controls; headphones and Bluetooth buttons work; unplugging pauses.
 */
@OptIn(UnstableApi::class)
class PlaybackService : MediaSessionService() {
    private var session: MediaSession? = null

    override fun onCreate() {
        super.onCreate()
        val client = (application as App).api.client
        val http = OkHttpDataSource.Factory(client)   // sends the sign-in cookie with stream requests
        val player = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(DefaultDataSource.Factory(this, http)))
            .setAudioAttributes(
                AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(),
                /* handleAudioFocus = */ true,
            )
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .build()
        // Shuffle from the track playing now: it comes first and every other track follows once.
        // (Left alone, the player shuffles the whole album and starts part-way through that order,
        // so the tracks before it there would never play.)
        player.addListener(object : Player.Listener {
            override fun onShuffleModeEnabledChanged(shuffleModeEnabled: Boolean) { if (shuffleModeEnabled) shuffleFromCurrent(player) }
            override fun onTimelineChanged(timeline: Timeline, reason: Int) {
                if (reason == Player.TIMELINE_CHANGE_REASON_PLAYLIST_CHANGED && player.shuffleModeEnabled) shuffleFromCurrent(player)
            }
        })
        // The home-screen widget follows this player: what's playing, and whether it is.
        player.addListener(object : Player.Listener {
            override fun onEvents(p: Player, events: Player.Events) {
                if (!events.containsAny(Player.EVENT_IS_PLAYING_CHANGED, Player.EVENT_MEDIA_ITEM_TRANSITION, Player.EVENT_MEDIA_METADATA_CHANGED)) return
                val m = p.currentMediaItem?.mediaMetadata ?: return   // emptied for Spotify: the app tells the widget
                NowPlayingWidget.show(this@PlaybackService, m.title?.toString().orEmpty(), m.artist?.toString().orEmpty(),
                    p.isPlaying, spotify = false, art = m.artworkUri?.toString())
            }
        })
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        session = MediaSession.Builder(this, player)
            .setBitmapLoader(CacheBitmapLoader(SignedInBitmapLoader(client, contentResolver)))
            .setSessionActivity(open)
            .build()
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

    private fun shuffleFromCurrent(p: ExoPlayer) {
        val n = p.mediaItemCount
        if (n < 2) return
        val cur = p.currentMediaItemIndex
        if (p.currentTimeline.getFirstWindowIndex(true) == cur) return   // already starts here
        val rest = (0 until n).filter { it != cur }.shuffled()
        p.setShuffleOrder(ShuffleOrder.DefaultShuffleOrder(intArrayOf(cur) + rest.toIntArray(), System.nanoTime()))
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        val p = session?.player
        if (p == null || !p.playWhenReady || p.mediaItemCount == 0) stopSelf()
    }

    override fun onDestroy() {
        session?.run { player.release(); release() }
        session = null
        super.onDestroy()
    }
}

/** Loads cover art for the notification: from the server through the signed-in client (covers
 *  need sign-in), or from this phone for its own music. */
@OptIn(UnstableApi::class)
private class SignedInBitmapLoader(private val client: OkHttpClient, private val resolver: android.content.ContentResolver) : BitmapLoader {
    private val executor: ListeningExecutorService = MoreExecutors.listeningDecorator(Executors.newSingleThreadExecutor())

    override fun supportsMimeType(mimeType: String): Boolean = mimeType.startsWith("image/")

    override fun decodeBitmap(data: ByteArray): ListenableFuture<Bitmap> =
        executor.submit(Callable { BitmapFactory.decodeByteArray(data, 0, data.size) ?: throw IOException("Not an image") })

    override fun loadBitmap(uri: Uri): ListenableFuture<Bitmap> =
        executor.submit(Callable {
            when (uri.scheme) {
                "file" -> return@Callable BitmapFactory.decodeFile(uri.path) ?: throw IOException("Not an image")
                "content" -> return@Callable resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it) } ?: throw IOException("Not an image")
            }
            client.newCall(Request.Builder().url(uri.toString()).build()).execute().use { r ->
                if (!r.isSuccessful) throw IOException("Cover: HTTP ${r.code}")
                val bytes = r.body?.bytes() ?: throw IOException("Cover: empty")
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: throw IOException("Not an image")
            }
        })
}
