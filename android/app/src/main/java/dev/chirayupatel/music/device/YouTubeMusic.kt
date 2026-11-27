package dev.chirayupatel.music.device

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri

/**
 * YouTube and YouTube Music play in Google's own apps, not in this one: there it plays as the
 * person's own account (Premium included), keeps playing with the screen off, and shows on the lock
 * screen. Playing YouTube inside this app would be signed out (Google doesn't let other apps sign
 * in to it), and YouTube's rules stop it the moment this app isn't on screen.
 */
object YouTubeMusic {
    private const val MUSIC_APP = "com.google.android.apps.youtube.music"
    private const val YOUTUBE_APP = "com.google.android.youtube"

    /** Where a track (or, without one, the album or playlist) plays in YouTube Music. */
    fun url(openUrl: String?, videoId: String?): String? {
        val list = openUrl?.let { Uri.parse(it).getQueryParameter("list") }
        return when {
            videoId != null -> "https://music.youtube.com/watch?v=${Uri.encode(videoId)}" + (list?.let { "&list=${Uri.encode(it)}" } ?: "")
            else -> openUrl
        }
    }

    /** Open it in the YouTube Music app, else the YouTube app, else the browser. False if nothing could. */
    fun open(context: Context, url: String): Boolean {
        val music = Uri.parse(url)
        val youtube = music.buildUpon().authority("www.youtube.com").build().let { u ->   // the YouTube app's own addresses
            if (u.getQueryParameter("list") == "LM") Uri.parse(u.toString().replace("list=LM", "list=LL")) else u   // liked music -> liked videos
        }
        for ((uri, pkg) in listOf(music to MUSIC_APP, youtube to YOUTUBE_APP, music to null)) {
            val intent = Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            if (pkg != null) intent.setPackage(pkg)
            try { context.startActivity(intent); return true } catch (_: ActivityNotFoundException) {}
        }
        return false
    }
}
