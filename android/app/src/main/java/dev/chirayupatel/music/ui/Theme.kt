package dev.chirayupatel.music.ui

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/** The web app's palette, so the two feel like one product. */
object Palette {
    val Bg = Color(0xFF0C0A08)
    val Card = Color(0xFF151311)
    val Field = Color(0xFF1C1A17)
    val Ink = Color.White.copy(alpha = .92f)
    val Muted = Color.White.copy(alpha = .5f)
    val Faint = Color.White.copy(alpha = .28f)
    val Line = Color.White.copy(alpha = .09f)
    val Accent = Color(0xFFF04F23)
    val AccentSoft = Color(0xFFF04F23).copy(alpha = .55f)
}

/** Same curves as the web: a strong ease-out for anything the user starts. */
val OpenEasing = CubicBezierEasing(.32f, .72f, 0f, 1f)
val OutEasing = CubicBezierEasing(.23f, 1f, .32f, 1f)
const val OPEN_MS = 480

@Composable
fun AlbumViewerTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = Palette.Accent, onPrimary = Color.White,
            secondary = Palette.Accent, onSecondary = Color.White,
            background = Palette.Bg, onBackground = Palette.Ink,
            surface = Palette.Card, onSurface = Palette.Ink,
            surfaceVariant = Palette.Field, onSurfaceVariant = Palette.Muted,
            surfaceContainerLow = Palette.Card, surfaceContainer = Palette.Card, surfaceContainerHigh = Palette.Field,
            outline = Palette.Line,
        ),
        content = content,
    )
}

fun parseColor(hex: String?, fallback: Color = Color(0xFF333333)): Color =
    try { Color(android.graphics.Color.parseColor(hex)) } catch (e: Exception) { fallback }
