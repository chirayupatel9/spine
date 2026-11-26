package dev.chirayupatel.music.ui

import android.view.HapticFeedbackConstants
import android.view.View
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.tween
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.runtime.toMutableStateList
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import dev.chirayupatel.music.net.Album
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Hold an album, then drag it to a new place. While the finger moves, the held album follows it and
 * the albums it passes slide aside (their own item animations); near either end the shelf scrolls.
 * Letting go settles it into its slot and saves the order on the server.
 *
 * Positions are along the shelf's direction (y in the phone stack, x on the wall shelf), in the
 * lazy list's viewport coordinates.
 */
@Stable
class ShelfReorder internal constructor(
    private val vm: AppViewModel,
    private val state: LazyListState,
    private val scope: CoroutineScope,
    private val view: View,
) {
    /** While arranging, the albums in their new order; otherwise null (show the view model's). */
    var items by mutableStateOf<SnapshotStateList<Album>?>(null)
        private set
    /** The album being held. */
    var key by mutableStateOf<String?>(null)
        private set
    private var start = 0f                           // its leading edge when the hold began
    private var delta by mutableFloatStateOf(0f)     // how far the finger has moved since
    private var settling = false
    private var moved = false                        // a hold without a move changes nothing

    fun list(visible: List<Album>): List<Album> = items ?: visible

    fun begin(a: Album, visible: List<Album>) {
        if (key != null) return
        val info = state.layoutInfo.visibleItemsInfo.firstOrNull { it.key == a.id } ?: return
        items = visible.toMutableStateList()
        start = info.offset.toFloat()
        delta = 0f
        moved = false
        key = a.id
        view.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
    }

    fun drag(by: Float) {
        if (key == null || settling) return
        delta += by
        swapIfPassed()
    }

    /** How far to draw the held album from its slot, so it stays under the finger. */
    fun offsetOf(id: String): Float {
        if (id != key) return 0f
        val info = state.layoutInfo.visibleItemsInfo.firstOrNull { it.key == id } ?: return 0f
        return start + delta - info.offset
    }

    /** Move the held album past a neighbour once its middle crosses that neighbour's middle. */
    fun swapIfPassed() {
        val list = items ?: return
        val infos = state.layoutInfo.visibleItemsInfo
        val held = infos.firstOrNull { it.key == key } ?: return
        val centre = start + delta + held.size / 2f
        val target = infos.firstOrNull { it.key != key && centre >= it.offset && centre <= it.offset + it.size } ?: return
        val mid = target.offset + target.size / 2f
        val passed = (target.index > held.index && centre > mid) || (target.index < held.index && centre < mid)
        if (!passed || held.index !in list.indices || target.index !in list.indices) return
        // The list keeps its place by the first visible album; if that album is the one moving,
        // hold the scroll position still instead of letting it follow.
        val first = state.firstVisibleItemIndex
        val firstOffset = state.firstVisibleItemScrollOffset
        list.add(target.index, list.removeAt(held.index))
        moved = true
        view.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
        if (held.index == first || target.index == first) scope.launch { state.scrollToItem(first, firstOffset) }
    }

    /** Scroll speed (px per frame) while the held album is near either end, else 0. */
    fun edgeSpeed(zone: Float, max: Float): Float {
        val id = key ?: return 0f
        val info = state.layoutInfo
        val held = info.visibleItemsInfo.firstOrNull { it.key == id } ?: return 0f
        val lead = start + delta
        val trail = lead + held.size
        val vs = info.viewportStartOffset.toFloat()
        val ve = info.viewportEndOffset.toFloat()
        return when {
            lead < vs + zone -> -max * ((vs + zone - lead) / zone).coerceIn(0f, 1f)
            trail > ve - zone -> max * ((trail - (ve - zone)) / zone).coerceIn(0f, 1f)
            else -> 0f
        }
    }

    /** Let go: glide into the slot, then save. */
    fun end() {
        val id = key ?: return
        if (settling) return
        settling = true
        scope.launch {
            val info = state.layoutInfo.visibleItemsInfo.firstOrNull { it.key == id }
            if (info != null) animate(delta, info.offset - start, animationSpec = tween(200, easing = OutEasing)) { v, _ -> delta = v }
            if (moved) items?.let { list -> vm.saveOrder(list.map { it.id }) }
            items = null
            key = null
            delta = 0f
            settling = false
        }
    }
}

@Composable
fun rememberShelfReorder(vm: AppViewModel, state: LazyListState): ShelfReorder {
    val scope = rememberCoroutineScope()
    val view = LocalView.current
    val r = remember(vm, state) { ShelfReorder(vm, state, scope, view) }
    val density = LocalDensity.current
    // Near either end, keep scrolling for as long as the album is held there.
    LaunchedEffect(r.key) {
        if (r.key == null) return@LaunchedEffect
        val zone = with(density) { 72.dp.toPx() }
        val max = with(density) { 14.dp.toPx() }
        while (isActive && r.key != null) {
            withFrameNanos { }
            val s = r.edgeSpeed(zone, max)
            if (s != 0f) { state.scrollBy(s); r.swapIfPassed() }
        }
    }
    return r
}

/**
 * On the list itself: once an album is held, take the finger's movement (before the list can
 * scroll with it) and move the album; lifting the finger drops it.
 */
fun Modifier.reorderGestures(r: ShelfReorder, vertical: Boolean): Modifier = pointerInput(r) {
    awaitPointerEventScope {
        while (true) {
            val event = awaitPointerEvent(PointerEventPass.Initial)
            if (r.key == null) continue
            for (c in event.changes) {
                if (!c.pressed) { r.end(); break }
                val d = c.positionChange()
                if (d != Offset.Zero) {
                    r.drag(if (vertical) d.y else d.x)
                    c.consume()
                }
            }
        }
    }
}

/** The held album: above its neighbours, a touch larger, with a shadow, following the finger. */
fun Modifier.held(r: ShelfReorder, id: String, vertical: Boolean): Modifier =
    zIndex(1f).graphicsLayer {
        val o = r.offsetOf(id)
        if (vertical) translationY = o else translationX = o
        scaleX = 1.025f
        scaleY = 1.025f
        shadowElevation = 18.dp.toPx()
    }
