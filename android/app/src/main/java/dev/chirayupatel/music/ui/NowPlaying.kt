package dev.chirayupatel.music.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.basicMarquee
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.Velocity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.min
import androidx.compose.ui.unit.sp
import androidx.media3.common.Player
import coil3.compose.AsyncImage
import kotlinx.coroutines.delay
import kotlin.math.abs
import kotlin.math.max

/**
 * The full-screen player. It rises from the player bar (tap it, or swipe it up) and goes back down
 * with the chevron, Back, or a swipe down from the top. The cover sits in front of its record,
 * which slides out of the sleeve once the screen is up and turns while the music plays.
 */
@Composable
fun NowPlaying(vm: AppViewModel) {
    BackHandler(vm.showPlayer) { vm.showPlayer = false }
    AnimatedVisibility(
        visible = vm.showPlayer && vm.nowTitle.isNotEmpty(),
        enter = slideInVertically(tween(460, easing = OpenEasing)) { it },
        exit = slideOutVertically(tween(280, easing = OutEasing)) { it },
    ) { NowPlayingScreen(vm) }
}

@Composable
private fun NowPlayingScreen(vm: AppViewModel) {
    val album = vm.albums.firstOrNull { it.id == vm.nowAlbumId }
    val tint by animateColorAsState(parseColor(album?.color, Color(0xFF2A2622)), tween(700), label = "tint")
    val density = LocalDensity.current
    val scroll = rememberScrollState()
    var pull by remember { mutableFloatStateOf(0f) }   // how far it has been pulled down
    val closeAt = with(density) { 140.dp.toPx() }
    // Pulling down from the top moves the whole screen; let go far or fast enough and it closes.
    val connection = remember {
        object : NestedScrollConnection {
            override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
                if (pull > 0f && available.y < 0f) { val used = max(available.y, -pull); pull += used; return Offset(0f, used) }
                return Offset.Zero
            }
            override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset {
                if (available.y > 0f && source == NestedScrollSource.UserInput) { pull += available.y; return Offset(0f, available.y) }
                return Offset.Zero
            }
            override suspend fun onPreFling(available: Velocity): Velocity {
                if (pull <= 0f) return Velocity.Zero
                if (pull > closeAt || available.y > 1600f) vm.showPlayer = false
                else animate(pull, 0f, animationSpec = spring(dampingRatio = .85f, stiffness = 600f)) { v, _ -> pull = v }
                return available
            }
        }
    }

    BoxWithConstraints(
        Modifier.fillMaxSize()
            .graphicsLayer { translationY = pull }
            .background(Palette.Bg)
            .drawBehind {
                val r = max(size.width, size.height)
                if (r < 1f) return@drawBehind
                drawRect(
                    Brush.radialGradient(
                        0f to lerp(Palette.Bg, tint, .58f), .52f to lerp(Palette.Bg, tint, .2f), .88f to Palette.Bg,
                        center = Offset(size.width / 2, 0f), radius = r * .95f,
                    ),
                )
                drawRect(Brush.verticalGradient(0f to Color.Black.copy(alpha = .22f), .18f to Color.Transparent))
            }
            .pointerInput(Unit) { detectTapGestures { } }   // nothing falls through to the shelf beneath
            .nestedScroll(connection),
    ) {
        val wide = maxWidth > maxHeight && maxWidth >= 600.dp
        val cs = if (wide) min(min(maxWidth * .38f, maxHeight * .62f), 520.dp) else min(min((maxWidth - 40.dp) / 1.25f, maxHeight * .44f), 400.dp)
        Column(
            Modifier.fillMaxSize().verticalScroll(scroll).windowInsetsPadding(WindowInsets.safeDrawing).padding(horizontal = 20.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Header(vm, album?.title ?: "")
            if (wide) {
                Row(Modifier.padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(56.dp)) {
                    Stage(vm, cs, tint)
                    Column(Modifier.width(380.dp)) { Controls(vm); UpNext(vm) }
                }
            } else {
                Spacer(Modifier.height(18.dp))
                Stage(vm, cs, tint)
                Spacer(Modifier.height(30.dp))
                Column(Modifier.widthIn(max = 440.dp).fillMaxWidth()) { Controls(vm); UpNext(vm) }
                Spacer(Modifier.height(24.dp))
            }
        }
    }
}

