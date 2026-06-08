package com.rxs.recorder.ui

import android.net.Uri
import androidx.annotation.OptIn
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.SeekParameters
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.delay

private const val FRAME_MS = 33L // ~1 frame at 30fps

/**
 * Full-screen review of the last clip. No built-in controller (so the video is
 * never greyed out). Dragging the bar scrubs frame-accurately (EXACT seek); pinch
 * to zoom; tiny ✕ + frame arrows so the footage stays visible.
 */
@OptIn(UnstableApi::class)
@Composable
fun ReviewOverlay(uri: Uri, onClose: () -> Unit) {
    val context = LocalContext.current
    val player = remember {
        ExoPlayer.Builder(context).build().apply {
            setSeekParameters(SeekParameters.EXACT)
            setMediaItem(MediaItem.fromUri(uri)); prepare(); playWhenReady = false
        }
    }
    DisposableEffect(Unit) { onDispose { player.release() } }

    var pos by remember { mutableLongStateOf(0L) }
    var dur by remember { mutableLongStateOf(1L) }
    var playing by remember { mutableStateOf(false) }
    var scale by remember { mutableFloatStateOf(1f) }
    var offset by remember { mutableStateOf(Offset.Zero) }

    LaunchedEffect(Unit) {
        while (true) {
            pos = player.currentPosition
            val d = player.duration
            if (d > 0) dur = d
            playing = player.isPlaying
            delay(60)
        }
    }

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        AndroidView(
            factory = { ctx -> PlayerView(ctx).apply { this.player = player; useController = false } },
            modifier = Modifier
                .fillMaxSize()
                .graphicsLayer(scaleX = scale, scaleY = scale, translationX = offset.x, translationY = offset.y)
                .pointerInput(Unit) {
                    detectTransformGestures { _, pan, zoom, _ ->
                        scale = (scale * zoom).coerceIn(1f, 5f)
                        offset = if (scale <= 1f) Offset.Zero else offset + pan
                    }
                }
        )

        // ✕ close, top-right
        Box(
            Modifier.align(Alignment.TopEnd)
                .windowInsetsPadding(WindowInsets.safeDrawing)
                .padding(10.dp)
                .background(Color(0x99000000), CircleShape)
                .clickable { onClose() }
                .padding(horizontal = 12.dp, vertical = 8.dp)
        ) { Text("✕", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 16.sp) }

        // bottom controls: play/pause · ◀ frame · scrub (drag = frame-accurate) · frame ▶
        Row(
            Modifier.align(Alignment.BottomCenter)
                .fillMaxWidth()
                .windowInsetsPadding(WindowInsets.safeDrawing)
                .padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            MiniBtn(if (playing) "❚❚" else "▶") { if (playing) player.pause() else player.play() }
            MiniBtn("◀|") { player.pause(); player.seekTo((pos - FRAME_MS).coerceAtLeast(0)) }
            Slider(
                value = pos.coerceIn(0L, dur).toFloat(),
                onValueChange = { player.pause(); player.seekTo(it.toLong()) },
                valueRange = 0f..dur.toFloat().coerceAtLeast(1f),
                modifier = Modifier.weight(1f)
            )
            MiniBtn("|▶") { player.pause(); player.seekTo(pos + FRAME_MS) }
        }
    }
}

@Composable
private fun MiniBtn(label: String, onClick: () -> Unit) {
    Box(
        Modifier
            .background(Color(0x99000000), CircleShape)
            .clickable { onClick() }
            .padding(horizontal = 10.dp, vertical = 6.dp)
    ) { Text(label, color = Color.White, fontWeight = FontWeight.Bold, fontSize = 13.sp) }
}
