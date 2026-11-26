package dev.chirayupatel.music.ui

import android.provider.Settings
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import kotlin.math.max
import kotlin.math.min

/**
 * A record. The grooves and the light on them stay still; only the label turns. It spins up over
 * half a second when the music starts and coasts to a stop when it pauses, rather than freezing
 * mid-turn. 33⅓ rpm is 1.8 s a turn.
 */
@Composable
fun Vinyl(art: String?, color: Color, spinning: Boolean, modifier: Modifier = Modifier, onTap: (() -> Unit)? = null) {
    val ctx = LocalContext.current
    val motion = remember { Settings.Global.getFloat(ctx.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) > 0f }
    val turn = remember { mutableFloatStateOf(0f) }    // degrees
    val speed = remember { floatArrayOf(0f) }          // share of full speed, kept between runs
    LaunchedEffect(spinning) {
        val target = if (spinning && motion) 1f else 0f
        if (speed[0] == 0f && target == 0f) return@LaunchedEffect
        var last = withFrameNanos { it }
        while (true) {
            val now = withFrameNanos { it }
            val dt = ((now - last) / 1_000_000f).coerceAtMost(50f)
            last = now
            val s = speed[0]
            speed[0] = if (target > s) min(target, s + dt / 500f) else max(target, s - dt / 1100f)
            turn.floatValue = (turn.floatValue + speed[0] * dt * 0.2f) % 360f   // 360° per 1800 ms
            if (speed[0] == 0f) break
        }
    }
    Box(
        modifier.shadow(12.dp, CircleShape).clip(CircleShape)
            .then(if (onTap != null) Modifier.clickable(remember { MutableInteractionSource() }, indication = null, onClick = onTap) else Modifier)
            .drawBehind { drawGrooves() },
    ) {
        // faint unevenness in the grooves turns with the label: above a sleeve, it's what shows the turning
        Box(Modifier.matchParentSize().graphicsLayer { rotationZ = turn.floatValue }.drawBehind { drawGrain() })
        Box(
            Modifier.align(Alignment.Center).fillMaxSize(.36f)
                .graphicsLayer { rotationZ = turn.floatValue }   // only this layer redraws as it turns
                .clip(CircleShape).background(color),
        ) {
            if (art != null) AsyncImage(model = art, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        }
        Box(Modifier.matchParentSize().drawBehind { drawSheen() })
    }
}

private fun DrawScope.drawGrooves() {
    val r = size.minDimension / 2
    if (r < 1f) return
    val c = center
    drawCircle(Brush.radialGradient(0f to Color(0xFF1D1C1B), .72f to Color(0xFF0B0B0B), 1f to Color(0xFF151515), center = c, radius = r), r, c)
    val step = max(2.5f, r / 90f)
    var g = r * .37f
    while (g < r * .95f) { drawCircle(Color.White.copy(alpha = .028f), g, c, style = Stroke(1f)); g += step }
    for (f in floatArrayOf(.52f, .68f, .82f)) drawCircle(Color.White.copy(alpha = .05f), r * f, c, style = Stroke(r * .012f))   // the gaps between tracks
    drawCircle(Color.White.copy(alpha = .08f), r * .965f, c, style = Stroke(r * .014f))   // the lip
}

private fun DrawScope.drawGrain() {
    val r = size.minDimension / 2
    if (r < 1f) return
    val inner = r * .37f
    val outer = r * .94f
    drawCircle(
        Brush.sweepGradient(
            0f to Color.Transparent, .05f to Color.Transparent, .09f to Color.White.copy(alpha = .075f), .14f to Color.Transparent,
            .31f to Color.Transparent, .36f to Color.Black.copy(alpha = .34f), .42f to Color.Transparent,
            .56f to Color.Transparent, .61f to Color.White.copy(alpha = .055f), .66f to Color.Transparent,
            .79f to Color.Transparent, .84f to Color.Black.copy(alpha = .28f), .9f to Color.Transparent, 1f to Color.Transparent,
            center = center,
        ),
        radius = (outer + inner) / 2, center = center, style = Stroke(width = outer - inner),
    )
}

private fun DrawScope.drawSheen() {
    val r = size.minDimension / 2
    if (r < 1f) return
    val inner = r * .36f
    drawCircle(
        Brush.sweepGradient(
            0f to Color.Transparent, .06f to Color.Transparent, .12f to Color.White.copy(alpha = .13f), .19f to Color.Transparent,
            .5f to Color.Transparent, .62f to Color.White.copy(alpha = .09f), .7f to Color.Transparent, 1f to Color.Transparent,
            center = center,
        ),
        radius = (r + inner) / 2, center = center, style = Stroke(width = r - inner),
    )
    drawCircle(Palette.Bg, r * .036f, center)   // the spindle hole
    drawCircle(Color.White.copy(alpha = .12f), r * .036f, center, style = Stroke(1f))
}
