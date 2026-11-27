package dev.chirayupatel.music.ui

import android.view.HapticFeedbackConstants
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.gestures.drag
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListItemInfo
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.ImageShader
import androidx.compose.ui.graphics.ShaderBrush
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.TileMode
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.imageResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.min
import androidx.compose.ui.unit.sp
import coil3.compose.AsyncImage
import dev.chirayupatel.music.R
import dev.chirayupatel.music.device.PhoneMusic
import dev.chirayupatel.music.net.Album
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.max
import kotlin.math.roundToInt
import kotlin.math.min as minOf2

@Composable
fun ShelfScreen(vm: AppViewModel) {
    val snack = remember { SnackbarHostState() }
    LaunchedEffect(vm.message) { vm.message?.let { snack.showSnackbar(it); vm.message = null } }
    var peek by remember { mutableStateOf(false) }   // wall mode: a tap shows the bars for a moment
    LaunchedEffect(peek) { if (peek) { delay(5000); peek = false } }
    BackHandler(enabled = vm.openId != null || vm.wallMode) { if (vm.wallMode) vm.wallMode = false else vm.openId = null }

    val playingAlbum = vm.albums.firstOrNull { it.id == (vm.nowAlbumId ?: vm.openId) }
    val glow by animateColorAsState(playingAlbum?.let { parseColor(it.color) } ?: Color.Transparent, tween(900), label = "glow")
    val noise = ImageBitmap.imageResource(R.drawable.noise)
    val grain = remember(noise) { ShaderBrush(ImageShader(noise, TileMode.Repeated, TileMode.Repeated)) }

    Box(
        Modifier.fillMaxSize()
            .drawBehind {   // the dark plaster wall, glowing faintly in the playing album's colour
                val r = max(size.width, size.height)
                if (r < 1f) return@drawBehind   // a radial gradient needs a radius above zero
                drawRect(Brush.radialGradient(listOf(Color(0xFF2C2A27), Color(0xFF171513), Palette.Bg), Offset(size.width / 2, size.height * .3f), r * .8f))
                if (glow.alpha > .01f) drawRect(Brush.radialGradient(listOf(glow.copy(alpha = glow.alpha * .2f), Color.Transparent), Offset(size.width / 2, size.height * .48f), r * .6f))
                drawRect(grain)
            }
            .pointerInput(vm.wallMode) { detectTapGestures { if (vm.wallMode) peek = true } },
    ) {
        BoxWithConstraints(Modifier.fillMaxSize()) {
            val phone = maxWidth < 600.dp
            val wide = maxWidth >= 840.dp
            Column(Modifier.fillMaxSize().windowInsetsPadding(if (vm.wallMode) WindowInsets(0) else WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal))) {
                AnimatedVisibility(!vm.wallMode || peek, enter = fadeIn() + slideInVertically(), exit = fadeOut() + slideOutVertically()) {
                    TopBar(vm, wide)
                }
                Box(Modifier.weight(1f).fillMaxWidth()) {
                    when {
                        !vm.loaded -> {}
                        vm.albums.isEmpty() -> EmptyShelf(vm)
                        phone -> VerticalStack(vm)
                        else -> WallShelf(vm)
                    }
                }
                AnimatedVisibility(vm.nowTitle.isNotEmpty() && (!vm.wallMode || peek), enter = fadeIn() + slideInVertically { it }, exit = fadeOut() + slideOutVertically { it }) {
                    PlayerBar(vm)
                }
                if (vm.nowTitle.isEmpty() && !vm.wallMode) Spacer(Modifier.windowInsetsPadding(WindowInsets.navigationBars))
            }
        }
        NowPlaying(vm)
        SnackbarHost(snack, Modifier.align(Alignment.BottomCenter).padding(bottom = 96.dp))
    }
    AlbumSheet(vm)
    SettingsSheet(vm)
    SpeakerSheet(vm)
}

/* ---------------------------------------------------------------- top bar */

