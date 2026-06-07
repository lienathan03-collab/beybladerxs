package com.rxs.recorder

import android.annotation.SuppressLint
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.hardware.camera2.CaptureRequest
import android.os.Build
import android.os.Environment
import android.os.StatFs
import android.provider.MediaStore
import android.util.Range
import androidx.camera.camera2.interop.Camera2Interop
import androidx.camera.camera2.interop.ExperimentalCamera2Interop
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.FocusMeteringAction
import androidx.camera.core.MeteringPoint
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.video.AudioStats
import androidx.camera.video.FallbackStrategy
import androidx.camera.video.MediaStoreOutputOptions
import androidx.camera.video.Quality
import androidx.camera.video.QualitySelector
import androidx.camera.video.Recorder
import androidx.camera.video.Recording
import androidx.camera.video.VideoCapture
import androidx.camera.video.VideoRecordEvent
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.suspendCancellableCoroutine
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

data class RecorderState(
    val profile: RecordingProfile,
    val actualResolution: String? = null,   // negotiated, read back from CameraX after bind
    val isRecording: Boolean = false,
    val elapsedMs: Long = 0,
    val bytes: Long = 0,
    val micAvailable: Boolean = false,
    val micActive: Boolean = false,
    val freeBytes: Long = 0,
    val lastUri: String? = null,
    val zoomRatio: Float = 1f,
    val maxZoom: Float = 1f,
    val warning: String? = null,             // non-fatal (e.g. low storage)
    val error: String? = null
)

/**
 * Recorder-only CameraX controller (Phase 2). No scoring, no overlay compositing —
 * MediaRecorder/Recorder captures the camera stream only, so any Compose overlay
 * drawn on top is never in the saved file (the "clean video" rule, trivially met
 * for a recorder-only prototype).
 */
