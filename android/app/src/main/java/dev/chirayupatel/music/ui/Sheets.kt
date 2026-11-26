package dev.chirayupatel.music.ui

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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import coil3.compose.AsyncImage

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
                        when (a.source) { "spotify" -> "SPOTIFY"; "demo" -> "DEMO SHELF · 30-SECOND PREVIEWS"; else -> "LOCAL LIBRARY" },
                        color = Palette.Accent, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, letterSpacing = .18.em,
                        modifier = Modifier.padding(top = 20.dp),
                    )
                    Text(a.title, color = Palette.Ink, fontFamily = FontFamily.Serif, fontSize = 26.sp, lineHeight = 1.15.em, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 6.dp))
                    Text(a.artist + (a.year?.let { " · $it" } ?: ""), color = Palette.Muted, fontSize = 15.sp, modifier = Modifier.padding(top = 4.dp, bottom = 18.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        PrimaryButton(if (mine && vm.isPlaying) "Pause" else if (mine) "Resume" else "Play") {
                            if (mine) vm.toggle() else { vm.openId = a.id; vm.play(a.id) }
                        }
                        GhostButton("Shuffle") { vm.openId = a.id; vm.play(a.id, shuffle = true) }
                        if (vm.openId == a.id) GhostButton("Put back") { vm.putBack() }
                    }
                    HorizontalDivider(color = Palette.Line, modifier = Modifier.padding(top = 20.dp))
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
    ModalBottomSheet(
        onDismissRequest = { vm.showSettings = false }, sheetState = state,
        containerColor = Palette.Card, contentColor = Palette.Ink, scrimColor = Color.Black.copy(alpha = .6f),
    ) {
        Column(Modifier.fillMaxWidth().padding(start = 24.dp, end = 24.dp, bottom = 32.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("Settings", fontFamily = FontFamily.Serif, fontSize = 28.sp, color = Palette.Ink)
            Section("Server") { Text(vm.server, color = Palette.Muted, fontSize = 14.sp) }
            val demo = vm.status?.demo
            Section("Demo shelf") {
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
            Section("This device") {
                Text("Signed in. Sign out to forget the password on this phone or tablet.", color = Palette.Muted, fontSize = 14.sp)
                GhostButton("Sign out", Modifier.padding(top = 10.dp)) { vm.signOut() }
            }
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
