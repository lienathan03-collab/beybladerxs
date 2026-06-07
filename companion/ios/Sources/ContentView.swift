import SwiftUI
import AVFoundation

struct ContentView: View {
    @StateObject private var controller = CameraController()
    @State private var camGranted = false
    @State private var asked = false
    @State private var showCaps = false

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if camGranted {
                CameraPreview(controller: controller).ignoresSafeArea()
                hud
            } else {
                VStack(spacing: 12) {
                    Text("Camera + microphone permission required.")
                        .foregroundColor(.white)
                    Button("Grant") { Task { await requestAndConfigure() } }
                        .buttonStyle(.borderedProminent)
                }
            }
        }
        .task {
            if !asked { asked = true; await requestAndConfigure() }
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
                    Spacer()
                    pill {
                        mono("\(controller.profileLabel) • \(controller.actualResolution)")
                    }
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
                pill { mono(e, color: Color(red: 1, green: 0.53, blue: 0.57)) }
            }

            // Record button
            VStack {
                Spacer()
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
                .padding(.bottom, 20)
            }

            // Capabilities dump for the Phase 3–5 report
            VStack {
                Spacer()
                HStack {
                    Button(action: { showCaps.toggle() }) { pill { mono(showCaps ? "CAPS ▲" : "CAPS ▼") } }
                    Spacer()
                    if controller.lastSaved && !controller.isRecording {
                        pill { mono("Saved → Photos", color: Color(red: 0.5, green: 0.94, blue: 0.65)) }
                    }
                }
            }
            .padding(12)

            if showCaps {
                VStack {
                    Spacer()
                    HStack {
                        mono(controller.capsText, color: .white, size: 11)
                            .padding(12)
                            .background(Color.black.opacity(0.8))
                            .cornerRadius(10)
                        Spacer()
                    }
                    .padding(.bottom, 52)
                    .padding(.horizontal, 12)
                }
            }
        }
    }

    private var micLabel: String {
        if !controller.micAvailable { return "MIC OFF" }
        return controller.micActive ? "MIC ●" : "MIC ○"
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
