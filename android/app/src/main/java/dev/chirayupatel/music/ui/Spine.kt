package dev.chirayupatel.music.ui

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.StartOffset
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import coil3.compose.AsyncImage
import dev.chirayupatel.music.net.Album

/**
 * One album on the shelf. `vertical` = the phone stack (spines are horizontal strips, text reads
 * across); otherwise the wall shelf (upright spines, text runs down). `cross` is the shelf's size
 * across: an open album becomes a square that size, its cover sliding out as it opens.
 */
@Composable
fun Spine(
    a: Album,
    open: Boolean,
    vertical: Boolean,
    cross: Dp,
    thickness: Dp,
    pill: String?,
    playing: Boolean,
    artUrl: String?,
    onTap: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val size by animateDpAsState(if (open) cross else thickness, tween(OPEN_MS, easing = OpenEasing), label = "spine")
    val base = remember(a.color) { parseColor(a.color) }
    val ink = remember(a.textColor) { parseColor(a.textColor, Color(0xFFF4F1EA)) }
    val h = remember(a.id, a.title) { spineHash(a.id + a.title) }
    val band = h % 3 == 0L
    val serif = h % 5 == 1L
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    // Each animation uses the timing of the way *into* its state: the cover comes in, the label
    // waits for it to leave before returning.
    val labelAlpha by animateFloatAsState(if (open) 0f else 1f, if (open) tween(120) else tween(220, delayMillis = 140, easing = OutEasing), label = "label")
    val coverAlpha by animateFloatAsState(if (open) 1f else 0f, if (open) tween(280, delayMillis = 60, easing = OutEasing) else tween(160), label = "cover")
    val pillAlpha by animateFloatAsState(if (open && pill != null) 1f else 0f, if (open) tween(240, delayMillis = 220, easing = OutEasing) else tween(120), label = "pill")

    val density = LocalDensity.current
    val fsDp = if (vertical) (thickness.value * 0.42f).coerceIn(9f, 15f) else (thickness.value * 0.37f).coerceIn(7f, 13f)
    val fs = with(density) { fsDp.dp.toSp() }   // sized to the spine, not to the system font scale

    Box(
        modifier
            .then(if (vertical) Modifier.fillMaxWidth().height(size) else Modifier.fillMaxHeight().width(size))
            .clipToBounds()
            .drawBehind { drawSpine(base, ink, vertical, band, cross.toPx(), pressed) }
            .clickable(interactionSource = interaction, indication = null, onClick = onTap)
            .semantics { contentDescription = "${a.artist}, ${a.title}" },
    ) {
        if (labelAlpha > 0f) {
            val labelRow: @Composable () -> Unit = {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        a.artist.uppercase(), color = ink, fontSize = fs, fontWeight = FontWeight.Bold,
                        letterSpacing = .12.em, maxLines = 1, softWrap = false,
                    )
                    Spacer(Modifier.width((fsDp * 0.9f).dp))
                    Text(
                        a.title, color = ink.copy(alpha = .82f),
                        fontSize = if (serif) fs * 1.12f else fs,
                        fontFamily = if (serif) FontFamily.Serif else FontFamily.Default,
                        fontStyle = if (serif) FontStyle.Italic else FontStyle.Normal,
                        maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false),
                    )
                }
            }
            if (vertical) {
                Box(
                    Modifier.fillMaxSize().padding(start = cross * .06f, end = cross * .13f).graphicsLayer { alpha = labelAlpha },
                    contentAlignment = Alignment.CenterStart,
                ) { labelRow() }
                // the label's mark: a thin rule (a box at the end of a row reads as a checkbox)
                Box(
                    Modifier.align(Alignment.CenterEnd).padding(end = cross * .045f).width(2.dp).fillMaxHeight(.44f)
                        .graphicsLayer { alpha = labelAlpha * .3f }.background(ink, RoundedCornerShape(1.dp)),
                )
            } else {
                Box(
                    Modifier.fillMaxSize().padding(top = cross * .05f, bottom = cross * .12f).graphicsLayer { alpha = labelAlpha },
                    contentAlignment = Alignment.TopCenter,
                ) { Box(Modifier.verticalText()) { labelRow() } }
                if (thickness >= 13.dp) Box(
                    Modifier.align(Alignment.BottomCenter).padding(bottom = cross * .035f).fillMaxWidth(.56f).height(thickness * .56f)
                        .graphicsLayer { alpha = labelAlpha * .38f }.border(1.dp, ink, RoundedCornerShape(1.dp)),
                )
            }
        }
        if (coverAlpha > 0f) {
            if (artUrl != null) {
                AsyncImage(
                    model = artUrl, contentDescription = null, contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize().graphicsLayer { alpha = coverAlpha },
                )
            } else {
                Column(
                    Modifier.fillMaxSize().graphicsLayer { alpha = coverAlpha }.background(base).padding(cross * .09f),
                    verticalArrangement = Arrangement.Bottom,
                ) {
                    Text(a.title, color = ink, fontFamily = FontFamily.Serif, fontSize = with(density) { (cross * .075f).toSp() }, lineHeight = 1.05.em)
                    Text(a.artist, color = ink.copy(alpha = .8f), fontSize = with(density) { (cross * .042f).toSp() })
                }
            }
        }
        if (pillAlpha > 0f && pill != null) {
            Row(
                Modifier.align(Alignment.BottomCenter).padding(bottom = cross * .06f)
                    .graphicsLayer { alpha = pillAlpha; translationY = (1f - pillAlpha) * 6.dp.toPx() }
                    .clip(RoundedCornerShape(50)).background(Color(0x99141414))
                    .padding(start = 10.dp, end = 12.dp, top = 6.dp, bottom = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(7.dp),
            ) {
                if (pill != "Tap for tracks") Eq(playing)
                Text(pill, color = Color.White.copy(alpha = .92f), fontSize = 12.sp, fontWeight = FontWeight.Medium)
            }
        }
    }
}

