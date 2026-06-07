package com.rxs.recorder

import android.content.Context
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.media.MediaRecorder
import android.os.Build
import android.util.Range
import android.util.Size

/**
 * Runtime camera capability query via Camera2.
 *
 * Phase-2 goal: NEVER claim a mode the device cannot produce. We read the
 * authoritative per-size max frame rate from the stream-configuration map's
 * minimum frame duration, plus the AE target-FPS ranges, and choose a normal
 * recording profile honestly. Slow-motion (high-speed) modes are reported
 * SEPARATELY and never used for normal recording (per spec + HONOR X7d note).
 */

data class RecordingProfile(val width: Int, val height: Int, val fps: Int) {
    val label: String get() = "${height}p@$fps"
}

data class SlowMoProfile(val size: Size, val fpsRanges: List<Range<Int>>)

data class CameraCaps(
    val cameraId: String,
    val normalSizes: List<Size>,
    val maxFpsBySize: Map<Size, Int>,
    val aeFpsRanges: List<Range<Int>>,
    val chosen: RecordingProfile,
    val slowMo: List<SlowMoProfile>,
    val hdr10: Boolean,
    val stabilizationModes: List<Int>
) {
    /** Human-readable dump for the Phase 3–5 device test report. */
    fun describe(): String {
        val sizesStr = normalSizes
            .sortedByDescending { it.width.toLong() * it.height }
            .joinToString(", ") { "${it.width}x${it.height}@${maxFpsBySize[it] ?: 30}" }
        val ae = aeFpsRanges.joinToString(", ") { "[${it.lower},${it.upper}]" }
        val slow = if (slowMo.isEmpty()) "none" else slowMo.joinToString(", ") { sp ->
            "${sp.size.width}x${sp.size.height}@" + sp.fpsRanges.joinToString("/") { "${it.upper}" }
        }
        return buildString {
            appendLine("Back camera id: $cameraId")
            appendLine("Chosen normal-record profile: ${chosen.label} (${chosen.width}x${chosen.height})")
            appendLine("Supported video sizes (size@maxfps): $sizesStr")
            appendLine("AE target FPS ranges: $ae")
            appendLine("HDR10 (10-bit) reported: ${if (hdr10) "yes" else "no"}")
            appendLine("Video stabilization modes: $stabilizationModes")
            appendLine("Slow-motion / high-speed (NOT used for normal recording): $slow")
        }
    }
}

object CameraCapabilities {

    fun query(context: Context): CameraCaps? {
        val cm = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val backId = cm.cameraIdList.firstOrNull {
            cm.getCameraCharacteristics(it)
                .get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_BACK
        } ?: cm.cameraIdList.firstOrNull() ?: return null

        val ch = cm.getCameraCharacteristics(backId)
        val map = ch.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP) ?: return null

        val sizes = (map.getOutputSizes(MediaRecorder::class.java) ?: emptyArray()).toList()
        val aeRanges = (ch.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES)
            ?: emptyArray()).toList()

        // Authoritative per-size max fps from min frame duration (ns).
        val maxFpsBySize = sizes.associateWith { s ->
            val minDur = runCatching { map.getOutputMinFrameDuration(MediaRecorder::class.java, s) }
                .getOrDefault(0L)
            if (minDur > 0L) Math.round(1_000_000_000.0 / minDur).toInt() else 30
        }
        val deviceSupports60 = aeRanges.any { it.upper >= 60 }

        val slow = (map.highSpeedVideoSizes ?: emptyArray()).map { s ->
            SlowMoProfile(s, (map.getHighSpeedVideoFpsRangesFor(s) ?: emptyArray()).toList())
        }

        val stab = (ch.get(CameraCharacteristics.CONTROL_AVAILABLE_VIDEO_STABILIZATION_MODES)
            ?: intArrayOf()).toList()

        val hdr10 = if (Build.VERSION.SDK_INT >= 33) {
            (ch.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES) ?: intArrayOf())
                .contains(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_DYNAMIC_RANGE_TEN_BIT)
        } else false

        return CameraCaps(
            cameraId = backId,
            normalSizes = sizes,
            maxFpsBySize = maxFpsBySize,
            aeFpsRanges = aeRanges,
            chosen = pickProfile(sizes, maxFpsBySize, deviceSupports60),
            slowMo = slow,
            hdr10 = hdr10,
            stabilizationModes = stab
        )
    }

    /** Spec preference chain: 4K/60 → 1080p/60 → 1080p/30 → (else) largest@its max (capped 30). */
    private fun pickProfile(
        sizes: List<Size>,
        maxFps: Map<Size, Int>,
        deviceSupports60: Boolean
    ): RecordingProfile {
        fun supports(w: Int, h: Int, fps: Int): Boolean {
            val s = sizes.firstOrNull { it.width == w && it.height == h } ?: return false
            val cap = maxFps[s] ?: 30
            return cap >= fps && (fps < 60 || deviceSupports60)
        }
        return when {
            supports(3840, 2160, 60) -> RecordingProfile(3840, 2160, 60)
            supports(1920, 1080, 60) -> RecordingProfile(1920, 1080, 60)
            supports(1920, 1080, 30) -> RecordingProfile(1920, 1080, 30)
            else -> {
                val s = sizes.maxByOrNull { it.width.toLong() * it.height } ?: Size(1280, 720)
                RecordingProfile(s.width, s.height, minOf(maxFps[s] ?: 30, 30))
            }
        }
    }
}
