import SwiftUI

// Four routes mirror the Android AppRoot flow:
// Connect -> Pick Event -> Pick Match -> Camera + Scoring.
enum AppRoute {
    case setup
    case events
    case matches(EventSummary)
    case camera(EventSummary, SoloMatch)
}

/// Top-level navigation. Owns one AppSettings and one RxsAPI; starts on the event
/// list when configured, otherwise on setup.
struct AppRoot: View {
    @StateObject private var settings = AppSettings()
    @State private var route: AppRoute?

    var body: some View {
        let api = RxsAPI(settings: settings)
        Group {
            switch route {
            case .none:
                Color.black.ignoresSafeArea()
            case .setup:
                SetupView(settings: settings, api: api) { route = .events }
            case .events:
                EventPickerView(
                    api: api,
                    onPick: { route = .matches($0) },
                    onSettings: { route = .setup }
                )
            case .matches(let event):
                MatchPickerView(
                    api: api,
                    event: event,
                    onPick: { route = .camera(event, $0) },
                    onBack: { route = .events }
                )
            case .camera(let event, let match):
                // Placeholder camera route. Task 6 rewires ContentView's signature
                // and Task 7 overlays the live scoring controls here.
                CameraPlaceholder(match: match) { route = .matches(event) }
            }
        }
        .task {
            if route == nil { route = settings.isConfigured ? .events : .setup }
        }
    }
}

/// Temporary stand-in for the camera+scoring screen (replaced in Task 6–7).
private struct CameraPlaceholder: View {
    let match: SoloMatch
    let onBack: () -> Void
    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            VStack(spacing: 16) {
                Text(match.label).foregroundColor(.white).font(.system(size: 16, weight: .bold))
                Text("Camera + scoring is wired in Task 6–7.")
                    .foregroundColor(.gray).font(.system(size: 12))
                Button("‹ Matches") { onBack() }
                    .foregroundColor(.white)
            }
        }
    }
}

/// Render any error as a short, human-readable line (RxsError carries its message).
func uiMessage(_ error: Error) -> String {
    (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
}
