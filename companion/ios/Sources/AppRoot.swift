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
                ContentView(event: event, match: match, api: api) {
                    route = .matches(event)
                }
            }
        }
        .task {
            if route == nil { route = settings.isConfigured ? .events : .setup }
        }
    }
}

/// Render any error as a short, human-readable line (RxsError carries its message).
func uiMessage(_ error: Error) -> String {
    (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
}