class RecorderController(
    private val context: Context,
    private val caps: CameraCaps
) {
    private val MIN_FREE_BYTES_BLOCK = 200L * 1024 * 1024   // block start under 200 MB
    private val MIN_FREE_BYTES_WARN = 1024L * 1024 * 1024   // warn under 1 GB

    private val _state = MutableStateFlow(
        RecorderState(profile = caps.chosen, micAvailable = hasAudioPermission())
    )
    val state: StateFlow<RecorderState> = _state

    private val mainExec = ContextCompat.getMainExecutor(context)
    private var provider: ProcessCameraProvider? = null
    private var camera: Camera? = null
    private var videoCapture: VideoCapture<Recorder>? = null
    private var recording: Recording? = null

    fun capsDescription(): String = caps.describe()

    @OptIn(ExperimentalCamera2Interop::class)
    suspend fun bind(lifecycleOwner: LifecycleOwner, previewView: PreviewView) {
        val cameraProvider = awaitProvider()
        provider = cameraProvider

        val preview = Preview.Builder().build().also {
            it.setSurfaceProvider(previewView.surfaceProvider)
        }

        val quality = when (caps.chosen.height) {
            2160 -> Quality.UHD
            1080 -> Quality.FHD
            720 -> Quality.HD
            else -> Quality.HIGHEST
        }
        val recorder = Recorder.Builder()
            .setQualitySelector(
                QualitySelector.from(quality, FallbackStrategy.lowerQualityOrHigherThan(Quality.HD))
            )
            .build()

        // Pin the AE target FPS range to the chosen fps so the encoder runs at the
        // rate we actually claim (verified from the file in Phase 4).
        val vcBuilder = VideoCapture.Builder(recorder)
        Camera2Interop.Extender(vcBuilder).setCaptureRequestOption(
            CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE,
            Range(caps.chosen.fps, caps.chosen.fps)
        )
        val vc = vcBuilder.build()

        cameraProvider.unbindAll()
        val cam = cameraProvider.bindToLifecycle(
            lifecycleOwner, CameraSelector.DEFAULT_BACK_CAMERA, preview, vc
        )
        camera = cam
        videoCapture = vc

        val maxZoom = cam.cameraInfo.zoomState.value?.maxZoomRatio ?: 1f
        _state.update {
            it.copy(
                actualResolution = "${caps.chosen.width}x${caps.chosen.height}",
                maxZoom = maxZoom
            )
        }
        refreshStorage()
    }

    @SuppressLint("MissingPermission")
    fun toggleRecording() {
        val vc = videoCapture ?: return
        recording?.let { it.stop(); recording = null; return }

        refreshStorage()
        if (_state.value.freeBytes in 1 until MIN_FREE_BYTES_BLOCK) {
            _state.update { it.copy(error = "Storage too low to start recording.") }
            return
        }

        val name = "RXS_" + SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())
        val values = ContentValues().apply {
            put(MediaStore.Video.Media.DISPLAY_NAME, name)
            put(MediaStore.Video.Media.MIME_TYPE, "video/mp4")
            if (Build.VERSION.SDK_INT >= 29) {
                put(MediaStore.Video.Media.RELATIVE_PATH, "Movies/RXS")
            }
        }
        val output = MediaStoreOutputOptions
            .Builder(context.contentResolver, MediaStore.Video.Media.EXTERNAL_CONTENT_URI)
            .setContentValues(values)
            .build()

        var pending = vc.output.prepareRecording(context, output)
        if (hasAudioPermission()) pending = pending.withAudioEnabled()

        recording = pending.start(mainExec) { event -> onRecordEvent(event) }
    }

    private fun onRecordEvent(event: VideoRecordEvent) {
        when (event) {
            is VideoRecordEvent.Start ->
                _state.update { it.copy(isRecording = true, elapsedMs = 0, bytes = 0, error = null) }

            is VideoRecordEvent.Status -> {
                val s = event.recordingStats
                val micActive = s.audioStats.audioState == AudioStats.AUDIO_STATE_ACTIVE
                _state.update {
                    it.copy(
                        elapsedMs = s.recordedDurationNanos / 1_000_000,
                        bytes = s.numBytesRecorded,
                        micActive = micActive
                    )
                }
                refreshStorage()
            }

            is VideoRecordEvent.Finalize -> {
                if (event.hasError()) {
                    _state.update {
                        it.copy(isRecording = false, error = "Recording failed (code ${event.error}).")
                    }
                } else {
                    _state.update {
                        it.copy(
                            isRecording = false,
                            lastUri = event.outputResults.outputUri.toString(),
                            error = null
                        )
                    }
                }
                refreshStorage()
            }
        }
    }

    fun focus(point: MeteringPoint) {
        val cam = camera ?: return
        runCatching {
            cam.cameraControl.startFocusAndMetering(FocusMeteringAction.Builder(point).build())
        }
    }

    /** [factor] is a relative pinch scale (>1 zoom in, <1 zoom out). */
    fun pinch(factor: Float) {
        val cam = camera ?: return
        val cur = cam.cameraInfo.zoomState.value?.zoomRatio ?: 1f
        val max = cam.cameraInfo.zoomState.value?.maxZoomRatio ?: 1f
        val target = (cur * factor).coerceIn(1f, max)
        cam.cameraControl.setZoomRatio(target)
        _state.update { it.copy(zoomRatio = target, maxZoom = max) }
    }

    fun release() {
        runCatching { recording?.stop() }
        recording = null
        runCatching { provider?.unbindAll() }
        camera = null
        videoCapture = null
    }

    private fun refreshStorage() {
        val free = runCatching {
            @Suppress("DEPRECATION")
            StatFs(Environment.getExternalStorageDirectory().path).availableBytes
        }.getOrDefault(0L)
        val warn = if (free in 1 until MIN_FREE_BYTES_WARN)
            "Low storage (${free / (1024 * 1024)} MB left)" else null
        _state.update { it.copy(freeBytes = free, warning = warn) }
    }

    private fun hasAudioPermission(): Boolean =
        ContextCompat.checkSelfPermission(context, android.Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED

    private suspend fun awaitProvider(): ProcessCameraProvider =
        suspendCancellableCoroutine { cont ->
            val future = ProcessCameraProvider.getInstance(context)
            future.addListener({
                try {
                    cont.resume(future.get())
                } catch (e: Exception) {
                    cont.resumeWithException(e)
                }
            }, mainExec)
        }
}
