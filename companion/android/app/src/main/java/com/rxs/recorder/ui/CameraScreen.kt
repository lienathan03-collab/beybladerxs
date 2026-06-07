package com.rxs.recorder.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.rxs.recorder.CameraCapabilities
import com.rxs.recorder.RecorderController

private val REQUIRED = arrayOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO)

private fun hasAll(context: android.content.Context) = REQUIRED.all {
    ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED
}

@Composable
fun CameraScreen() {
    val context = LocalContext.current
    var granted by remember { mutableStateOf(hasAll(context)) }

    val launcher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { granted = hasAll(context) }

    LaunchedEffect(Unit) { if (!granted) launcher.launch(REQUIRED) }

    if (!granted) {
        Box(Modifier.fillMaxSize().background(Color.Black), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text("Camera + microphone permission required.", color = Color.White)
                Spacer(Modifier.size(12.dp))
                Button(onClick = { launcher.launch(REQUIRED) }) { Text("Grant") }
            }
        }
        return
    }

    RecorderSurface()
}

@Composable
private fun RecorderSurface() {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current

    val caps = remember { CameraCapabilities.query(context) }
    if (caps == null) {
        Box(Modifier.fillMaxSize().background(Color.Black), contentAlignment = Alignment.Center) {
            Text("No usable camera found.", color = Color.White)
        }
        return
    }

    val controller = remember { RecorderController(context, caps) }
    val state by controller.state.collectAsState()
    val previewView = remember {
        PreviewView(context).apply {
            implementationMode = PreviewView.ImplementationMode.COMPATIBLE
            scaleType = PreviewView.ScaleType.FILL_CENTER
        }
    }

    LaunchedEffect(Unit) { controller.bind(lifecycleOwner, previewView) }
    DisposableEffect(Unit) { onDispose { controller.release() } }

    var showCaps by remember { mutableStateOf(false) }

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        AndroidView(
            factory = { previewView },
            modifier = Modifier
                .fillMaxSize()
                .pointerInput(Unit) {
                    detectTapGestures { offset ->
                        controller.focus(
                            previewView.meteringPointFactory.createPoint(offset.x, offset.y)
                        )
                    }
                }
                .pointerInput(Unit) {
                    detectTransformGestures { _, _, zoom, _ -> controller.pinch(zoom) }
                }
        )

        // ── Top status bar (overlay only — never in the saved video) ──
        Row(
            Modifier
                .align(Alignment.TopCenter)
                .fillMaxWidth()
                .padding(12.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Pill {
                if (state.isRecording) {
                    Box(Modifier.size(10.dp).background(Color(0xFFFF3B49), CircleShape))
                    Spacer(Modifier.width(6.dp))
                }
                Mono(formatTimer(state.elapsedMs))
            }
            Pill {
                val req = state.profile.label
                val actual = state.actualResolution?.let { " • $it" } ?: ""
                Mono("$req$actual")
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Pill {
                    val mic = when {
                        !state.micAvailable -> "MIC OFF"
                        state.micActive -> "MIC ●"
                        else -> "MIC ○"
                    }
                    Mono(mic)
                }
                Spacer(Modifier.width(8.dp))
                Pill { Mono("${state.freeBytes / (1024 * 1024)}MB") }
            }
        }

        // ── Warnings / errors ──
        state.warning?.let {
            Pill(modifier = Modifier.align(Alignment.TopCenter).padding(top = 56.dp)) {
                Mono(it, color = Color(0xFFFFC857))
            }
        }
        state.error?.let {
            Pill(modifier = Modifier.align(Alignment.Center)) {
                Mono(it, color = Color(0xFFFF8891))
            }
        }

        // ── Record button ──
        Box(
            Modifier
                .align(Alignment.BottomCenter)
                .padding(bottom = 24.dp)
                .size(78.dp)
                .background(Color(0x55000000), CircleShape)
                .pointerInput(Unit) { detectTapGestures { controller.toggleRecording() } },
            contentAlignment = Alignment.Center
        ) {
            val inner = if (state.isRecording) RoundedCornerShape(8.dp) else CircleShape
            Box(
                Modifier
                    .size(if (state.isRecording) 34.dp else 60.dp)
                    .background(Color(0xFFFF3B49), inner)
                    .border(3.dp, Color.White, inner)
            )
        }

        // ── Capabilities dump (for Phase 3–5 report) ──
        Pill(
            modifier = Modifier
                .align(Alignment.BottomStart)
                .padding(12.dp)
                .pointerInput(Unit) { detectTapGestures { showCaps = !showCaps } }
        ) { Mono(if (showCaps) "CAPS ▲" else "CAPS ▼") }

        if (showCaps) {
            Box(
                Modifier
                    .align(Alignment.BottomStart)
                    .padding(start = 12.dp, bottom = 52.dp)
                    .background(Color(0xCC000000), RoundedCornerShape(10.dp))
                    .padding(12.dp)
            ) {
                Mono(controller.capsDescription(), size = 10)
            }
        }

        if (state.lastUri != null && !state.isRecording) {
            Pill(modifier = Modifier.align(Alignment.BottomEnd).padding(12.dp)) {
                Mono("Saved → Gallery/Movies/RXS", color = Color(0xFF7FF0A6))
            }
        }
    }
}

@Composable
private fun Pill(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Row(
        modifier
            .background(Color(0xAA05070C), RoundedCornerShape(12.dp))
            .padding(horizontal = 10.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically
    ) { content() }
}

@Composable
private fun Mono(text: String, color: Color = Color.White, size: Int = 12) {
    Text(
        text = text,
        color = color,
        fontFamily = FontFamily.Monospace,
        fontWeight = FontWeight.Bold,
        fontSize = size.sp
    )
}

private fun formatTimer(ms: Long): String {
    val totalSec = ms / 1000
    val m = totalSec / 60
    val s = totalSec % 60
    return "%02d:%02d".format(m, s)
}
