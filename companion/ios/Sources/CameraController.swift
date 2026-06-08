import AVFoundation
import Photos
import UIKit

/// Recorder-only AVFoundation controller (Phase 2). No scoring/overlay compositing —
/// AVCaptureMovieFileOutput records the camera+mic connections only, so any SwiftUI
/// overlay drawn on top is never in the saved file (the "clean video" rule).
final class CameraController: NSObject, ObservableObject, AVCaptureFileOutputRecordingDelegate {

    @Published var configured = false
    @Published var isRecording = false
    @Published var elapsed: TimeInterval = 0
    @Published var profileLabel = "—"
    @Published var actualResolution = "—"
    @Published var micAvailable = false
    @Published var micActive = false
    @Published var freeBytes: Int64 = 0
    @Published var zoom: CGFloat = 1
    @Published var maxZoom: CGFloat = 1
    @Published var capsText = ""
    @Published var lastSaved = false
    @Published var warning: String?
    @Published var error: String?

    let session = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "rxs.session")
    private let movieOutput = AVCaptureMovieFileOutput()
    private var device: AVCaptureDevice?
    private var timer: Timer?

    // Lifecycle guards so re-entering the camera screen can't double-add inputs/outputs
    // or stack duplicate observers (sessionQueue is serial, so these are race-free).
    private var didConfigure = false
    private var observersInstalled = false
    private var observerTokens: [NSObjectProtocol] = []

    private let blockBytes: Int64 = 200 * 1024 * 1024
    private let warnBytes: Int64 = 1024 * 1024 * 1024

    // MARK: - Setup

    func configure() {
        sessionQueue.async { [weak self] in
            guard let self else { return }
            guard !self.didConfigure else {
                if !self.session.isRunning { self.session.startRunning() }
                return
            }
            self.session.beginConfiguration()
            self.session.sessionPreset = .inputPriority

            guard let cam = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
                self.session.commitConfiguration()
                self.onMain { self.error = "No back camera." }
                return
            }
            self.device = cam

            do {
                let vin = try AVCaptureDeviceInput(device: cam)
                if self.session.canAddInput(vin) { self.session.addInput(vin) }
            } catch {
                self.session.commitConfiguration()
                self.onMain { self.error = "Camera input failed: \(error.localizedDescription)" }
                return
            }

            var micOk = false
            if let mic = AVCaptureDevice.default(for: .audio),
               let ain = try? AVCaptureDeviceInput(device: mic),
               self.session.canAddInput(ain) {
                self.session.addInput(ain); micOk = true
            }

            if self.session.canAddOutput(self.movieOutput) { self.session.addOutput(self.movieOutput) }

            let caps = CameraCapabilities.query(for: cam)
            if let caps { self.applyFormat(cam, caps) }

            self.session.commitConfiguration()

            if let conn = self.movieOutput.connection(with: .video),
               conn.isVideoStabilizationSupported {
                conn.preferredVideoStabilizationMode = .auto
            }

            self.session.startRunning()
            self.didConfigure = true

            let maxZ = min(cam.activeFormat.videoMaxZoomFactor, 8.0)
            self.installObservers()
            let free = self.currentFreeBytes()
            self.onMain {
                self.micAvailable = micOk
                self.maxZoom = maxZ
                self.freeBytes = free
                if let caps {
                    self.profileLabel = caps.chosen.label
                    self.actualResolution = "\(caps.chosen.width)x\(caps.chosen.height)"
                    self.capsText = caps.describe()
                }
                self.configured = true
            }
        }
    }

    private func applyFormat(_ cam: AVCaptureDevice, _ caps: CameraCaps) {
        do {
            try cam.lockForConfiguration()
            cam.activeFormat = caps.chosenFormat
            let fps = Int32(caps.chosen.fps)
            let dur = CMTime(value: 1, timescale: fps)
            cam.activeVideoMinFrameDuration = dur
            cam.activeVideoMaxFrameDuration = dur
            cam.unlockForConfiguration()
        } catch {
            self.onMain { self.warning = "Could not pin format/FPS: \(error.localizedDescription)" }
        }
    }

    // MARK: - Recording

    func toggleRecording() {
        sessionQueue.async { [weak self] in
            guard let self else { return }
            if self.movieOutput.isRecording { self.movieOutput.stopRecording(); return }

            let free = self.currentFreeBytes()
            if free > 0 && free < self.blockBytes {
                self.onMain { self.error = "Storage too low to start recording." }
                return
            }

            if let conn = self.movieOutput.connection(with: .video) {
                if #available(iOS 17.0, *) {
                    if conn.isVideoRotationAngleSupported(0) { conn.videoRotationAngle = 0 }
                } else if conn.isVideoOrientationSupported {
                    conn.videoOrientation = .landscapeRight
                }
            }

            let url = URL(fileURLWithPath: NSTemporaryDirectory())
                .appendingPathComponent("RXS_\(Int(Date().timeIntervalSince1970)).mov")
            self.movieOutput.startRecording(to: url, recordingDelegate: self)
        }
    }

    func fileOutput(_ output: AVCaptureFileOutput,
                    didStartRecordingTo fileURL: URL,
                    from connections: [AVCaptureConnection]) {
        onMain {
            self.isRecording = true
            self.elapsed = 0
            self.error = nil
            self.lastSaved = false
            self.startTimer()
        }
    }

    func fileOutput(_ output: AVCaptureFileOutput,
                    didFinishRecordingTo outputFileURL: URL,
                    from connections: [AVCaptureConnection],
                    error: Error?) {
        onMain {
            self.isRecording = false
            self.stopTimer()
            if let error { self.error = "Recording error: \(error.localizedDescription)" }
        }
        // Even on certain errors a usable partial file may exist; attempt to save it.
        saveToPhotos(outputFileURL)
    }

    private func saveToPhotos(_ url: URL) {
        PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
            guard status == .authorized || status == .limited else {
                self.onMain { self.error = "Photos permission denied — clip not saved." }
                try? FileManager.default.removeItem(at: url)
                return
            }
            PHPhotoLibrary.shared().performChanges {
                PHAssetCreationRequest.creationRequestForAssetFromVideo(atFileURL: url)
            } completionHandler: { ok, err in
                self.onMain {
                    if ok { self.lastSaved = true }
                    else { self.error = "Save failed: \(err?.localizedDescription ?? "unknown")" }
                    self.freeBytes = self.currentFreeBytes()
                }
                try? FileManager.default.removeItem(at: url)
            }
        }
    }

    // MARK: - Controls

    func focus(atDevicePoint p: CGPoint) {
        sessionQueue.async {
            guard let d = self.device else { return }
            do {
                try d.lockForConfiguration()
                if d.isFocusPointOfInterestSupported {
                    d.focusPointOfInterest = p
                    if d.isFocusModeSupported(.autoFocus) { d.focusMode = .autoFocus }
                }
                if d.isExposurePointOfInterestSupported {
                    d.exposurePointOfInterest = p
                    if d.isExposureModeSupported(.autoExpose) { d.exposureMode = .autoExpose }
                }
                d.unlockForConfiguration()
            } catch {}
        }
    }

    /// [factor] is a relative pinch scale (>1 zoom in).
    func zoom(by factor: CGFloat) {
        sessionQueue.async {
            guard let d = self.device else { return }
            do {
                try d.lockForConfiguration()
                let maxZ = min(d.activeFormat.videoMaxZoomFactor, 8.0)
                let z = min(max(d.videoZoomFactor * factor, 1.0), maxZ)
                d.videoZoomFactor = z
                d.unlockForConfiguration()
                self.onMain { self.zoom = z; self.maxZoom = maxZ }
            } catch {}
        }
    }

    // MARK: - Timer / observers / storage

    private func startTimer() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.elapsed = self.movieOutput.recordedDuration.seconds
            self.micActive = self.micAvailable && self.movieOutput.isRecording
            switch ProcessInfo.processInfo.thermalState {
            case .serious: self.warning = "Device heating up (serious)"
            case .critical: self.warning = "Device overheating (critical)"
            default: break
            }
        }
    }

    private func stopTimer() { timer?.invalidate(); timer = nil }

    private func installObservers() {
        guard !observersInstalled else { return }
        observersInstalled = true
        let nc = NotificationCenter.default
        observerTokens.append(
            nc.addObserver(forName: .AVCaptureSessionWasInterrupted, object: session, queue: .main) { [weak self] _ in
                self?.warning = "Camera interrupted"
            })
        observerTokens.append(
            nc.addObserver(forName: .AVCaptureSessionInterruptionEnded, object: session, queue: .main) { [weak self] _ in
                self?.warning = nil
            })
        observerTokens.append(
            nc.addObserver(forName: .AVCaptureSessionRuntimeError, object: session, queue: .main) { [weak self] note in
                let err = note.userInfo?[AVCaptureSessionErrorKey] as? Error
                self?.error = "Session error: \(err?.localizedDescription ?? "unknown")"
            })
    }

    /// Tear down on back-navigation: stop recording if needed, stop the session on its
    /// queue, invalidate the timer, and remove observers. Lets the screen be re-entered
    /// cleanly without leaking a running session or duplicate observers.
    func shutdown() {
        onMain {
            self.timer?.invalidate()
            self.timer = nil
        }
        sessionQueue.async { [weak self] in
            guard let self else { return }
            if self.movieOutput.isRecording { self.movieOutput.stopRecording() }
            if self.session.isRunning { self.session.stopRunning() }
            self.observerTokens.forEach { NotificationCenter.default.removeObserver($0) }
            self.observerTokens.removeAll()
            self.observersInstalled = false
            self.didConfigure = false
        }
    }

    private func currentFreeBytes() -> Int64 {
        let url = URL(fileURLWithPath: NSHomeDirectory())
        if let v = try? url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]),
           let c = v.volumeAvailableCapacityForImportantUsage {
            if c > 0 && c < warnBytes { onMain { self.warning = "Low storage (\(c / (1024 * 1024)) MB)" } }
            return c
        }
        return 0
    }

    private func onMain(_ block: @escaping () -> Void) { DispatchQueue.main.async(execute: block) }
}
