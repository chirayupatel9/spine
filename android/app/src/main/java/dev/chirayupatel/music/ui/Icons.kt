package dev.chirayupatel.music.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

/** The same 24x24 icons as the web app's sprite. */
object AvIcons {
    private fun icon(name: String, fill: List<String> = emptyList(), stroke: List<String> = emptyList()): ImageVector {
        val b = ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f)
        for (d in fill) b.addPath(pathData = addPathNodes(d), fill = SolidColor(Color.White))
        for (d in stroke) b.addPath(
            pathData = addPathNodes(d), stroke = SolidColor(Color.White), strokeLineWidth = 1.6f,
            strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round,
        )
        return b.build()
    }

    val Play = icon("play", fill = listOf("M8 5.5v13l11-6.5z"))
    val Pause = icon("pause", fill = listOf("M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"))
    val Next = icon("next", fill = listOf("M6 6l8.5 6L6 18zM16 6h2.2v12H16z"))
    val Prev = icon("prev", fill = listOf("M18 6l-8.5 6L18 18zM5.8 6H8v12H5.8z"))
    val Shuffle = icon("shuffle", stroke = listOf(
        "M4 7h3.5c2 0 3.2 1 4.3 2.7l2.4 4.6c.9 1.7 2 2.7 4 2.7H20M4 17h3.5c1.6 0 2.6-.6 3.4-1.7M14.6 8.7C15.4 7.6 16.4 7 18 7h2M17.5 4.5 20 7l-2.5 2.5M17.5 14.5 20 17l-2.5 2.5"))
    val Wall = icon("wall", stroke = listOf("M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"))
    val Gear = icon("gear", stroke = listOf(
        "M15 12a3 3 0 1 1-6 0a3 3 0 1 1 6 0",
        "M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"))
    val Search = icon("search", stroke = listOf("M16.5 10.5a6 6 0 1 1-12 0a6 6 0 1 1 12 0", "M15 15l5 5"))
    val Close = icon("close", stroke = listOf("M6 6l12 12M18 6 6 18"))
    val Chevron = icon("chevron", stroke = listOf("M7 10l5 5 5-5"))
    val Down = icon("down", stroke = listOf("M6 9.5l6 6 6-6"))
    val List = icon("list", stroke = listOf("M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01"))
    val Repeat = icon("repeat", stroke = listOf("M4.5 10.5V9.5a3 3 0 0 1 3-3h11M15.5 3.5l3 3-3 3M19.5 13.5v1a3 3 0 0 1-3 3h-11M8.5 20.5l-3-3 3-3"))

    // speakers: where the music plays
    val Speaker = icon("speaker", stroke = listOf(
        "M8.5 3h7A2.5 2.5 0 0 1 18 5.5v13a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 6 18.5v-13A2.5 2.5 0 0 1 8.5 3z",
        "M15 14a3 3 0 1 1-6 0a3 3 0 1 1 6 0"), fill = listOf("M13 7.2a1 1 0 1 1-2 0a1 1 0 1 1 2 0"))
    val Phone = icon("phone", stroke = listOf("M9.2 2.8h5.6a2.2 2.2 0 0 1 2.2 2.2v14a2.2 2.2 0 0 1-2.2 2.2H9.2A2.2 2.2 0 0 1 7 19V5a2.2 2.2 0 0 1 2.2-2.2z", "M10.6 17.8h2.8"))
    val Computer = icon("computer", stroke = listOf("M6.1 5h11.8a1.6 1.6 0 0 1 1.6 1.6v7.3a1.6 1.6 0 0 1-1.6 1.6H6.1a1.6 1.6 0 0 1-1.6-1.6V6.6A1.6 1.6 0 0 1 6.1 5z", "M2.8 18.8h18.4"))
    val Tv = icon("tv", stroke = listOf("M4.8 4.5h14.4a1.8 1.8 0 0 1 1.8 1.8v8.9a1.8 1.8 0 0 1-1.8 1.8H4.8A1.8 1.8 0 0 1 3 15.2V6.3a1.8 1.8 0 0 1 1.8-1.8z", "M8.5 20.5h7"))
    val Headphones = icon("headphones", stroke = listOf(
        "M4.5 16v-3.5a7.5 7.5 0 0 1 15 0V16",
        "M5.1 13.5h1a1.6 1.6 0 0 1 1.6 1.6v3.8a1.6 1.6 0 0 1-1.6 1.6h-1a1.6 1.6 0 0 1-1.6-1.6v-3.8a1.6 1.6 0 0 1 1.6-1.6z",
        "M17.9 13.5h1a1.6 1.6 0 0 1 1.6 1.6v3.8a1.6 1.6 0 0 1-1.6 1.6h-1a1.6 1.6 0 0 1-1.6-1.6v-3.8a1.6 1.6 0 0 1 1.6-1.6z"))
    val Check = icon("check", stroke = listOf("M5 12.5l4.5 4.5L19 7.5"))

    fun forKind(k: dev.chirayupatel.music.device.Speakers.Kind) = when (k) {
        dev.chirayupatel.music.device.Speakers.Kind.PHONE -> Phone
        dev.chirayupatel.music.device.Speakers.Kind.HEADPHONES -> Headphones
        dev.chirayupatel.music.device.Speakers.Kind.COMPUTER -> Computer
        dev.chirayupatel.music.device.Speakers.Kind.TV -> Tv
        dev.chirayupatel.music.device.Speakers.Kind.SPEAKER -> Speaker
    }
}