@Composable
private fun Header(vm: AppViewModel, from: String) {
    Row(Modifier.fillMaxWidth().height(56.dp), verticalAlignment = Alignment.CenterVertically) {
        IconButton(AvIcons.Down, "Close", tint = Palette.Ink, size = 48.dp, iconSize = 26.dp) { vm.showPlayer = false }
        Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
            Text("PLAYING FROM", color = Palette.Muted, fontSize = 10.5.sp, fontWeight = FontWeight.SemiBold, letterSpacing = .18.em)
            Text(from, color = Palette.Ink, fontSize = 13.5.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        IconButton(AvIcons.List, "Album and tracks", tint = Palette.Ink, size = 48.dp, iconSize = 24.dp) { vm.nowAlbumId?.let { vm.openSheet(it) } }
    }
}

/** The cover in front of its record. Once the screen is up, the record slides out to the right. */
@Composable
private fun Stage(vm: AppViewModel, cs: Dp, tint: Color) {
    var out by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { delay(220); out = true }
    val f by animateFloatAsState(if (out) 1f else 0f, tween(620, easing = OpenEasing), label = "out")
    Box(Modifier.size(width = cs * 1.25f, height = cs)) {
        Vinyl(
            vm.nowArt, tint, spinning = out && vm.isPlaying, onTap = vm::toggle,
            modifier = Modifier.offset(cs * .03f, cs * .03f).size(cs * .94f).graphicsLayer { translationX = (cs * (.125f + .125f * f)).toPx() },
        )
        AsyncImage(
            model = vm.nowArt, contentDescription = null, contentScale = ContentScale.Crop,
            modifier = Modifier.size(cs).graphicsLayer { translationX = (cs * .125f * (1f - f)).toPx() }
                .shadow(28.dp, RoundedCornerShape(4.dp)).clip(RoundedCornerShape(4.dp)).background(tint),
        )
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun Controls(vm: AppViewModel) {
    Text(
        vm.nowTitle, color = Palette.Ink, fontFamily = FontFamily.Serif, fontSize = 26.sp, maxLines = 1,
        modifier = Modifier.fillMaxWidth().basicMarquee(iterations = Int.MAX_VALUE, initialDelayMillis = 2000),
    )
    Text(vm.nowArtist, color = Palette.Muted, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp))
    SeekBar(vm)
    Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
        Toggle(AvIcons.Shuffle, if (vm.shuffleOn) "Shuffle is on" else "Shuffle", on = vm.shuffleOn) { vm.toggleShuffle() }
        IconButton(AvIcons.Prev, "Previous", tint = Palette.Ink, size = 56.dp, iconSize = 30.dp) { vm.prev() }
        Box(
            Modifier.size(72.dp).shadow(12.dp, CircleShape).clip(CircleShape).background(Color.White).clickable { vm.toggle() },
            contentAlignment = Alignment.Center,
        ) { Icon(if (vm.isPlaying) AvIcons.Pause else AvIcons.Play, if (vm.isPlaying) "Pause" else "Play", tint = Color(0xFF111111), modifier = Modifier.size(32.dp)) }
        IconButton(AvIcons.Next, "Next", tint = Palette.Ink, size = 56.dp, iconSize = 30.dp) { vm.next() }
        val rep = vm.repeatMode
        Toggle(
            AvIcons.Repeat, when (rep) { Player.REPEAT_MODE_ALL -> "Repeating the album"; Player.REPEAT_MODE_ONE -> "Repeating this track"; else -> "Repeat" },
            on = rep != Player.REPEAT_MODE_OFF, one = rep == Player.REPEAT_MODE_ONE,
        ) { vm.cycleRepeat() }
    }
}

/** Shuffle and repeat: lit in the accent colour with a dot beneath when on ("1" for one track). */
@Composable
private fun Toggle(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, on: Boolean, one: Boolean = false, onClick: () -> Unit) {
    Box(Modifier.size(52.dp).clip(CircleShape).clickable(onClick = onClick), contentAlignment = Alignment.Center) {
        Icon(icon, label, tint = if (on) Palette.Accent else Palette.Muted, modifier = Modifier.size(24.dp))
        if (on) Box(Modifier.align(Alignment.BottomCenter).padding(bottom = 6.dp).size(4.dp).background(Palette.Accent, CircleShape))
        if (one) Box(
            Modifier.align(Alignment.TopEnd).padding(top = 9.dp, end = 8.dp).size(14.dp).background(Palette.Accent, CircleShape),
            contentAlignment = Alignment.Center,
        ) { Text("1", color = Color.White, fontSize = 9.sp, fontWeight = FontWeight.Bold) }
    }
}

/** Drag along it (or tap) to move through the track; it moves when you let go. */
@Composable
private fun SeekBar(vm: AppViewModel) {
    var preview by remember { mutableStateOf<Float?>(null) }
    val canSeek = vm.duration > 0
    val real = if (vm.duration > 0) (vm.position.toFloat() / vm.duration).coerceIn(0f, 1f) else 0f
    val shown = remember { Animatable(real) }
    LaunchedEffect(real) {   // glide between the twice-a-second updates; jump on a seek or a new track
        if (real < shown.value || abs(real - shown.value) > .05f) shown.snapTo(real)
        else shown.animateTo(real, tween(500, easing = LinearEasing))
    }
    val f = preview ?: shown.value
    val grow by animateFloatAsState(if (preview != null) 1.25f else 1f, tween(160, easing = OutEasing), label = "thumb")
    Box(
        Modifier.fillMaxWidth().padding(top = 14.dp).height(32.dp)
            .pointerInput(canSeek) { if (canSeek) detectTapGestures { vm.seekTo((it.x / size.width).coerceIn(0f, 1f)) } }
            .pointerInput(canSeek) {
                if (canSeek) detectHorizontalDragGestures(
                    onDragStart = { preview = (it.x / size.width).coerceIn(0f, 1f) },
                    onDragEnd = { preview?.let(vm::seekTo); preview = null },
                    onDragCancel = { preview = null },
                ) { change, _ -> preview = (change.position.x / size.width).coerceIn(0f, 1f); change.consume() }
            }
            .drawBehind {
                val y = size.height / 2
                val h = 4.dp.toPx()
                drawRoundRect(Color.White.copy(alpha = .18f), Offset(0f, y - h / 2), androidx.compose.ui.geometry.Size(size.width, h), androidx.compose.ui.geometry.CornerRadius(h / 2))
                drawRoundRect(Color.White.copy(alpha = .9f), Offset(0f, y - h / 2), androidx.compose.ui.geometry.Size(size.width * f, h), androidx.compose.ui.geometry.CornerRadius(h / 2))
                if (canSeek) drawCircle(Color.White, 7.dp.toPx() * grow, Offset(size.width * f, y))
            },
    )
    Row(Modifier.fillMaxWidth()) {
        Text(fmt(((preview ?: real) * vm.duration).toLong()), color = Palette.Muted, fontSize = 11.5.sp)
        Spacer(Modifier.weight(1f))
        Text(fmt(vm.duration), color = Palette.Muted, fontSize = 11.5.sp)
    }
}

@Composable
private fun UpNext(vm: AppViewModel) {
    val q = vm.upNext
    if (q.isEmpty()) return
    Box(Modifier.fillMaxWidth().padding(top = 26.dp).height(1.dp).background(Palette.Line))
    Text("UP NEXT", color = Palette.Muted, fontSize = 11.5.sp, fontWeight = FontWeight.SemiBold, letterSpacing = .18.em, modifier = Modifier.padding(top = 16.dp, bottom = 4.dp))
    for (t in q) {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 50.dp).clickable { vm.playQueueItem(t.index) }.padding(horizontal = 4.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text("${t.number}", color = Palette.Faint, fontSize = 14.sp, modifier = Modifier.width(22.dp))
            Text(t.title, color = Palette.Ink, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            if (t.durationMs > 0) Text(fmt(t.durationMs), color = Palette.Faint, fontSize = 12.5.sp)
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(Palette.Line))
    }
}
