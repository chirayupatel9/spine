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
}
