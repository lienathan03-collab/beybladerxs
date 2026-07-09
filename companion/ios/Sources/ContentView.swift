import SwiftUI
import AVFoundation

/// Camera route: the existing AVFoundation recorder is responsible for capture; the
/// scoring overlay (Task 7) is drawn above the preview only, so the saved movie stays
/// clean. Back navigation is protected while a recording is in progress.
struct ContentView: View {
    let event: EventSummary
    let match: SoloMatch
    let api: RxsAPI
    let onBack: () -> Void

    @StateObject private var controller = CameraController()
    @StateObject private var store: ScoringStore
    @State private var camGranted = false
    @State private var asked = false
    @State private var showBackConfirm = false

    init(event: EventSummary, match: SoloMatch, api: RxsAPI, onBack: @escaping () -> Void) {
        self.event = event
        self.match = match
        self.api = api
        self.onBack = onBack
        _store = StateObject(wrappedValue: ScoringStore(match: match, eventId: event.id, api: api))
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if camGranted {
                CameraPreview(controller: controller).ignoresSafeArea()
                // Scoring overlay sits on the preview only — never in the saved movie.
                ScoreOverlayView(store: store)
                hud
            } else {
                VStack(spacing: 12) {
                    Text("Camera + microphone permission required.").foregroundColor(.white)
                    Button("Grant") { Task { await requestAndConfigure() } }
                        .buttonStyle(.borderedProminent)
                    Button("‹ Back") { onBack() }.foregroundColor(.white)
                }
            }
        }
        .task {
            if !asked { asked = true; await requestAndConfigure() }
        }
        .alert("Stop recording and leave?", isPresented: $showBackConfirm) {
            Button("Keep recording", role: .cancel) {}
            Button("Stop & leave", role: .destructive) { leave() }
        } message: {
            Text("Recording is still running. Leaving will stop and save it.")
        }
    }

    // MARK: - HUD (overlay only — never recorded into the file)

    private var hud: some View {
        ZStack {
            VStack {
                HStack {
                    pill {
                        HStack(spacing: 6) {
                            if controller.isRecording {
                                Circle().fill(Color(red: 1, green: 0.23, blue: 0.29)).frame(width: 10, height: 10)
                            }
                            mono(timer(controller.elapsed))
                        }
                    }
                    // Resolution is just confirmation — keep it small/left and leave the
                    // center clear for the scoring bar (matches Android's scoring layout).
                    pill { mono("\(controller.actualResolution)", size: 10) }
                    Spacer()
                    HStack(spacing: 8) {
                        pill { mono(micLabel) }
                        pill { mono("\(controller.freeBytes / (1024 * 1024))MB") }
                    }
                }
                Spacer()
            }
            .padding(12)

            if let w = controller.warning {
                VStack { pill { mono(w, color: Color(red: 1, green: 0.78, blue: 0.34)) }; Spacer() }
                    .padding(.top, 52)
            }
            if let e = controller.error {
                VStack { Spacer(); pill { mono(e, color: Color(red: 1, green: 0.53, blue: 0.57)) }.padding(.bottom, 120) }
            }

            // Bottom controls: Back · Record · Saved indicator
            VStack {
                Spacer()
                HStack(alignment: .center, spacing: 18) {
                    Button(action: handleBack) { pill { mono("‹ Matches") } }
                    Button(action: { controller.toggleRecording() }) {
                        ZStack {
                            Circle().fill(Color.black.opacity(0.33)).frame(width: 78, height: 78)
                            RoundedRectangle(cornerRadius: controller.isRecording ? 8 : 30)
                                .fill(Color(red: 1, green: 0.23, blue: 0.29))
                                .frame(width: controller.isRecording ? 34 : 60,
                                       height: controller.isRecording ? 34 : 60)
                                .overlay(RoundedRectangle(cornerRadius: controller.isRecording ? 8 : 30)
                                    .stroke(Color.white, lineWidth: 3))
                        }
                    }
                    if controller.lastSaved && !controller.isRecording {
                        pill { mono("Saved → Photos", color: Color(red: 0.5, green: 0.94, blue: 0.65)) }
                    } else {
                        Color.clear.frame(width: 86, height: 1)
                    }
                }
                .padding(.bottom, 20)
            }
        }
    }

    private var micLabel: String {
        if !controller.micAvailable { return "MIC OFF" }
        return controller.micActive ? "MIC ●" : "MIC ○"
    }

    // MARK: - Back protection

    private func handleBack() {
        if controller.isRecording { showBackConfirm = true } else { leave() }
    }

    private func leave() {
        controller.shutdown()
        onBack()
    }

    // MARK: - Helpers

    @ViewBuilder private func pill<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        content()
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(Color(red: 0.02, green: 0.03, blue: 0.05).opacity(0.67))
            .cornerRadius(12)
    }

    private func mono(_ text: String, color: Color = .white, size: CGFloat = 12) -> Text {
        Text(text).font(.system(size: size, weight: .bold, design: .monospaced)).foregroundColor(color)
    }

    private func timer(_ s: TimeInterval) -> String {
        let t = Int(s)
        return String(format: "%02d:%02d", t / 60, t % 60)
    }

    private func requestAndConfigure() async {
        let cam = await requestAccess(.video)
        _ = await requestAccess(.audio)
        await MainActor.run { camGranted = cam }
        if cam { controller.configure() }
    }

    private func requestAccess(_ type: AVMediaType) async -> Bool {
        await withCheckedContinuation { cont in
            AVCaptureDevice.requestAccess(for: type) { cont.resume(returning: $0) }
        }
    }
}
