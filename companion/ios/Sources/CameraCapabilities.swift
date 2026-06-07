import AVFoundation

struct RecordingProfile {
    let width: Int32
    let height: Int32
    let fps: Int
    var label: String { "\(height)p@\(fps)" }
}

struct CameraCaps {
    /// Deduped (resolution -> max fps) for normal recording.
    let normalModes: [(w: Int32, h: Int32, maxFps: Double)]
    /// High-frame-rate / slow-motion modes, reported SEPARATELY — never used for normal record.
    let slowMoModes: [(w: Int32, h: Int32, maxFps: Double)]
    let chosen: RecordingProfile
    let chosenFormat: AVCaptureDevice.Format
    let hdrSupported: Bool

    func describe() -> String {
        func fmt(_ list: [(w: Int32, h: Int32, maxFps: Double)]) -> String {
            list.isEmpty ? "none" :
                list.sorted { Int($0.w) * Int($0.h) > Int($1.w) * Int($1.h) }
                    .map { "\($0.w)x\($0.h)@\(Int($0.maxFps))" }
                    .joined(separator: ", ")
        }
        return """
        Chosen normal-record profile: \(chosen.label) (\(chosen.width)x\(chosen.height))
        Normal modes (res@maxfps): \(fmt(normalModes))
        Slow-motion / high-speed (NOT used for normal record): \(fmt(slowMoModes))
        HDR supported on chosen format: \(hdrSupported ? "yes" : "no")
        """
    }
}

enum CameraCapabilities {

    /// Spec preference chain: 4K/60 -> 1080p/60 -> 1080p/30 -> largest available (fps capped 30).
    static func query(for device: AVCaptureDevice) -> CameraCaps? {
        // (w, h, maxFps, format)
        var all: [(Int32, Int32, Double, AVCaptureDevice.Format)] = []
        for f in device.formats {
            let d = CMVideoFormatDescriptionGetDimensions(f.formatDescription)
            let maxFps = f.videoSupportedFrameRateRanges.map { $0.maxFrameRate }.max() ?? 0
            all.append((d.width, d.height, maxFps, f))
        }
        if all.isEmpty { return nil }

        // Pick a format supporting (w,h,fps); among matches prefer the one whose maxFps is
        // smallest-but-sufficient, so a 30fps normal record never grabs a 240fps slow-mo format.
        func find(_ w: Int32, _ h: Int32, _ fps: Double) -> AVCaptureDevice.Format? {
            all.filter { $0.0 == w && $0.1 == h && $0.2 >= fps }
               .sorted { $0.2 < $1.2 }
               .first?.3
        }

        let chosenFormat: AVCaptureDevice.Format
        let chosen: RecordingProfile
        if let f = find(3840, 2160, 60) {
            chosenFormat = f; chosen = RecordingProfile(width: 3840, height: 2160, fps: 60)
        } else if let f = find(1920, 1080, 60) {
            chosenFormat = f; chosen = RecordingProfile(width: 1920, height: 1080, fps: 60)
        } else if let f = find(1920, 1080, 30) {
            chosenFormat = f; chosen = RecordingProfile(width: 1920, height: 1080, fps: 30)
        } else {
            let best = all.max { (Int($0.0) * Int($0.1)) < (Int($1.0) * Int($1.1)) }!
            chosenFormat = best.3
            chosen = RecordingProfile(width: best.0, height: best.1, fps: Int(min(best.2, 30)))
        }

        // Dedup by resolution for the report; split slow-mo (>= 120 fps).
        func dedup(_ src: [(Int32, Int32, Double, AVCaptureDevice.Format)])
            -> [(w: Int32, h: Int32, maxFps: Double)] {
            var byRes: [String: (Int32, Int32, Double)] = [:]
            for m in src {
                let k = "\(m.0)x\(m.1)"
                if let e = byRes[k] { if m.2 > e.2 { byRes[k] = (m.0, m.1, m.2) } }
                else { byRes[k] = (m.0, m.1, m.2) }
            }
            return byRes.values.map { (w: $0.0, h: $0.1, maxFps: $0.2) }
        }

        let normal = dedup(all.filter { $0.2 < 120 })
        let slow = dedup(all.filter { $0.2 >= 120 })

        return CameraCaps(
            normalModes: normal,
            slowMoModes: slow,
            chosen: chosen,
            chosenFormat: chosenFormat,
            hdrSupported: chosenFormat.isVideoHDRSupported
        )
    }
}
