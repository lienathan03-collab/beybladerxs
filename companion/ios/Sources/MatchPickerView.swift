import SwiftUI

/// Solo match list for one event. Mirrors Android MatchPickerScreen: Back to events,
/// Refresh, player search, round chips, and a row per solo match showing either
/// "submitted" or the current score. Only solo matches (from EventState) appear.
struct MatchPickerView: View {
    let api: RxsAPI
    let event: EventSummary
    let onPick: (SoloMatch) -> Void
    let onBack: () -> Void

    @State private var loading = true
    @State private var error: String?
    @State private var matches: [SoloMatch] = []
    @State private var query = ""
    @State private var round: String?

    private var rounds: [String] {
        var seen: [String] = []
        for m in matches where !seen.contains(m.round) { seen.append(m.round) }
        return seen
    }

    private var filtered: [SoloMatch] {
        matches.filter { m in
            (round == nil || m.round == round) &&
            (query.isEmpty
                || m.p1.name.localizedCaseInsensitiveContains(query)
                || m.p2.name.localizedCaseInsensitiveContains(query))
        }
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            VStack(spacing: 8) {
                HStack {
                    Button("‹ Events") { onBack() }
                    Text(event.title)
                        .foregroundColor(.white).font(.system(size: 18, weight: .semibold))
                        .lineLimit(1)
                    Spacer()
                    Button("Refresh") { reload() }
                }

                TextField("", text: $query, prompt: Text("Search player").foregroundColor(.gray))
                    .foregroundColor(.white)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .padding(10)
                    .background(Color(red: 0.067, green: 0.082, blue: 0.11))
                    .cornerRadius(8)

                if !rounds.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            chip("All", selected: round == nil) { round = nil }
                            ForEach(rounds, id: \.self) { r in
                                chip(r, selected: round == r) { round = r }
                            }
                        }
                    }
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
        } else if filtered.isEmpty {
            centered { Text("No matches here.").foregroundColor(.white) }
        } else {
            ScrollView {
                LazyVStack(spacing: 8) {
                    ForEach(filtered) { m in
                        Button { onPick(m) } label: {
                            HStack {
                                Text(m.label).foregroundColor(.white).font(.system(size: 15)).lineLimit(1)
                                Spacer()
                                if m.submitted {
                                    Text("submitted").foregroundColor(Color(red: 0.5, green: 0.94, blue: 0.65))
                                } else {
                                    Text("\(m.p1.points)–\(m.p2.points)")
                                        .foregroundColor(Color(red: 0.56, green: 0.78, blue: 1))
                                }
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
                matches = try await api.eventState(eventId: event.id).matches
            } catch {
                self.error = uiMessage(error)
            }
            loading = false
        }
    }

    @ViewBuilder
    private func chip(_ label: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .foregroundColor(.white).font(.system(size: 13))
                .padding(.horizontal, 14).padding(.vertical, 8)
                .background(selected ? Color(red: 0.14, green: 0.48, blue: 0.91)
                                     : Color(red: 0.067, green: 0.082, blue: 0.11))
                .cornerRadius(20)
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func centered<C: View>(@ViewBuilder _ content: () -> C) -> some View {
        VStack { Spacer(); content(); Spacer() }.frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
