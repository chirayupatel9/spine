package dev.chirayupatel.music.device

import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.MediaRouter2
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.annotation.RequiresApi
import dev.chirayupatel.music.net.SpotifyDevice

/**
 * Where the music comes out. Music from your library plays in this app, through whatever the phone
 * plays sound through (its speaker, or Bluetooth or wired headphones and speakers); Android's own
 * output switcher moves it. Spotify plays in the Spotify app, which is one of your Spotify speakers
 * (Spotify Connect) alongside computers, smart speakers and TVs.
 */
object Speakers {
    enum class Kind { PHONE, HEADPHONES, SPEAKER, COMPUTER, TV }

    /** What the phone plays through now. */
    data class Output(val name: String, val kind: Kind)

    const val SPOTIFY = "com.spotify.music"

    private val HEADPHONES = setOf(
        AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_USB_HEADSET, AudioDeviceInfo.TYPE_HEARING_AID,
        26, // TYPE_BLE_HEADSET (Android 12)
    )
    private val SPEAKERS = setOf(
        AudioDeviceInfo.TYPE_USB_DEVICE, AudioDeviceInfo.TYPE_USB_ACCESSORY, AudioDeviceInfo.TYPE_LINE_ANALOG, AudioDeviceInfo.TYPE_LINE_DIGITAL,
        AudioDeviceInfo.TYPE_DOCK, 27, // TYPE_BLE_SPEAKER (Android 12)
    )
    private val SCREENS = setOf(AudioDeviceInfo.TYPE_HDMI, AudioDeviceInfo.TYPE_HDMI_ARC, 29 /* TYPE_HDMI_EARC */)

    private val media: AudioAttributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build()

    fun current(ctx: Context): Output {
        val am = ctx.getSystemService(AudioManager::class.java) ?: return Output("This phone", Kind.PHONE)
        val dev: AudioDeviceInfo? = if (Build.VERSION.SDK_INT >= 33) Api33.mediaOutput(am, media) else {   // before Android 13 there's no asking where media goes; the newest connection takes it
            am.getDevices(AudioManager.GET_DEVICES_OUTPUTS).lastOrNull { it.type in HEADPHONES || it.type in SPEAKERS || it.type in SCREENS }
        }
        if (dev == null || dev.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER || dev.type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE) {
            return Output("This phone", Kind.PHONE)
        }
        val kind = when (dev.type) { in HEADPHONES -> Kind.HEADPHONES; in SCREENS -> Kind.TV; else -> Kind.SPEAKER }
        val name = dev.productName?.toString()?.trim().orEmpty()
        val fallback = when (dev.type) {
            AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "Wired headphones"
            in SCREENS -> "TV"
            else -> "Headphones"
        }
        return Output(if (name.isEmpty() || name.equals(Build.MODEL, ignoreCase = true)) fallback else name, kind)
    }

    /** Calls `changed` whenever headphones or speakers come and go. Returns how to stop. */
    fun watch(ctx: Context, changed: () -> Unit): () -> Unit {
        val am = ctx.getSystemService(AudioManager::class.java) ?: return {}
        val cb = object : AudioDeviceCallback() {
            override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>?) = changed()
            override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>?) = changed()
        }
        am.registerAudioDeviceCallback(cb, Handler(Looper.getMainLooper()))
        return { am.unregisterAudioDeviceCallback(cb) }
    }

    /**
     * Android's own list of outputs for this app (Bluetooth, the phone's speaker, cast devices),
     * opened the way AndroidX MediaRouter opens it on each version. False if there's none.
     */
    fun showSwitcher(ctx: Context): Boolean {
        if (Build.VERSION.SDK_INT >= 34 && Api34.showSwitcher(ctx)) return true
        if (Build.VERSION.SDK_INT >= 31) {
            val i = Intent("com.android.systemui.action.LAUNCH_MEDIA_OUTPUT_DIALOG")
                .setPackage("com.android.systemui").putExtra("package_name", ctx.packageName)
            val system = runCatching { ctx.packageManager.queryBroadcastReceivers(i, 0) }.getOrDefault(emptyList())
                .any { (it.activityInfo?.applicationInfo?.flags ?: 0) and ApplicationInfo.FLAG_SYSTEM != 0 }
            if (system && runCatching { ctx.sendBroadcast(i) }.isSuccess) return true
        }
        if (Build.VERSION.SDK_INT >= 30) {
            val i = Intent("com.android.settings.panel.action.MEDIA_OUTPUT")
                .putExtra("com.android.settings.panel.extra.PACKAGE_NAME", ctx.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            if (runCatching { ctx.startActivity(i) }.isSuccess) return true
        }
        return runCatching { ctx.startActivity(Intent(Settings.ACTION_BLUETOOTH_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }.isSuccess
    }

    /* ------------------------------------------------ Spotify on this phone */

    /** What Spotify calls this phone: its model by default, or the name it was given. */
    private fun names(ctx: Context): Set<String> = listOfNotNull(
        Build.MODEL, "${Build.MANUFACTURER} ${Build.MODEL}",
        if (Build.VERSION.SDK_INT >= 25) runCatching { Settings.Global.getString(ctx.contentResolver, Settings.Global.DEVICE_NAME) }.getOrNull() else null,
        runCatching { Settings.Secure.getString(ctx.contentResolver, "bluetooth_name") }.getOrNull(),
    ).map { it.trim().lowercase() }.filter { it.isNotEmpty() }.toSet()

    private fun isPhoneType(type: String?) = type.equals("Smartphone", true) || type.equals("Tablet", true)

    /** Whether a Spotify speaker is this phone's Spotify app, by its name. */
    fun isThisPhone(ctx: Context, name: String?, type: String?): Boolean =
        isPhoneType(type) && name != null && name.trim().lowercase() in names(ctx)

    /** This phone's Spotify app among the speakers: by its name, or the only phone there. */
    fun thisPhone(ctx: Context, devices: List<SpotifyDevice>): SpotifyDevice? {
        val phones = devices.filter { isPhoneType(it.type) }
        return phones.firstOrNull { isThisPhone(ctx, it.name, it.type) } ?: phones.singleOrNull()
    }

    fun spotifyInstalled(ctx: Context): Boolean = ctx.packageManager.getLaunchIntentForPackage(SPOTIFY) != null

    /** Open the Spotify app, so this phone shows up as one of your Spotify speakers. */
    fun openSpotify(ctx: Context): Boolean {
        val i = ctx.packageManager.getLaunchIntentForPackage(SPOTIFY) ?: return false
        return runCatching { ctx.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }.isSuccess
    }

    fun kindOf(spotifyType: String?): Kind = when (spotifyType) {
        "Computer" -> Kind.COMPUTER
        "Smartphone", "Tablet" -> Kind.PHONE
        "TV", "CastVideo", "GameConsole", "STB" -> Kind.TV
        else -> Kind.SPEAKER
    }

    @RequiresApi(33)
    private object Api33 {
        fun mediaOutput(am: AudioManager, media: AudioAttributes): AudioDeviceInfo? =
            runCatching { am.getAudioDevicesForAttributes(media).firstOrNull() }.getOrNull()
    }

    @RequiresApi(34)
    private object Api34 {
        fun showSwitcher(ctx: Context): Boolean = runCatching { MediaRouter2.getInstance(ctx).showSystemOutputSwitcher() }.getOrDefault(false)
    }
}
