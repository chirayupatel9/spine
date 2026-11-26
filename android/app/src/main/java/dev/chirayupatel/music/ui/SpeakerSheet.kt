package dev.chirayupatel.music.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.chirayupatel.music.device.Speakers

/**
 * Play on: your Spotify speakers, with this phone first. What's playing now is in the accent colour
 * with a tick. If Spotify isn't open on this phone, its row opens Spotify, and the music starts here
 * once you're back.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SpeakerSheet(vm: AppViewModel) {
    if (!vm.speakerSheet) return
    val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val ctx = LocalContext.current
    val phone = vm.phoneDevice
    val now = if (vm.spotifyMode) vm.nowDeviceId else null
    ModalBottomSheet(
        onDismissRequest = { vm.closeSpeakers() }, sheetState = state,
        containerColor = Palette.Card, contentColor = Palette.Ink, scrimColor = Color.Black.copy(alpha = .6f),
    ) {
        Column(Modifier.fillMaxWidth().padding(start = 14.dp, end = 14.dp, bottom = 28.dp)) {
            Text("Play on", fontFamily = FontFamily.Serif, fontSize = 28.sp, color = Palette.Ink, modifier = Modifier.padding(start = 10.dp, bottom = 10.dp))
            if (phone != null) {
                SpeakerRow(AvIcons.Phone, "This phone", "Spotify app · ${phone.name}", on = phone.id == now) { vm.chooseSpeaker(phone) }
            } else if (Speakers.spotifyInstalled(ctx)) {
                SpeakerRow(AvIcons.Phone, "This phone", "Spotify isn't open here. Tap to open it, then come back.", on = false) { vm.openSpotifyHere() }
            } else {
                SpeakerRow(AvIcons.Phone, "This phone", "Install Spotify on this phone to play Spotify here", on = false, enabled = false) {}
            }
            val others = vm.spotifyDevices.filter { it.id != phone?.id }.sortedWith(compareByDescending<dev.chirayupatel.music.net.SpotifyDevice> { it.isActive }.thenBy { it.name.lowercase() })
            for (d in others) {
                val type = when (d.type) { "Smartphone" -> "Phone"; "CastAudio" -> "Speaker"; "CastVideo" -> "TV"; else -> d.type }
                SpeakerRow(AvIcons.forKind(Speakers.kindOf(d.type)), d.name, type, on = d.id == now) { vm.chooseSpeaker(d) }
            }
            Text(
                when {
                    vm.devicesLoading && vm.spotifyDevices.isEmpty() -> "Looking for speakers…"
                    others.isEmpty() -> "Your other Spotify speakers show up here when Spotify is open on them."
                    else -> "Don't see a speaker? Open Spotify on it, then refresh."
                },
                color = Palette.Muted, fontSize = 13.sp, modifier = Modifier.padding(start = 10.dp, end = 10.dp, top = 12.dp),
            )
            GhostButton("Refresh", Modifier.padding(start = 10.dp, top = 14.dp)) { vm.refreshDevices() }
        }
    }
}

@Composable
private fun SpeakerRow(icon: ImageVector, name: String, sub: String, on: Boolean, enabled: Boolean = true, onClick: () -> Unit) {
    val ink = if (on) Palette.Accent else Palette.Ink
    val faint = if (on) Palette.Accent else Palette.Muted
    Row(
        Modifier.fillMaxWidth().heightIn(min = 60.dp).clip(RoundedCornerShape(12.dp))
            .then(if (enabled) Modifier.clickable(onClick = onClick) else Modifier)
            .background(if (on) Palette.Accent.copy(alpha = .08f) else Color.Transparent)
            .padding(horizontal = 12.dp, vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Icon(icon, null, tint = if (on) Palette.Accent else Palette.Muted, modifier = Modifier.size(26.dp))
        Column(Modifier.weight(1f)) {
            Text(name, color = ink, fontSize = 15.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(sub, color = faint, fontSize = 12.5.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        if (on) Icon(AvIcons.Check, "Playing here", tint = Palette.Accent, modifier = Modifier.size(22.dp))
    }
}