private fun DrawScope.drawSpine(base: Color, ink: Color, vertical: Boolean, band: Boolean, cross: Float, pressed: Boolean) {
    drawRect(base)
    val across = arrayOf(0f to Color.White.copy(alpha = .13f), .16f to Color.White.copy(alpha = .02f), .62f to Color.Transparent, 1f to Color.Black.copy(alpha = .42f))
    val along = listOf(Color.White.copy(alpha = .05f), Color.Black.copy(alpha = .18f))
    if (vertical) {   // light falls on the top edge of each strip
        drawRect(Brush.verticalGradient(*across))
        drawRect(Brush.horizontalGradient(along))
        drawLine(Color.Black.copy(alpha = .65f), Offset(0f, size.height - .5f), Offset(size.width, size.height - .5f), 1f)
        drawLine(Color.White.copy(alpha = .07f), Offset(0f, .5f), Offset(size.width, .5f), 1f)
        if (band) drawRect(ink.copy(alpha = .16f), size = Size(cross * .04f, size.height))
    } else {
        drawRect(Brush.horizontalGradient(*across))
        drawRect(Brush.verticalGradient(along))
        drawLine(Color.Black.copy(alpha = .65f), Offset(size.width - .5f, 0f), Offset(size.width - .5f, size.height), 1f)
        drawLine(Color.White.copy(alpha = .07f), Offset(.5f, 0f), Offset(.5f, size.height), 1f)
        if (band) drawRect(ink.copy(alpha = .16f), size = Size(size.width, cross * .045f))
    }
    if (pressed) drawRect(Color.White.copy(alpha = .08f))
}

/** Three bars that bounce while the album plays and rest when paused. */
@Composable
fun Eq(playing: Boolean) {
    val t = rememberInfiniteTransition(label = "eq")
    Row(Modifier.height(10.dp), horizontalArrangement = Arrangement.spacedBy(2.dp), verticalAlignment = Alignment.Bottom) {
        listOf(0, 350, 700).forEach { offset ->
            val s by t.animateFloat(
                .3f, 1f,
                infiniteRepeatable(tween(500, easing = FastOutSlowInEasing), RepeatMode.Reverse, StartOffset(offset)),
                label = "bar",
            )
            Box(Modifier.width(2.dp).fillMaxHeight(if (playing) s else .35f).background(Color.White, RoundedCornerShape(1.dp)))
        }
    }
}

/** Lays text out rotated a quarter turn, reading top to bottom, taking the rotated space. */
fun Modifier.verticalText() = layout { measurable, constraints ->
    val p = measurable.measure(Constraints(maxWidth = constraints.maxHeight, maxHeight = constraints.maxWidth))
    layout(p.height, p.width) {
        p.placeWithLayer(-(p.width - p.height) / 2, (p.width - p.height) / 2) { rotationZ = 90f }
    }
}
