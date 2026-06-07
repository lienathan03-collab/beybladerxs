package com.rxs.recorder.ui

import android.net.Uri
import androidx.annotation.OptIn
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.SeekParameters
import androidx.media3.ui.PlayerView

private const val FRAME_MS = 33L // ~1 frame at 30fps

/**
 * Full-screen review of the just-recorded clip. Play/pause + scrub come from the
 * built-in PlayerView controls; the extra buttons step one frame at a time, using
 * frame-accurate (EXACT) seeking — the tool for judging close aerials.
 */
@OptIn(UnstableApi::class)
@Composable
fun ReviewOverlay(uri: Uri, onClose: () -> Unit) {
    val context = LocalContext.current
    val player = remember {
        ExoPlayer.Builder(context).build().apply {
            setSeekParameters(SeekParameters.EXACT)
            setMediaItem(MediaItem.fromUri(uri))
            prepare()
            playWhenReady = false
        }
    }
    DisposableEffect(Unit) { onDispose { player.release() } }

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        AndroidView(
            factory = { ctx ->
                PlayerView(ctx).apply {
                    this.player = player
                    setShowNextButton(false)
                    setShowPreviousButton(false)
                }
            },
            modifier = Modifier.fillMaxSize()
        )

        Row(
            Modifier.align(Alignment.BottomCenter).padding(bottom = 28.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Button(onClick = {
                player.playWhenReady = false
                player.seekTo((player.currentPosition - FRAME_MS).coerceAtLeast(0))
            }) { Text("◀ Frame") }

            Button(onClick = {
                player.playWhenReady = false
                player.seekTo(player.currentPosition + FRAME_MS)
            }) { Text("Frame ▶") }

            Button(onClick = onClose) { Text("Close") }
        }
    }
}
