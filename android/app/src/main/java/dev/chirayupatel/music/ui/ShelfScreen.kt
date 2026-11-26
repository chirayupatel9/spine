package dev.chirayupatel.music.ui

import android.view.HapticFeedbackConstants
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
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
import androidx.compose.foundation.gestures.drag
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
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.ImageShader
import androidx.compose.ui.graphics.ShaderBrush
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.TileMode
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.imageResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.min
import androidx.compose.ui.unit.sp
import coil3.compose.AsyncImage
import dev.chirayupatel.music.R
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.max

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
        SnackbarHost(snack, Modifier.align(Alignment.BottomCenter).padding(bottom = 96.dp))
    }
    AlbumSheet(vm)
    SettingsSheet(vm)
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
fun IconButton(icon: ImageVector, label: String, tint: Color = Palette.Muted, size: Dp = 44.dp, onClick: () -> Unit) {
    Box(Modifier.size(size).clip(CircleShape).clickable(onClick = onClick), contentAlignment = Alignment.Center) {
        Icon(icon, label, tint = tint, modifier = Modifier.size(20.dp))
    }
}

@Composable
private fun SourceSwitch(vm: AppViewModel, modifier: Modifier) {
    val options = buildList { add("all" to "All"); add("spotify" to "Spotify"); add("local" to "Local"); if (vm.hasDemo) add("demo" to "Demo") }
    Row(modifier.clip(RoundedCornerShape(12.dp)).background(Color.White.copy(alpha = .05f)).padding(4.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        for ((key, label) in options) {
            val on = vm.source == key || (key == "all" && vm.source == "demo" && !vm.hasDemo)
            Box(
                Modifier.weight(1f).height(40.dp).clip(RoundedCornerShape(9.dp))
                    .background(if (on) Color.White.copy(alpha = .1f) else Color.Transparent)
                    .clickable { vm.chooseSource(key) },
                contentAlignment = Alignment.Center,
            ) {
                Text(label.uppercase(), color = if (on) Palette.Accent else Palette.Muted, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, letterSpacing = .1.em, maxLines = 1)
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
    val list = vm.visible
    val state = rememberLazyListState()
    val density = LocalDensity.current
    val view = LocalView.current
    var crossPx by remember { mutableIntStateOf(0) }

    Row(Modifier.fillMaxSize().padding(start = 10.dp, top = 4.dp, bottom = 10.dp)) {
        Bezel(Modifier.weight(1f).fillMaxHeight(), radius = 16.dp, pad = 6.dp) {
            BoxWithConstraints(Modifier.fillMaxSize().clip(RoundedCornerShape(11.dp)).background(Color(0xFF050504)).onSizeChanged { crossPx = it.width }) {
                val cross = maxWidth
                val cp = with(density) { cross.toPx() }
                LazyColumn(state = state, modifier = Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center) {
                    items(list, key = { it.id }) { a ->
                        Spine(
                            a, open = a.id == vm.openId, vertical = true, cross = cross,
                            thickness = with(density) { spineThickness(a, cp).toDp() },
                            pill = pillFor(vm, a.id), playing = vm.isPlaying && vm.nowAlbumId == a.id,
                            artUrl = vm.artUrl(a.art),
                            onTap = { view.performHapticFeedback(HapticFeedbackConstants.CONTEXT_CLICK); vm.tap(a) },
                            modifier = Modifier.animateItem(),
                        )
                    }
                }
                Glass(vertical = true)
            }
        }
        Rail(vm, state, Modifier.width(36.dp).fillMaxHeight())
    }

    // Put the opened album's top where the finished square will sit centred; it grows into place.
    LaunchedEffect(vm.openId) {
        val i = list.indexOfFirst { it.id == vm.openId }
        if (i < 0) return@LaunchedEffect
        val vp = state.layoutInfo.viewportSize.height
        state.animateScrollToItem(i, -((vp - crossPx) / 2).coerceAtLeast(0))
    }
}

@Composable
private fun Rail(vm: AppViewModel, state: LazyListState, modifier: Modifier) {
    val keys = vm.railKeys
    if (keys.isEmpty()) { Spacer(modifier); return }
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
                    Text(shortKey(k), fontSize = 10.sp, fontWeight = FontWeight.SemiBold,
                        color = if (i == (active ?: current)) (if (active != null) Color.White else Palette.Accent) else Palette.Faint)
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

private fun pillFor(vm: AppViewModel, id: String): String? = when {
    vm.openId != id -> null
    vm.nowAlbumId == id && vm.isPlaying -> "Now playing"
    vm.nowAlbumId == id -> "Paused"
    else -> "Tap for tracks"
}

/* ---------------------------------------------------------------- tablets / landscape: the wall shelf */

@Composable
private fun WallShelf(vm: AppViewModel) {
    val list = vm.visible
    val state = rememberLazyListState()
    val density = LocalDensity.current
    val view = LocalView.current
    val scope = rememberCoroutineScope()
    BoxWithConstraints(Modifier.fillMaxSize().padding(horizontal = if (vm.wallMode) 0.dp else 28.dp), contentAlignment = Alignment.Center) {
        val screenH = if (vm.wallMode) min(maxHeight, maxWidth / 5.33f) else min(maxWidth / 5.33f, maxHeight - 90.dp).coerceAtLeast(150.dp)
        val cp = with(density) { screenH.toPx() }
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Bezel(Modifier.fillMaxWidth(), radius = if (vm.wallMode) 0.dp else 14.dp, pad = if (vm.wallMode) 0.dp else 14.dp) {
                Box(Modifier.fillMaxWidth().height(screenH).clip(RoundedCornerShape(3.dp)).background(Color(0xFF050504))) {
                    LazyRow(state = state, modifier = Modifier.fillMaxSize(), horizontalArrangement = Arrangement.Center) {
                        items(list, key = { it.id }) { a ->
                            Spine(
                                a, open = a.id == vm.openId, vertical = false, cross = screenH,
                                thickness = with(density) { spineThickness(a, cp).toDp() },
                                pill = pillFor(vm, a.id), playing = vm.isPlaying && vm.nowAlbumId == a.id,
                                artUrl = vm.artUrl(a.art),
                                onTap = { view.performHapticFeedback(HapticFeedbackConstants.CONTEXT_CLICK); vm.tap(a) },
                                modifier = Modifier.animateItem(),
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
                    ) { Text(k, color = Palette.Faint, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, letterSpacing = .12.em) }
                }
            }
        }
        LaunchedEffect(vm.openId) {
            val i = list.indexOfFirst { it.id == vm.openId }
            if (i < 0) return@LaunchedEffect
            val vp = state.layoutInfo.viewportSize.width
            state.animateScrollToItem(i, -((vp - cp.toInt()) / 2).coerceAtLeast(0))
        }
    }
}

/* ---------------------------------------------------------------- the bezel, the glass, empty */

@Composable
private fun Bezel(modifier: Modifier, radius: Dp, pad: Dp, content: @Composable BoxScope.() -> Unit) {
    val shape = RoundedCornerShape(radius)
    Box(
        modifier.shadow(if (radius > 0.dp) 24.dp else 0.dp, shape)
            .clip(shape)
            .background(Brush.verticalGradient(0f to Color(0xFF55575C), .18f to Color(0xFF34363A), .6f to Color(0xFF232427), 1f to Color(0xFF1A1B1D)))
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
    Column(Modifier.fillMaxSize().padding(32.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        Text("Your collection, back on the wall.", color = Palette.Ink, fontFamily = FontFamily.Serif, fontSize = 26.sp)
        Text("Load the demo shelf, connect Spotify, or add music to your server.", color = Palette.Muted, fontSize = 14.sp, modifier = Modifier.padding(top = 8.dp, bottom = 20.dp))
        PrimaryButton("Load demo shelf") { vm.loadDemo() }
    }
}

/* ---------------------------------------------------------------- the player bar */

@Composable
private fun PlayerBar(vm: AppViewModel) {
    Column(
        Modifier.fillMaxWidth().background(Palette.Bg.copy(alpha = .97f))
            .drawBehind { drawLine(Palette.Line, Offset(0f, 0f), Offset(size.width, 0f), 1f) }
            .windowInsetsPadding(WindowInsets.navigationBars)
            .padding(start = 14.dp, end = 10.dp, top = 10.dp, bottom = 6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            AsyncImage(
                model = vm.nowArt, contentDescription = "Open album",
                modifier = Modifier.size(46.dp).clip(RoundedCornerShape(3.dp)).background(Color(0xFF222222))
                    .clickable { vm.nowAlbumId?.let { vm.openId = it; vm.openSheet(it) } },
            )
            Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                Text(vm.nowTitle, color = Palette.Ink, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(vm.nowArtist, color = Palette.Muted, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            IconButton(AvIcons.Prev, "Previous", tint = Palette.Ink) { vm.prev() }
            Box(Modifier.size(44.dp).clip(CircleShape).background(Color.White.copy(alpha = .92f)).clickable { vm.toggle() }, contentAlignment = Alignment.Center) {
                Icon(if (vm.isPlaying) AvIcons.Pause else AvIcons.Play, if (vm.isPlaying) "Pause" else "Play", tint = Color(0xFF111111), modifier = Modifier.size(22.dp))
            }
            IconButton(AvIcons.Next, "Next", tint = Palette.Ink) { vm.next() }
        }
        val frac = if (vm.duration > 0) (vm.position.toFloat() / vm.duration).coerceIn(0f, 1f) else 0f
        Row(Modifier.padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(fmt(vm.position), color = Palette.Muted, fontSize = 11.sp)
            Box(
                Modifier.weight(1f).height(28.dp).pointerInput(Unit) { detectTapGestures { vm.seekTo(it.x / size.width) } },
                contentAlignment = Alignment.CenterStart,
            ) {
                Box(Modifier.fillMaxWidth().height(3.dp).clip(RoundedCornerShape(2.dp)).background(Color.White.copy(alpha = .12f)))
                Box(Modifier.fillMaxWidth(frac).height(3.dp).clip(RoundedCornerShape(2.dp)).background(Palette.Accent))
            }
            Text(fmt(vm.duration), color = Palette.Muted, fontSize = 11.sp)
        }
    }
}

fun fmt(ms: Long): String { val s = (ms / 1000).coerceAtLeast(0); return "%d:%02d".format(s / 60, s % 60) }

@Composable
fun PrimaryButton(label: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Box(Modifier.then(modifier).height(46.dp).clip(RoundedCornerShape(50)).background(Palette.Accent).clickable(onClick = onClick).padding(horizontal = 22.dp), contentAlignment = Alignment.Center) {
        Text(label, color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
    }
}

@Composable
fun GhostButton(label: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Box(Modifier.then(modifier).height(46.dp).clip(RoundedCornerShape(50)).border(1.dp, Color.White.copy(alpha = .18f), RoundedCornerShape(50)).clickable(onClick = onClick).padding(horizontal = 20.dp), contentAlignment = Alignment.Center) {
        Text(label, color = Palette.Ink, fontWeight = FontWeight.Medium, fontSize = 15.sp)
    }
}
