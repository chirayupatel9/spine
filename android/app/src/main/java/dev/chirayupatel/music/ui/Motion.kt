package dev.chirayupatel.music.ui

import android.provider.Settings
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.InteractionSource
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import kotlin.math.PI
import kotlin.math.min
import kotlin.math.sin

/** Whether the phone allows animation (Settings → Accessibility → Remove animations turns it off). */
@Composable
fun motionAllowed(): Boolean {
    val ctx = LocalContext.current
    return remember { Settings.Global.getFloat(ctx.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) > 0f }
}

/* ---------------------------------------------------------------- press feedback
   Anything you can press shrinks a touch under your finger (to 97%), so the app shows it heard you
   the moment you touch, not when you let go. In fast, back a little slower, on the ease-out curve. */

fun Modifier.pressScale(interaction: InteractionSource, scale: Float = .97f): Modifier = composed {
    val pressed by interaction.collectIsPressedAsState()
    val s by animateFloatAsState(if (pressed) scale else 1f, tween(if (pressed) 100 else 160, easing = OutEasing), label = "press")
    graphicsLayer { scaleX = s; scaleY = s }
}

/** clickable, with the press feedback. Put it before clip/background so they shrink together. */
fun Modifier.pressable(onClickLabel: String? = null, scale: Float = .97f, onClick: () -> Unit): Modifier = composed {
    val src = remember { MutableInteractionSource() }
    pressScale(src, scale).clickable(src, LocalIndication.current, onClickLabel = onClickLabel, onClick = onClick)
}

/* ---------------------------------------------------------------- the wiggly progress line
   The played part of a progress line waves while the music plays and settles into a straight line
   when it stops, like Android's own media player; the rest is a faint straight line. The wave drifts
   at a constant speed (one wavelength per `period` ms), rises when the music starts and settles a
   little faster when it stops. */

class Wave(val phase: State<Float>, val lift: State<Float>)

@Composable
fun rememberWave(playing: Boolean, period: Int = 1600): Wave {
    val motion = motionAllowed()
    val on = playing && motion
    val lift = animateFloatAsState(if (on) 1f else 0f, tween(if (on) 320 else 200, easing = OutEasing), label = "wave")
    val phase = remember { mutableFloatStateOf(0f) }
    LaunchedEffect(on) {
        if (!on) return@LaunchedEffect
        var last = withFrameNanos { it }
        while (true) {
            val now = withFrameNanos { it }
            phase.floatValue = (phase.floatValue + (now - last) / 1_000_000f / period) % 1f
            last = now
        }
    }
    return remember(phase, lift) { Wave(phase, lift) }
}

/** Draws the line across the middle of the area: the played part (`fraction`, 0 to 1) as a wave of
 *  `amplitude` px, the rest straight. Read the wave's state here, in drawing, so only drawing repeats. */
fun DrawScope.drawWave(
    fraction: Float, wave: Wave, amplitude: Float, wavelength: Float, stroke: Float, color: Color, rest: Color,
) {
    val y = size.height / 2
    val x = size.width * fraction.coerceIn(0f, 1f)
    if (x < size.width) drawLine(rest, Offset(x, y), Offset(size.width, y), stroke, StrokeCap.Round)
    if (x <= 0f) return
    val a = amplitude * wave.lift.value
    if (a < .4f) { drawLine(color, Offset(0f, y), Offset(x, y), stroke, StrokeCap.Round); return }
    val phase = wave.phase.value
    val k = 2f * PI.toFloat() / wavelength
    val path = Path()
    path.moveTo(0f, y + a * sin(k * 0f + 2f * PI.toFloat() * phase))
    var px = 0f
    while (px < x) {
        px = min(px + 2f, x)
        path.lineTo(px, y + a * sin(k * px + 2f * PI.toFloat() * phase))
    }
    drawPath(path, color, style = Stroke(stroke, cap = StrokeCap.Round, join = StrokeJoin.Round))
}
