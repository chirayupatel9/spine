package dev.chirayupatel.music.ui

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import coil3.compose.AsyncImage
import dev.chirayupatel.music.device.PhoneMusic

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AlbumSheet(vm: AppViewModel) {
    val a = vm.sheet ?: return
    val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val mine = vm.nowAlbumId == a.id
    val multiDisc = a.trackList.map { it.discNo ?: 1 }.toSet().size > 1
    ModalBottomSheet(
        onDismissRequest = { vm.sheet = null }, sheetState = state,
        containerColor = Palette.Card, contentColor = Palette.Ink, scrimColor = Color.Black.copy(alpha = .6f),
    ) {
        LazyColumn(contentPadding = PaddingValues(start = 22.dp, end = 22.dp, bottom = 28.dp)) {
            item {
                Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                    AsyncImage(
                        model = vm.artUrl(a.art), contentDescription = null, contentScale = ContentScale.Crop,
                        modifier = Modifier.fillMaxWidth(.66f).widthIn(max = 320.dp).aspectRatio(1f)
                            .shadow(16.dp, RoundedCornerShape(2.dp)).clip(RoundedCornerShape(2.dp)).background(parseColor(a.color)),
                    )
                    Text(
                        when {
                            a.source == "youtube" && a.id.startsWith("yl_") -> "LIKED MUSIC · YOUTUBE"
                            a.source == "youtube" && a.id.startsWith("yv_") -> "YOUTUBE"
                            a.source == "youtube" && a.kind == "playlist" -> "YOUTUBE PLAYLIST"
                            a.source == "youtube" -> "YOUTUBE MUSIC ALBUM"
                            a.kind == "playlist" -> "SPOTIFY PLAYLIST"
                            a.source == "spotify" -> "SPOTIFY"
                            a.source == "demo" -> "DEMO SHELF · 30-SECOND PREVIEWS"
                            a.source == "device" -> "ON THIS PHONE"
                            else -> "MUSIC FOLDER"
                        },
                        color = Palette.Accent, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, letterSpacing = .18.em,
                        modifier = Modifier.padding(top = 20.dp),
                    )
                    Text(a.title, color = Palette.Ink, fontFamily = FontFamily.Serif, fontSize = 26.sp, lineHeight = 1.15.em, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 6.dp))
                    val by = if (a.kind == "playlist") a.tracks?.let { "$it songs" }.orEmpty() else a.artist + (a.year?.let { " · $it" } ?: "")
                    Text(by, color = Palette.Muted, fontSize = 15.sp, modifier = Modifier.padding(top = 4.dp, bottom = 18.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        PrimaryButton(if (mine && vm.isPlaying) "Pause" else if (mine) "Resume" else "Play") {
                            if (mine) vm.toggle() else { vm.openId = a.id; vm.play(a.id) }
                        }
                        GhostButton("Shuffle") { vm.openId = a.id; vm.play(a.id, shuffle = true) }
                        if (vm.openId == a.id) GhostButton("Put back") { vm.putBack() }
                    }
                    if (a.source == "youtube") Text(
                        "Plays in the YouTube Music app, as your YouTube account.",
                        color = Palette.Faint, fontSize = 13.sp, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 12.dp),
                    )
                    HorizontalDivider(color = Palette.Line, modifier = Modifier.padding(top = 20.dp))
                    if (a.kind == "playlist" && !a.tracksShared) Text(
                        "Spotify shares the tracks of a playlist only with its owner and collaborators. Press Play to hear it.",
                        color = Palette.Muted, fontSize = 14.sp, modifier = Modifier.padding(top = 16.dp),
                    )
                }
            }
            itemsIndexed(a.trackList, key = { _, t -> t.id }) { i, t ->
                val now = vm.nowTrackId == t.id
                Row(
                    Modifier.fillMaxWidth().heightIn(min = 52.dp).clickable { vm.openId = a.id; vm.play(a.id, i) }.padding(horizontal = 4.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    Text(
                        (if (multiDisc) "${t.discNo ?: 1}." else "") + (t.trackNo ?: (i + 1)),
                        color = if (now) Palette.Accent else Palette.Faint, fontSize = 14.sp, textAlign = TextAlign.End, modifier = Modifier.width(28.dp),
                    )
                    Text(t.title, color = if (now) Palette.Accent else Palette.Ink, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    Text(fmt(((t.duration ?: 0.0) * 1000).toLong()), color = Palette.Faint, fontSize = 13.sp)
                }
                HorizontalDivider(color = Palette.Line)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsSheet(vm: AppViewModel) {
    if (!vm.showSettings) return
    val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val context = LocalContext.current
    val askForMusic = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        if (ok) vm.enablePhoneMusic() else vm.message = "Album Viewer needs to see your music to show it"
    }
    ModalBottomSheet(
        onDismissRequest = { vm.showSettings = false }, sheetState = state,
        containerColor = Palette.Card, contentColor = Palette.Ink, scrimColor = Color.Black.copy(alpha = .6f),
    ) {
        Column(Modifier.fillMaxWidth().padding(start = 24.dp, end = 24.dp, bottom = 32.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("Settings", fontFamily = FontFamily.Serif, fontSize = 28.sp, color = Palette.Ink)
            val me = vm.me
            Section("Account") {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    if (!me?.picture.isNullOrEmpty()) AsyncImage(
                        model = me?.picture, contentDescription = null, contentScale = ContentScale.Crop,
                        modifier = Modifier.size(44.dp).clip(CircleShape).background(Palette.Field),
                    )
                    Column(Modifier.weight(1f)) {
                        Text(me?.name?.ifBlank { null } ?: me?.email?.ifBlank { null } ?: "Signed in", color = Palette.Ink, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        val detail = listOfNotNull(me?.email?.ifBlank { null }, if (me?.admin == true) "runs this server" else null).joinToString(" · ")
                        if (detail.isNotEmpty()) Text(detail, color = Palette.Muted, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    GhostButton("Sign out") { vm.signOut() }
                }
            }
            val sp = me?.spotify ?: vm.status?.spotify
            Section("Spotify") {
                val mine = vm.albums.filter { it.source == "spotify" }
                Text(
                    when {
                        sp?.configured != true -> "Spotify isn't set up on this server yet."
                        !sp.connected -> "Not connected. Your saved albums and playlists come onto your shelf."
                        else -> "Connected · ${mine.count { it.kind != "playlist" }} albums · ${mine.count { it.kind == "playlist" }} playlists"
                    },
                    color = Palette.Muted, fontSize = 14.sp,
                )
                if (sp?.configured == true && !sp.connected) GhostButton("Connect Spotify", Modifier.padding(top = 10.dp)) { vm.connectSpotify { openInBrowser(context, it) } }
                if (me?.admin == true && sp?.configured == true) Text(   // Spotify lets in only the people the admin adds
                    "Friends can use Spotify here once you add their Spotify account under User Management in your app on the Spotify " +
                        "developer dashboard. While the app is in Spotify's development mode, that's up to 5 people.",
                    color = Palette.Faint, fontSize = 13.sp, modifier = Modifier.padding(top = 10.dp),
                )
            }
            val yt = vm.status?.youtube ?: me?.youtube
            if (yt?.configured == true) Section("YouTube") {
                var sure by remember { mutableStateOf(false) }
                val mine = vm.albums.count { it.source == "youtube" }
                Text(
                    when {
                        yt.syncing -> "Bringing in your playlists…"
                        !yt.connected -> "Not connected. Your YouTube playlists, including the ones you made in YouTube Music, and your liked " +
                            "music come onto your shelf, and play in the YouTube Music app."
                        else -> "Connected" + (yt.channel?.ifBlank { null }?.let { " as $it" } ?: "") + " · $mine on your shelf. They play in the YouTube Music app."
                    },
                    color = Palette.Muted, fontSize = 14.sp,
                )
                if (!yt.connected) {
                    GhostButton("Connect YouTube", Modifier.padding(top = 10.dp)) { vm.connectYouTube { openInBrowser(context, it) } }
                    Text(   // until Google has checked Album Viewer's request to read YouTube
                        "Google will say it hasn't checked Album Viewer yet. Choose Advanced, then Go to ${Uri.parse(vm.server).host}. " +
                            "Album Viewer only reads your YouTube, never changes it.",
                        color = Palette.Faint, fontSize = 13.sp, modifier = Modifier.padding(top = 10.dp),
                    )
                } else GhostButton(if (sure) "Disconnect YouTube?" else "Disconnect", Modifier.padding(top = 10.dp)) {
                    if (sure) vm.disconnectYouTube() else sure = true   // a second tap, so a stray one doesn't empty the shelf
                }
            }
            Section("Music on this phone") {
                Text(
                    if (vm.phoneMusicOn) "${vm.phoneAlbums.size} albums from this phone. Nothing is uploaded."
                    else "Show the music saved on this phone on your shelf. Nothing is uploaded.",
                    color = Palette.Muted, fontSize = 14.sp,
                )
                if (vm.phoneMusicOn) GhostButton("Turn off", Modifier.padding(top = 10.dp)) { vm.disablePhoneMusic() }
                else GhostButton("Show music on this phone", Modifier.padding(top = 10.dp)) {
                    if (vm.phoneAllowed) vm.enablePhoneMusic() else askForMusic.launch(PhoneMusic.PERMISSION)
                }
            }
            val demo = vm.status?.demo
            if (me?.admin == true) Section("Demo shelf") {
                Text(
                    when {
                        demo?.loading == true -> "Loading… ${demo.albums} of ${demo.total} albums"
                        (demo?.albums ?: 0) > 0 -> "${demo?.albums} albums from the iTunes catalogue, with 30-second previews."
                        else -> "Fills the shelf with well-known albums and their previews, so you can try it without an account."
                    },
                    color = Palette.Muted, fontSize = 14.sp,
                )
                if ((demo?.albums ?: 0) == 0 && demo?.loading != true) GhostButton("Load demo shelf", Modifier.padding(top = 10.dp)) { vm.loadDemo() }
            }
            Section("Server") { Text(vm.server, color = Palette.Muted, fontSize = 14.sp) }
        }
    }
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(top = 8.dp)) {
        HorizontalDivider(color = Palette.Line, modifier = Modifier.padding(bottom = 14.dp))
        Text(title.uppercase(), color = Palette.Muted, fontSize = 11.5.sp, fontWeight = FontWeight.SemiBold, letterSpacing = .18.em, modifier = Modifier.padding(bottom = 6.dp))
        Box { Column { content() } }
    }
}
