package com.pacesync.app.ui.common

import android.graphics.BitmapFactory
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalContext
import com.pacesync.app.R

// A seamlessly-tiled background image that shifts vertically in lockstep
// with a scrollable container's own scroll position — drag the content
// down, the background moves down with it; drag up, it moves up; it never
// runs out of image because a BitmapShader with TileMode.REPEAT wraps the
// source image infinitely in both directions.
//
// `dim` (0..1) lays the app's background colour over the image to make it fainter.
//
// Two overloads: one for LazyColumn and one for a plain Column.verticalScroll
// (ScrollState.value IS already a continuous pixel offset, used as-is).
//
// The LazyColumn overload used to reconstruct a continuous offset from
// LazyListState's index + per-item scrollOffset, which always has some
// mismatch against the actual pixels the list consumes per scroll gesture
// (assumed row heights, or even real-but-only-approximately-right summed
// heights) — any reconstruction can drift from what's really on screen.
// Fixed for real by not reconstructing anything: a NestedScrollConnection
// sees the EXACT pixel delta the list is about to consume for every single
// scroll event (pre-scroll, before the list applies it), so accumulating
// that is byte-for-byte the same number driving the list's own motion —
// nothing to drift out of sync with.
@Composable
fun ScrollingBackground(
    imageRes: Int = R.drawable.apk_background,
    dim: Float = 0f,
    content: @Composable (Modifier) -> Unit,
) {
    var scrollPx by remember { mutableFloatStateOf(0f) }
    val nestedScrollConnection = remember {
        object : NestedScrollConnection {
            override fun onPreScroll(available: androidx.compose.ui.geometry.Offset, source: NestedScrollSource): androidx.compose.ui.geometry.Offset {
                scrollPx -= available.y
                return androidx.compose.ui.geometry.Offset.Zero
            }
        }
    }
    ScrollingBackgroundImpl(scrollPx, imageRes, dim, Modifier.nestedScroll(nestedScrollConnection)) { m -> content(m) }
}

@Composable
fun ScrollingBackground(
    scrollState: ScrollState,
    imageRes: Int = R.drawable.apk_background,
    dim: Float = 0f,
    content: @Composable () -> Unit,
) {
    ScrollingBackgroundImpl(scrollState.value.toFloat(), imageRes, dim, Modifier) { content() }
}

@Composable
private fun ScrollingBackgroundImpl(scrollPx: Float, imageRes: Int, dim: Float, contentModifier: Modifier, content: @Composable (Modifier) -> Unit) {
    val resources = LocalContext.current.resources
    val androidBitmap = remember(imageRes) { BitmapFactory.decodeResource(resources, imageRes) }

    Box(Modifier.fillMaxSize()) {
        Canvas(Modifier.fillMaxSize()) {
            drawIntoCanvas { canvas ->
                val shader = android.graphics.BitmapShader(
                    androidBitmap,
                    android.graphics.Shader.TileMode.REPEAT,
                    android.graphics.Shader.TileMode.REPEAT,
                )
                val matrix = android.graphics.Matrix()
                // Scale the tile to fill the screen width, preserving aspect
                // ratio, so it reads as one coherent image rather than many
                // small repeats.
                val scale = size.width / androidBitmap.width.toFloat()
                matrix.setScale(scale, scale)
                // Shift the tile by the scroll offset, negated — as scrollPx
                // increases the content itself moves up on screen (you're
                // revealing further-down items), so the background must
                // move up too (negative Y) to stay locked to the content
                // (1:1, not a fractional parallax, and not the opposite
                // direction which is what a positive shift here produced).
                matrix.postTranslate(0f, -scrollPx)
                shader.setLocalMatrix(matrix)
                val paint = android.graphics.Paint().apply {
                    this.shader = shader
                    // Dim to 85% brightness so text/cards drawn over it stay
                    // readable, via a scaling-only ColorMatrix (RGB * 0.85,
                    // alpha untouched).
                    colorFilter = android.graphics.ColorMatrixColorFilter(
                        android.graphics.ColorMatrix(
                            floatArrayOf(
                                0.85f, 0f, 0f, 0f, 0f,
                                0f, 0.85f, 0f, 0f, 0f,
                                0f, 0f, 0.85f, 0f, 0f,
                                0f, 0f, 0f, 1f, 0f,
                            ),
                        ),
                    )
                }
                canvas.nativeCanvas.drawRect(0f, 0f, size.width, size.height, paint)
                // Dim: the app's background colour over the image, so it reads as a faint texture.
                if (dim > 0f) {
                    val scrim = android.graphics.Paint().apply { color = 0xFF0F172A.toInt(); alpha = (dim.coerceIn(0f, 1f) * 255).toInt() }
                    canvas.nativeCanvas.drawRect(0f, 0f, size.width, size.height, scrim)
                }
            }
        }
        content(contentModifier)
    }
}