@Composable
private fun TopBar(vm: AppViewModel, wide: Boolean) {
    if (wide) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            Brand()
            SourceSwitch(vm, Modifier.widthIn(max = 420.dp))
            Spacer(Modifier.weight(1f))
            SearchField(vm, Modifier.width(220.dp))
            SortMenu(vm)
            IconButton(AvIcons.Wall, "Wall mode") { vm.wallMode = !vm.wallMode }
            IconButton(AvIcons.Gear, "Settings") { vm.showSettings = true }
        }
    } else {
        Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.weight(1f).padding(start = 4.dp)) { Brand() }
                IconButton(AvIcons.Wall, "Wall mode") { vm.wallMode = !vm.wallMode }
                IconButton(AvIcons.Gear, "Settings") { vm.showSettings = true }
            }
            SourceSwitch(vm, Modifier.fillMaxWidth())
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                SearchField(vm, Modifier.weight(1f))
                SortMenu(vm)
            }
        }
    }
}

@Composable
private fun Brand() = Text("ALBUM VIEWER", color = Palette.Ink, fontWeight = FontWeight.Bold, fontSize = 15.sp, letterSpacing = .14.em, maxLines = 1)

@Composable
fun IconButton(icon: ImageVector, label: String, tint: Color = Palette.Muted, size: Dp = 44.dp, iconSize: Dp = 20.dp, onClick: () -> Unit) {
    Box(Modifier.size(size).pressable(label, onClick = onClick).clip(CircleShape), contentAlignment = Alignment.Center) {
        Icon(icon, label, tint = tint, modifier = Modifier.size(iconSize))
    }
}

