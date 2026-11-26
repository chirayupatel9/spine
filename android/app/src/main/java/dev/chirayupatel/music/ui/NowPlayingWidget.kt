package dev.chirayupatel.music.ui

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.RectF
import android.net.Uri
import android.widget.RemoteViews
import androidx.core.content.ContextCompat
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import dev.chirayupatel.music.App
import dev.chirayupatel.music.R
import dev.chirayupatel.music.playback.PlaybackService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.Request
import java.io.File
import kotlin.coroutines.resume

/**
 * The home-screen widget: the cover and what's playing, with previous, play/pause and next. The
 * playback service tells it about the music this app plays; the app tells it about Spotify. A tap on
 * the cover or the words opens the app; with nothing playing, so does the play button.
 */
class NowPlayingWidget : AppWidgetProvider() {

    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) = render(context, manager, ids)

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        val action = intent.action ?: return
        if (action !in ACTIONS) return
        val done = goAsync()
        scope.launch {
            try { control(context.applicationContext, action) } catch (_: Exception) {} finally { done.finish() }
        }
    }

    companion object {
        private const val PLAY_PAUSE = "dev.chirayupatel.music.widget.PLAY_PAUSE"
        private const val NEXT = "dev.chirayupatel.music.widget.NEXT"
        private const val PREV = "dev.chirayupatel.music.widget.PREV"
        private val ACTIONS = setOf(PLAY_PAUSE, NEXT, PREV)
        private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

        private fun prefs(ctx: Context) = ctx.getSharedPreferences("widget", Context.MODE_PRIVATE)
        private fun coverFile(ctx: Context) = File(ctx.cacheDir, "widget-cover.png")

        /** What's playing now. `spotify`: it plays in Spotify (the buttons go through the server).
         *  `art`: the cover's address, fetched once and kept small. */
        fun show(ctx: Context, title: String, artist: String, playing: Boolean, spotify: Boolean, art: String?) {
            val app = ctx.applicationContext
            val p = prefs(app)
            val same = p.getString("title", null) == title && p.getString("artist", null) == artist &&
                p.getBoolean("playing", false) == playing && p.getBoolean("spotify", false) == spotify && p.getString("art", null) == art
            if (same) return
            val newArt = p.getString("art", null) != art
            p.edit().putString("title", title).putString("artist", artist).putBoolean("playing", playing)
                .putBoolean("spotify", spotify).putString("art", art).apply()
            if (!newArt) { render(app); return }
            coverFile(app).delete()
            render(app)   // the words at once; the cover as soon as it's here
            if (art.isNullOrEmpty()) return
            scope.launch {
                val bmp = withContext(Dispatchers.IO) { runCatching { loadCover(app, art) }.getOrNull() } ?: return@launch
                if (prefs(app).getString("art", null) != art) return@launch   // something else is playing by now
                withContext(Dispatchers.IO) { coverFile(app).outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) } }
                render(app)
            }
        }

        /** Nothing playing any more. */
        fun clear(ctx: Context) {
            val app = ctx.applicationContext
            prefs(app).edit().clear().apply()
            coverFile(app).delete()
            render(app)
        }

        private fun render(
            ctx: Context,
            manager: AppWidgetManager = AppWidgetManager.getInstance(ctx),
            ids: IntArray = manager.getAppWidgetIds(ComponentName(ctx, NowPlayingWidget::class.java)),
        ) {
            if (ids.isEmpty()) return
            val p = prefs(ctx)
            val title = p.getString("title", null)
            val playing = p.getBoolean("playing", false)
            val v = RemoteViews(ctx.packageName, R.layout.widget_now_playing)
            val open = PendingIntent.getActivity(
                ctx, 0, Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            v.setOnClickPendingIntent(R.id.widget_cover, open)
            v.setOnClickPendingIntent(R.id.widget_text, open)
            if (title == null) {   // nothing playing: the app's name, and play opens the app
                v.setTextViewText(R.id.widget_title, ctx.getString(R.string.app_name))
                v.setTextViewText(R.id.widget_artist, ctx.getString(R.string.widget_idle))
                v.setImageViewResource(R.id.widget_cover, R.drawable.widget_cover_empty)
                v.setImageViewResource(R.id.widget_play, R.drawable.ic_w_play)
                v.setOnClickPendingIntent(R.id.widget_play, open)
                v.setOnClickPendingIntent(R.id.widget_prev, open)
                v.setOnClickPendingIntent(R.id.widget_next, open)
            } else {
                v.setTextViewText(R.id.widget_title, title)
                v.setTextViewText(R.id.widget_artist, p.getString("artist", "").orEmpty())
                val cover = coverFile(ctx).takeIf { it.exists() }?.let { BitmapFactory.decodeFile(it.path) }
                if (cover != null) v.setImageViewBitmap(R.id.widget_cover, cover) else v.setImageViewResource(R.id.widget_cover, R.drawable.widget_cover_empty)
                v.setImageViewResource(R.id.widget_play, if (playing) R.drawable.ic_w_pause else R.drawable.ic_w_play)
                v.setContentDescription(R.id.widget_play, ctx.getString(if (playing) R.string.widget_pause else R.string.widget_play))
                v.setOnClickPendingIntent(R.id.widget_play, action(ctx, PLAY_PAUSE))
                v.setOnClickPendingIntent(R.id.widget_prev, action(ctx, PREV))
                v.setOnClickPendingIntent(R.id.widget_next, action(ctx, NEXT))
            }
            manager.updateAppWidget(ids, v)
        }

        private fun action(ctx: Context, what: String) = PendingIntent.getBroadcast(
            ctx, what.hashCode(), Intent(ctx, NowPlayingWidget::class.java).setAction(what),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        /** A button on the widget: to Spotify through the server, or to this app's player. */
        private suspend fun control(ctx: Context, what: String) {
            val p = prefs(ctx)
            val playing = p.getBoolean("playing", false)
            if (what == PLAY_PAUSE) { p.edit().putBoolean("playing", !playing).apply(); render(ctx) }   // answer the tap at once
            if (p.getBoolean("spotify", false)) {
                val api = (ctx as App).api
                api.spotifyControl(when (what) { PLAY_PAUSE -> if (playing) "pause" else "resume"; NEXT -> "next"; else -> "previous" })
                return
            }
            val future = MediaController.Builder(ctx, SessionToken(ctx, ComponentName(ctx, PlaybackService::class.java))).buildAsync()
            val c = suspendCancellableCoroutine<MediaController?> { cont ->
                future.addListener({ cont.resume(runCatching { future.get() }.getOrNull()) }, ContextCompat.getMainExecutor(ctx))
            } ?: return
            try {
                when (what) {
                    PLAY_PAUSE -> if (c.isPlaying) c.pause() else { if (c.playbackState == Player.STATE_IDLE) c.prepare(); c.play() }
                    NEXT -> c.seekToNextMediaItem()
                    else -> c.seekToPrevious()
                }
                delay(800)   // let the player take the command before letting go
            } finally {
                MediaController.releaseFuture(future)
            }
        }

        /** The cover, small and with rounded corners: from the server (signed in), the phone, or the web. */
        private fun loadCover(ctx: Context, art: String): Bitmap? {
            val uri = Uri.parse(art)
            val raw: Bitmap = when (uri.scheme) {
                "file" -> BitmapFactory.decodeFile(uri.path)
                "content" -> ctx.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it) }
                else -> (ctx as App).api.client.newCall(Request.Builder().url(art).build()).execute().use { r ->
                    if (!r.isSuccessful) null else r.body?.bytes()?.let { BitmapFactory.decodeByteArray(it, 0, it.size) }
                }
            } ?: return null
            val px = (52 * ctx.resources.displayMetrics.density).toInt().coerceIn(96, 220)
            val out = Bitmap.createBitmap(px, px, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(out)
            val paint = Paint(Paint.ANTI_ALIAS_FLAG)
            val r = 8 * ctx.resources.displayMetrics.density
            canvas.drawRoundRect(RectF(0f, 0f, px.toFloat(), px.toFloat()), r, r, paint)
            paint.xfermode = PorterDuffXfermode(PorterDuff.Mode.SRC_IN)
            val side = minOf(raw.width, raw.height)
            val src = android.graphics.Rect((raw.width - side) / 2, (raw.height - side) / 2, (raw.width + side) / 2, (raw.height + side) / 2)
            canvas.drawBitmap(raw, src, RectF(0f, 0f, px.toFloat(), px.toFloat()), paint)
            return out
        }
    }
}
