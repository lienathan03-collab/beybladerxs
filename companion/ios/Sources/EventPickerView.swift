import SwiftUI

/// Event list. Dark UI matching Android: loading / empty / error+Retry / Refresh,
/// plus a Settings entry. Picking an event advances to its match list.
struct EventPickerView: View {
    let api: RxsAPI
    let onPick: (EventSummary) -> Void
    let onSettings: () -> Void

    @State private var loading = true
    @State private var error: String?
    @State private var events: [EventSummary] = []

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            VStack(spacing: 8) {
                HStack {
                    Text("Pick event")
                        .foregroundColor(.white)
                        .font(.system(size: 20, weight: .semibold))
                    Spacer()
                    Button("Refresh") { reload() }
                    Button("Settings") { onSettings() }
                }
                content
            }
            .padding(16)
        }
        .task { reload() }
    }

    @ViewBuilder
    private var content: some View {
        if loading {
            centered { ProgressView().tint(.white) }
        } else if let error {
            centered {
                VStack(spacing: 10) {
                    Text("Error: \(error)").foregroundColor(Color(red: 1, green: 0.53, blue: 0.57))
                        .multilineTextAlignment(.center)
                    Button("Retry") { reload() }.buttonStyle(.borderedProminent)
                }
            }
        } else if events.isEmpty {
            centered { Text("No events found.").foregroundColor(.white) }
        } else {
            ScrollView {
                LazyVStack(spacing: 8) {
                    ForEach(events) { ev in
                        Button { onPick(ev) } label: {
                            HStack {
                                Text(ev.title).foregroundColor(.white).font(.system(size: 16))
                                Spacer()
                                Text(ev.type ?? "1v1").foregroundColor(Color(red: 0.53, green: 0.58, blue: 0.65))
                            }
                            .padding(14)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Color(red: 0.067, green: 0.082, blue: 0.11))
                            .cornerRadius(8)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    private func reload() {
        Task { @MainActor in
            loading = true
            error = nil
            do {
                events = try await api.events()
            } catch {
                self.error = uiMessage(error)
            }
            loading = false
        }
    }

    @ViewBuilder
    private func centered<C: View>(@ViewBuilder _ content: () -> C) -> some View {
        VStack { Spacer(); content(); Spacer() }.frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
