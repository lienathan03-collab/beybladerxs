import SwiftUI

/// Landscape scoring controls drawn ABOVE the camera preview (never in the saved
/// movie). Mirrors the Android ScoreOverlay wording/colors: edge player panels with
/// name + big points + per-Bey chips + S/O/B/E finishes, and a center-top bar with
/// total score, sync status, Undo, and Submit. Lives inside the safe area so notch /
/// home-indicator insets keep controls reachable on iPhone 11–15.
struct ScoreOverlayView: View {
    @ObservedObject var store: ScoringStore

    private let finishColors: [String: Color] = [
        "S": Color(red: 0.239, green: 0.525, blue: 0.776),
        "O": Color(red: 0.180, green: 0.545, blue: 0.341),
        "B": Color(red: 0.788, green: 0.553, blue: 0.071),
        "E": Color(red: 0.557, green: 0.267, blue: 0.678)
    ]
    private let panelBG = Color(red: 0.02, green: 0.027, blue: 0.047).opacity(0.67)

    var body: some View {
        ZStack {
            HStack(alignment: .center) {
                panel(side: .p1, side2: store.match.p1, deployed: store.deployedP1)
                Spacer()
                panel(side: .p2, side2: store.match.p2, deployed: store.deployedP2)
            }

            VStack {
                topBar
                Spacer()
            }

            if store.decided {
                Text("🏆 \(store.match.p1.win ? store.match.p1.name : store.match.p2.name)")
                    .foregroundColor(Color(red: 0.5, green: 0.94, blue: 0.65))
                    .font(.system(size: 20, weight: .bold))
            }
        }
        .padding(.horizontal, 4)
    }

    // MARK: - Top control bar

    private var topBar: some View {
        HStack(spacing: 10) {
            chip("UNDO", enabled: store.canUndo) { store.undo() }
            VStack(spacing: 1) {
                Text("\(store.match.p1.points)–\(store.match.p2.points)")
                    .foregroundColor(.white)
                    .font(.system(size: 18, weight: .bold, design: .monospaced))
                Text(store.match.round)
                    .foregroundColor(Color(white: 0.6))
                    .font(.system(size: 10, weight: .bold))
            }
            syncBadge
            chip("SUBMIT", enabled: !store.match.submitted) {
                Task { await store.submit() }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Color.black.opacity(0.5))
        .cornerRadius(12)
        .padding(.top, 2)
    }

    private var syncBadge: some View {
        let (color, text) = syncDisplay
        return HStack(spacing: 4) {
            Circle().fill(color).frame(width: 8, height: 8)
            if let text {
                Text(text).foregroundColor(color).font(.system(size: 9, weight: .bold))
            }
        }
    }

    private var syncDisplay: (Color, String?) {
        switch store.syncStatus {
        case .idle:
            return (Color.white.opacity(0.33), nil)
        case .waiting, .syncing, .submitting:
            return (Color(red: 0.56, green: 0.78, blue: 1), nil)
        case .synced:
            return (Color(red: 0.5, green: 0.94, blue: 0.65), nil)
        case .submitted:
            return (Color(red: 0.5, green: 0.94, blue: 0.65), "submitted")
        case .failed:
            return (Color(red: 1, green: 0.78, blue: 0.34), "sync failed")
        }
    }

    // MARK: - Player panel

    private func panel(side: MatchSide, side2 s: Side, deployed: Int) -> some View {
        VStack(spacing: 5) {
            Text(s.name)
                .foregroundColor(.white)
                .font(.system(size: 12, weight: .bold))
                .lineLimit(1)
            Text("\(s.points)")
                .foregroundColor(.white)
                .font(.system(size: 28, weight: .bold))

            ForEach(Array(s.builds.enumerated()), id: \.offset) { i, b in
                beyChip(b, index: i, selected: i == deployed, side: side)
            }

            VStack(spacing: 4) {
                HStack(spacing: 4) { finishBtn("S", side); finishBtn("O", side) }
                HStack(spacing: 4) { finishBtn("B", side); finishBtn("E", side) }
            }
        }
        .frame(width: 124)
        .padding(8)
        .background(panelBG)
        .cornerRadius(14)
    }

    private func beyChip(_ b: Bey, index: Int, selected: Bool, side: MatchSide) -> some View {
        let pts = Scoring.points(for: b.finishes)
        return Button {
            store.selectBey(side: side, index: index)
        } label: {
            Text("\(selected ? "▶ " : "")\(b.build.isEmpty ? "Bey \(index + 1)" : b.build)  \(pts)")
                .foregroundColor(.white)
                .font(.system(size: 10))
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 5)
                .padding(.horizontal, 6)
                .background(selected ? Color(red: 0.118, green: 0.282, blue: 0.439)
                                     : Color.white.opacity(0.2))
                .cornerRadius(8)
        }
        .buttonStyle(.plain)
        .disabled(store.decided)
    }

    private func finishBtn(_ code: String, _ side: MatchSide) -> some View {
        Button {
            store.apply(winner: side, finish: code)
        } label: {
            Text(code)
                .foregroundColor(.white)
                .font(.system(size: 15, weight: .bold))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
                .background(finishColors[code] ?? .gray)
                .cornerRadius(8)
        }
        .buttonStyle(.plain)
        .disabled(store.decided)
    }

    private func chip(_ label: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .foregroundColor(enabled ? .white : Color.white.opacity(0.4))
                .font(.system(size: 11, weight: .bold))
                .padding(.vertical, 6)
                .padding(.horizontal, 12)
                .background(Color.black.opacity(0.67))
                .cornerRadius(10)
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.white.opacity(0.33), lineWidth: 1))
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
    }
}