@Composable
private fun SourceSwitch(vm: AppViewModel, modifier: Modifier) {
    val options = buildList {
        add("all" to "All"); add("spotify" to "Spotify"); if (vm.hasYouTube) add("youtube" to "YouTube")
        if (vm.hasPlaylists) add("playlist" to "Playlists")
        add("local" to "Local"); if (vm.hasDemo) add("demo" to "Demo")
    }
    Row(modifier.clip(RoundedCornerShape(12.dp)).background(Color.White.copy(alpha = .05f)).padding(4.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        for ((key, label) in options) {
            val on = vm.source == key || (key == "all" && ((vm.source == "demo" && !vm.hasDemo) || (vm.source == "playlist" && !vm.hasPlaylists) ||
                (vm.source == "youtube" && !vm.hasYouTube)))
            Box(
                Modifier.weight(1f).height(40.dp).pressable(label) { vm.chooseSource(key) }.clip(RoundedCornerShape(9.dp))
                    .background(if (on) Color.White.copy(alpha = .1f) else Color.Transparent),
                contentAlignment = Alignment.Center,
            ) {
                Text(label.uppercase(), color = if (on) Palette.Accent else Palette.Muted, fontSize = if (options.size > 4) 11.sp else 12.sp,
                     fontWeight = FontWeight.SemiBold, letterSpacing = if (options.size > 4) .04.em else .1.em, maxLines = 1, overflow = TextOverflow.Clip)
            }
        }
    }
}

@Composable
private fun SearchField(vm: AppViewModel, modifier: Modifier) {
    BasicTextField(
        value = vm.query, onValueChange = { vm.query = it }, singleLine = true,
        textStyle = TextStyle(color = Palette.Ink, fontSize = 16.sp), cursorBrush = SolidColor(Palette.Accent),
        modifier = modifier.height(44.dp),
        decorationBox = { field ->
            Row(
                Modifier.fillMaxSize().clip(RoundedCornerShape(10.dp)).background(Color.White.copy(alpha = .03f))
                    .border(1.dp, Palette.Line, RoundedCornerShape(10.dp)).padding(horizontal = 10.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Icon(AvIcons.Search, null, tint = Palette.Muted, modifier = Modifier.size(18.dp))
                Box(Modifier.weight(1f)) {
                    if (vm.query.isEmpty()) Text("Find an album", color = Palette.Muted, fontSize = 16.sp)
                    field()
                }
                if (vm.query.isNotEmpty()) IconButton(AvIcons.Close, "Clear", size = 32.dp) { vm.query = "" }
            }
        },
    )
}

@Composable
private fun SortMenu(vm: AppViewModel) {
    var open by remember { mutableStateOf(false) }
    Box {
        Row(
            Modifier.height(44.dp).clip(RoundedCornerShape(10.dp)).border(1.dp, Palette.AccentSoft, RoundedCornerShape(10.dp))
                .clickable { open = true }.padding(start = 12.dp, end = 8.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(vm.sort.label.uppercase(), color = Palette.Accent, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, letterSpacing = .12.em, maxLines = 1)
            Icon(AvIcons.Chevron, null, tint = Palette.Accent, modifier = Modifier.size(18.dp))
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            for (s in Sort.entries) DropdownMenuItem(
                text = { Text(s.label, color = if (s == vm.sort) Palette.Accent else Palette.Ink) },
                onClick = { vm.chooseSort(s); open = false },
            )
        }
    }
}

/* ---------------------------------------------------------------- phones: the vertical stack */

@Composable
private fun VerticalStack(vm: AppViewModel) {
    val state = rememberLazyListState()
    val reorder = rememberShelfReorder(vm, state)
    val list = reorder.list(vm.visible)
    val density = LocalDensity.current
    val view = LocalView.current
    var crossPx by remember { mutableIntStateOf(0) }
    // The strip under a finger lifts out over the frame. The stack is clipped to the screen's rounded
    // corners, so a lit copy of it is drawn above everything, a little wider to the left.
    var liftedId by remember { mutableStateOf<String?>(null) }
    var stackAt by remember { mutableStateOf(Offset.Zero) }
    var screenAt by remember { mutableStateOf(Offset.Zero) }

    Box(Modifier.fillMaxSize().onGloballyPositioned { stackAt = it.positionInRoot() }) {
    Row(Modifier.fillMaxSize().padding(start = 10.dp, top = 4.dp, bottom = 10.dp)) {
        Bezel(Modifier.weight(1f).fillMaxHeight(), radius = 16.dp, pad = 6.dp) {
            BoxWithConstraints(
                Modifier.fillMaxSize().clip(RoundedCornerShape(11.dp)).background(Color(0xFF050504))
                    .onSizeChanged { crossPx = it.width }.onGloballyPositioned { screenAt = it.positionInRoot() },
            ) {
                val cross = maxWidth
                val cp = with(density) { cross.toPx() }
                LazyColumn(state = state, modifier = Modifier.fillMaxSize().reorderGestures(reorder, vertical = true), verticalArrangement = Arrangement.Center) {
                    items(list, key = { it.id }) { a ->
                        Spine(
                            a, open = a.id == vm.openId, vertical = true, cross = cross,
                            thickness = with(density) { spineThickness(a, cp).toDp() },
                            pill = pillFor(vm, a.id), playing = vm.isPlaying && vm.nowAlbumId == a.id,
                            artUrl = vm.artUrl(a.art),
                            onTap = { view.performHapticFeedback(HapticFeedbackConstants.CONTEXT_CLICK); vm.tap(a) },
                            onHold = { reorder.begin(a, list) },
                            lifted = a.id == reorder.key,
                            out = a.id == vm.openId && a.id == vm.nowAlbumId && vm.nowTitle.isNotEmpty(),
                            onRecordTap = { view.performHapticFeedback(HapticFeedbackConstants.CONTEXT_CLICK); vm.toggle() },
                            onPutBack = { view.performHapticFeedback(HapticFeedbackConstants.CONTEXT_CLICK); vm.putBack() },
                            onTouch = { t -> if (t) liftedId = a.id else if (liftedId == a.id) liftedId = null },
                            modifier = if (a.id == reorder.key) Modifier.held(reorder, a.id, vertical = true) else Modifier.animateItem(),
                        )
                    }
                }
                Glass(vertical = true)
            }
        }
        Rail(vm, state, Modifier.width(36.dp).fillMaxHeight())
    }
    // Only a strip wholly in view lifts, and not while arranging or once it's open.
    val lifted = liftedId?.takeIf { reorder.key == null && it != vm.openId }?.let { id ->
        val info = state.layoutInfo.visibleItemsInfo.firstOrNull { it.key == id }
        val a = list.firstOrNull { it.id == id }
        if (a != null && info != null && info.offset >= 0 && info.offset + info.size <= state.layoutInfo.viewportSize.height) a to info else null
    }
    var shown by remember { mutableStateOf<Pair<Album, LazyListItemInfo>?>(null) }
    if (lifted != null) shown = lifted
    val reach by animateDpAsState(if (lifted != null) 12.dp else 0.dp, tween(if (lifted != null) 150 else 120, easing = OutEasing), label = "lift")
    val g = shown
    if (g != null && reach > 0.dp) {
        val (a, info) = g
        Box(
            Modifier.offset { IntOffset((screenAt.x - stackAt.x - reach.toPx()).roundToInt(), (screenAt.y - stackAt.y + info.offset).roundToInt()) }
                .size(width = with(density) { crossPx.toDp() } + reach, height = with(density) { info.size.toDp() })
                .shadow(8.dp * (reach / 12.dp)),
        ) {
            Spine(
                a, open = false, vertical = true, cross = with(density) { crossPx.toDp() }, thickness = with(density) { info.size.toDp() },
                pill = null, playing = false, artUrl = null, onTap = {}, ghost = true,
            )
        }
    }
    }

    // Put the opened album's top where its finished slot will sit centred (a square, or taller with
    // the record out); it grows into place.
    val outNow = vm.openId != null && vm.openId == vm.nowAlbumId && vm.nowTitle.isNotEmpty()
    LaunchedEffect(vm.openId, outNow) {
        val i = list.indexOfFirst { it.id == vm.openId }
        if (i < 0) return@LaunchedEffect
        val vp = state.layoutInfo.viewportSize.height
        val slot = if (outNow) (crossPx * OUT_STACK).toInt() else crossPx
        state.animateScrollToItem(i, -((vp - slot) / 2).coerceAtLeast(0))
    }
}

@Composable
private fun Rail(vm: AppViewModel, state: LazyListState, modifier: Modifier) {
    val keys = vm.railKeys
    if (keys.isEmpty()) { ScrollHandle(vm, state, modifier); return }
    val view = LocalView.current
    val scope = rememberCoroutineScope()
    val density = LocalDensity.current
    var railH by remember { mutableIntStateOf(0) }
    var active by remember { mutableStateOf<Int?>(null) }
    val itemH = with(density) { min(22.dp, ((railH.toDp() - 24.dp) / keys.size).coerceAtLeast(12.dp)) }
    val current by remember(keys) {
        derivedStateOf {
            val info = state.layoutInfo.visibleItemsInfo
            val mid = if (info.isEmpty()) 0 else info[info.size / 2].index
            keys.indexOfLast { it.second <= mid }.coerceAtLeast(0)
        }
    }
    Box(
        modifier.onSizeChanged { railH = it.height }.pointerInput(keys, railH) {
            awaitEachGesture {
                val down = awaitFirstDown()
                fun pick(y: Float) {
                    val px = itemH.toPx()
                    val top = (size.height - px * keys.size) / 2
                    val i = ((y - top) / px).toInt().coerceIn(0, keys.lastIndex)
                    if (i != active) {
                        active = i
                        view.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
                        scope.launch { state.scrollToItem(keys[i].second) }
                    }
                }
                pick(down.position.y)
                down.consume()
                drag(down.id) { pick(it.position.y); it.consume() }
                active = null
            }
        },
        contentAlignment = Alignment.Center,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            keys.forEachIndexed { i, (k, _) ->
                Box(Modifier.height(itemH).fillMaxWidth(), contentAlignment = Alignment.Center) {
                    Text(shortKey(k), fontSize = 10.5.sp, fontWeight = FontWeight.Bold,
                        color = if (i == (active ?: current)) (if (active != null) Color.White else Palette.Accent) else Color.White.copy(alpha = .62f))
                }
            }
        }
        active?.let { i ->
            val y = with(density) { (((railH - itemH.toPx() * keys.size) / 2) + itemH.toPx() * (i + .5f)).toDp() }
            Box(
                Modifier.align(Alignment.TopCenter).offset(x = (-52).dp, y = y - 30.dp).size(60.dp)
                    .shadow(12.dp, CircleShape).background(Palette.Accent, CircleShape),
                contentAlignment = Alignment.Center,
            ) { Text(shortKey(keys[i].first), color = Color.White, fontSize = 26.sp, fontFamily = FontFamily.Serif) }
        }
    }
}

private fun shortKey(k: String) = if (Regex("^\\d{4}s$").matches(k)) "’" + k.substring(2) else k

/** Where the stack is scrolled to (0 to 1) and how much of it is in view, from the albums on screen. */
private class StackMetrics(val fraction: Float, val share: Float, val avg: Float, val viewport: Float)

private fun stackMetrics(state: LazyListState): StackMetrics {
    val info = state.layoutInfo
    val items = info.visibleItemsInfo
    val vp = (info.viewportEndOffset - info.viewportStartOffset).toFloat()
    if (items.isEmpty() || info.totalItemsCount == 0 || vp <= 0f) return StackMetrics(0f, 1f, 1f, vp)
    val avg = items.sumOf { it.size }.toFloat() / items.size
    val total = avg * info.totalItemsCount
    val first = items.first()
    val fraction = when {
        !state.canScrollBackward -> 0f
        !state.canScrollForward -> 1f
        else -> ((first.index * avg - first.offset) / (total - vp).coerceAtLeast(1f)).coerceIn(0f, 1f)
    }
    return StackMetrics(fraction, (vp / total).coerceIn(.05f, 1f), avg, vp)
}

/** What the bubble says about an album while you drag the handle. */
private fun bubbleKey(a: Album, sort: Sort): String = when (sort) {
    Sort.COLOR -> a.color
    Sort.ADDED -> a.addedAt?.let { SimpleDateFormat("MMM yyyy", Locale.getDefault()).format(Date((it * 1000).toLong())) } ?: "Undated"
    else -> artistKey(a.artist).firstOrNull()?.uppercaseChar()?.let { if (it in 'A'..'Z') it.toString() else "#" } ?: "#"
}

/**
 * In orders without letters (manual, recently added, colour) the rail is a handle: its length shows
 * how much of the stack is in view, its place how far down you are. Drag it and the stack follows,
 * with a bubble saying where you are: the artist's initial, the month the album arrived, or its colour.
 */
@Composable
private fun ScrollHandle(vm: AppViewModel, state: LazyListState, modifier: Modifier) {
    val list = vm.visible
    val scrollable by remember { derivedStateOf { state.canScrollForward || state.canScrollBackward } }
    if (list.size < 12 || !scrollable) { Spacer(modifier); return }
    val view = LocalView.current
    val scope = rememberCoroutineScope()
    val density = LocalDensity.current
    val sort = vm.sort
    var held by remember { mutableStateOf<Float?>(null) }   // where the handle is while it's dragged, 0 to 1
    var at by remember { mutableStateOf<Album?>(null) }      // the album in the middle of the stack then
    var thumb by remember { mutableStateOf(0f to 0f) }       // its top and length, for the bubble
    val minThumb = with(density) { 40.dp.toPx() }
    fun thumbLen(track: Float, share: Float) = (track * share).coerceIn(minOf2(minThumb, track * .5f), track * .5f)
    Box(
        modifier.padding(vertical = 4.dp)
            .pointerInput(list) {
                awaitEachGesture {
                    val down = awaitFirstDown()
                    val track = size.height.toFloat()
                    val m = stackMetrics(state)
                    val th = thumbLen(track, m.share)
                    val top = m.fraction * (track - th)
                    // hold the handle where you took it; a touch elsewhere brings it under your finger
                    val grab = if (down.position.y in top..(top + th)) down.position.y - top else th / 2
                    var lastKey: String? = null
                    fun go(y: Float) {
                        val g = ((y - grab) / (track - th).coerceAtLeast(1f)).coerceIn(0f, 1f)
                        held = g
                        thumb = g * (track - th) to th
                        val n = state.layoutInfo.totalItemsCount
                        val target = g * (m.avg * n - m.viewport).coerceAtLeast(0f)
                        val idx = (target / m.avg).toInt().coerceIn(0, max(0, n - 1))
                        scope.launch { state.scrollToItem(idx, (target - idx * m.avg).toInt()) }
                        val a = list[((target + m.viewport / 2) / m.avg).toInt().coerceIn(0, list.lastIndex)]
                        val k = bubbleKey(a, sort)
                        if (k != lastKey) { if (lastKey != null) view.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK); lastKey = k }
                        at = a
                    }
                    go(down.position.y)
                    down.consume()
                    drag(down.id) { go(it.position.y); it.consume() }
                    held = null; at = null
                }
            }
            .drawBehind {   // read while drawing, so scrolling only redraws the handle
                val track = size.height
                val m = stackMetrics(state)
                val th = thumbLen(track, m.share)
                val g = held ?: m.fraction
                val x = size.width / 2
                drawLine(Color.White.copy(alpha = .1f), Offset(x, 0f), Offset(x, track), 2.dp.toPx(), cap = StrokeCap.Round)
                val w = (if (held != null) 8.dp else 6.dp).toPx()
                drawRoundRect(if (held != null) Palette.Accent else Color.White.copy(alpha = .55f), Offset(x - w / 2, g * (track - th)), Size(w, th), CornerRadius(w / 2))
            },
    ) {
        val a = at
        if (a != null) {
            val y = with(density) { (thumb.first + thumb.second / 2).toDp() }
            val key = bubbleKey(a, sort)
            val mod = Modifier.align(Alignment.TopEnd).offset(x = (-44).dp, y = y - 30.dp).height(60.dp).shadow(12.dp, CircleShape)
            when (sort) {
                Sort.COLOR -> Box(mod.size(60.dp).background(parseColor(a.color), CircleShape).border(3.dp, Color.White.copy(alpha = .85f), CircleShape))
                Sort.ADDED -> Box(mod.background(Palette.Accent, CircleShape).padding(horizontal = 18.dp), contentAlignment = Alignment.Center) {
                    Text(key, color = Color.White, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
                }
                else -> Box(mod.size(60.dp).background(Palette.Accent, CircleShape), contentAlignment = Alignment.Center) {
                    Text(key, color = Color.White, fontSize = 26.sp, fontFamily = FontFamily.Serif)
                }
            }
        }
    }
}

private fun pillFor(vm: AppViewModel, id: String): String? = when {
    vm.openId != id -> null
    vm.nowAlbumId == id && vm.isPlaying -> "Now playing"
    vm.nowAlbumId == id -> "Paused"
    else -> "Tap for tracks"
}

/* ---------------------------------------------------------------- tablets / landscape: the wall shelf */

@Composable
private fun WallShelf(vm: AppViewModel) {
    val state = rememberLazyListState()
    val reorder = rememberShelfReorder(vm, state)
    val list = reorder.list(vm.visible)
    val density = LocalDensity.current
    val view = LocalView.current
    val scope = rememberCoroutineScope()
    BoxWithConstraints(Modifier.fillMaxSize().padding(horizontal = if (vm.wallMode) 0.dp else 28.dp), contentAlignment = Alignment.Center) {
        val screenH = if (vm.wallMode) min(maxHeight, maxWidth / 5.33f) else min(maxWidth / 5.33f, maxHeight - 90.dp).coerceAtLeast(150.dp)
        val cp = with(density) { screenH.toPx() }
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Bezel(Modifier.fillMaxWidth(), radius = if (vm.wallMode) 0.dp else 14.dp, pad = if (vm.wallMode) 0.dp else 14.dp) {
                Box(Modifier.fillMaxWidth().height(screenH).background(Color(0xFF050504), RoundedCornerShape(3.dp))) {   // the row clips the rest
                    LazyRow(state = state, modifier = Modifier.fillMaxSize().reorderGestures(reorder, vertical = false), horizontalArrangement = Arrangement.Center) {
                        items(list, key = { it.id }) { a ->
                            Spine(
                                a, open = a.id == vm.openId, vertical = false, cross = screenH,
                                thickness = with(density) { spineThickness(a, cp).toDp() },
                                pill = pillFor(vm, a.id), playing = vm.isPlaying && vm.nowAlbumId == a.id,
                                artUrl = vm.artUrl(a.art),
                                onTap = { view.performHapticFeedback(HapticFeedbackConstants.CONTEXT_CLICK); vm.tap(a) },
                                onHold = { reorder.begin(a, list) },
                                lifted = a.id == reorder.key,
                                out = a.id == vm.openId && a.id == vm.nowAlbumId && vm.nowTitle.isNotEmpty(),
                                onRecordTap = { view.performHapticFeedback(HapticFeedbackConstants.CONTEXT_CLICK); vm.toggle() },
                                onPutBack = { view.performHapticFeedback(HapticFeedbackConstants.CONTEXT_CLICK); vm.putBack() },
                                modifier = if (a.id == reorder.key) Modifier.held(reorder, a.id, vertical = false) else Modifier.animateItem(),
                            )
                        }
                    }
                    Glass(vertical = false)
                }
            }
            if (!vm.wallMode && vm.railKeys.isNotEmpty()) {
                Row(Modifier.padding(top = 22.dp), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                    for ((k, i) in vm.railKeys) Box(
                        Modifier.size(width = 36.dp, height = 40.dp).clip(RoundedCornerShape(6.dp)).clickable { scope.launch { state.animateScrollToItem(i) } },
                        contentAlignment = Alignment.Center,
                    ) { Text(k, color = Color.White.copy(alpha = .5f), fontSize = 12.sp, fontWeight = FontWeight.SemiBold, letterSpacing = .12.em) }
                }
            }
        }
        val outNow = vm.openId != null && vm.openId == vm.nowAlbumId && vm.nowTitle.isNotEmpty()
        LaunchedEffect(vm.openId, outNow) {
            val i = list.indexOfFirst { it.id == vm.openId }
            if (i < 0) return@LaunchedEffect
            val vp = state.layoutInfo.viewportSize.width
            val slot = if (outNow) (cp * OUT_WALL).toInt() else cp.toInt()
            state.animateScrollToItem(i, -((vp - slot) / 2).coerceAtLeast(0))
        }
    }
}

/* ---------------------------------------------------------------- the bezel, the glass, empty */

@Composable
private fun Bezel(modifier: Modifier, radius: Dp, pad: Dp, content: @Composable BoxScope.() -> Unit) {
    val shape = RoundedCornerShape(radius)
    Box(
        // Not clipped, so a lifted spine on the wall shelf can rise over the frame.
        modifier.shadow(if (radius > 0.dp) 24.dp else 0.dp, shape, clip = false)
            .background(Brush.verticalGradient(0f to Color(0xFF55575C), .18f to Color(0xFF34363A), .6f to Color(0xFF232427), 1f to Color(0xFF1A1B1D)), shape)
            .border(1.dp, Color(0x8CCDCFD4), shape)
            .padding(pad),
        content = content,
    )
}

@Composable
private fun BoxScope.Glass(vertical: Boolean) {
    Box(Modifier.matchParentSize().drawBehind {
        if (vertical) drawRect(Brush.horizontalGradient(0f to Color.White.copy(alpha = .06f), .26f to Color.Transparent))
        else drawRect(Brush.verticalGradient(0f to Color.White.copy(alpha = .07f), .22f to Color.Transparent))
    })
}

@Composable
private fun EmptyShelf(vm: AppViewModel) {
    val context = LocalContext.current
    val askForMusic = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        if (ok) vm.enablePhoneMusic() else vm.message = "Album Viewer needs to see your music to show it"
    }
    val sp = vm.me?.spotify ?: vm.status?.spotify
    val yt = vm.status?.youtube ?: vm.me?.youtube
    Column(Modifier.fillMaxSize().padding(32.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        Text("Your collection, back on the wall.", color = Palette.Ink, fontFamily = FontFamily.Serif, fontSize = 26.sp, textAlign = TextAlign.Center)
        Text(
            if (yt?.configured == true) "Connect Spotify or YouTube for your albums and playlists, or show the music on this phone."
            else "Connect Spotify for your albums and playlists, or show the music on this phone.",
            color = Palette.Muted, fontSize = 14.sp, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 8.dp, bottom = 20.dp),
        )
        Column(verticalArrangement = Arrangement.spacedBy(10.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            if (sp?.configured == true && !sp.connected) PrimaryButton("Connect Spotify") { vm.connectSpotify { openInBrowser(context, it) } }
            if (yt?.configured == true && !yt.connected) PrimaryButton("Connect YouTube") { vm.connectYouTube { openInBrowser(context, it) } }
            if (!vm.phoneMusicOn) GhostButton("Show music on this phone") {
                if (vm.phoneAllowed) vm.enablePhoneMusic() else askForMusic.launch(PhoneMusic.PERMISSION)
            }
            if (vm.me?.admin == true) GhostButton("Load demo shelf") { vm.loadDemo() }
        }
    }
}

/* ---------------------------------------------------------------- the player bar */

@Composable
private fun PlayerBar(vm: AppViewModel) {
    Column(
        Modifier.fillMaxWidth().background(Palette.Bg.copy(alpha = .97f))
            .drawBehind { drawLine(Palette.Line, Offset(0f, 0f), Offset(size.width, 0f), 1f) }
            .pointerInput(Unit) { detectVerticalDragGestures { _, dy -> if (dy < -6f) vm.showPlayer = true } }
            .clickable(remember { MutableInteractionSource() }, indication = null) { vm.showPlayer = true }
            .windowInsetsPadding(WindowInsets.navigationBars)
            .padding(start = 14.dp, end = 10.dp, top = 10.dp, bottom = 6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            AsyncImage(
                model = vm.nowArt, contentDescription = "Now playing",
                modifier = Modifier.size(46.dp).clip(RoundedCornerShape(3.dp)).background(Color(0xFF222222)),
            )
            Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                Text(vm.nowTitle, color = Palette.Ink, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(vm.nowArtist, color = Palette.Muted, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            IconButton(AvIcons.Prev, "Previous", tint = Palette.Ink) { vm.prev() }
            Box(Modifier.size(44.dp).pressable(if (vm.isPlaying) "Pause" else "Play") { vm.toggle() }.clip(CircleShape).background(Color.White.copy(alpha = .92f)), contentAlignment = Alignment.Center) {
                Icon(if (vm.isPlaying) AvIcons.Pause else AvIcons.Play, if (vm.isPlaying) "Pause" else "Play", tint = Color(0xFF111111), modifier = Modifier.size(22.dp))
            }
            IconButton(AvIcons.Next, "Next", tint = Palette.Ink) { vm.next() }
        }
        val frac = if (vm.duration > 0) (vm.position.toFloat() / vm.duration).coerceIn(0f, 1f) else 0f
        val wave = rememberWave(vm.isPlaying, period = 1200)
        Row(Modifier.padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(fmt(vm.position), color = Palette.Muted, fontSize = 11.sp)
            Box(   // the progress line: it wiggles while the music plays
                Modifier.weight(1f).height(28.dp).pointerInput(Unit) { detectTapGestures { vm.seekTo(it.x / size.width) } }
                    .drawBehind { drawWave(frac, wave, 1.6.dp.toPx(), 16.dp.toPx(), 2.6.dp.toPx(), Palette.Accent, Color.White.copy(alpha = .12f)) },
            )
            Text(fmt(vm.duration), color = Palette.Muted, fontSize = 11.sp)
        }
        val w = vm.where
        if (w.remote) Row(   // on another speaker: say where, and open the speaker list
            Modifier.padding(bottom = 2.dp).clip(RoundedCornerShape(6.dp)).clickable { vm.openSpeakers() }.padding(vertical = 4.dp, horizontal = 2.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(AvIcons.forKind(w.kind), null, tint = Palette.Accent, modifier = Modifier.size(15.dp))
            Text("Playing on ${w.name}", color = Palette.Accent, fontSize = 12.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

fun fmt(ms: Long): String { val s = (ms / 1000).coerceAtLeast(0); return "%d:%02d".format(s / 60, s % 60) }

@Composable
fun PrimaryButton(label: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Box(Modifier.then(modifier).height(46.dp).pressable(label, onClick = onClick).clip(RoundedCornerShape(50)).background(Palette.Accent).padding(horizontal = 22.dp), contentAlignment = Alignment.Center) {
        Text(label, color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
    }
}

@Composable
fun GhostButton(label: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Box(Modifier.then(modifier).height(46.dp).pressable(label, onClick = onClick).clip(RoundedCornerShape(50)).border(1.dp, Color.White.copy(alpha = .18f), RoundedCornerShape(50)).padding(horizontal = 20.dp), contentAlignment = Alignment.Center) {
        Text(label, color = Palette.Ink, fontWeight = FontWeight.Medium, fontSize = 15.sp)
    }
}
