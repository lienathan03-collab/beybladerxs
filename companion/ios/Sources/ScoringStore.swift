import Foundation

enum MatchSide { case p1, p2 }

enum SyncStatus: Equatable {
    case idle, waiting, syncing, synced, submitting, submitted
    case failed(String)
}

/// Local mutable score state for the open match. Every finish snapshots the full
/// match (for Undo), applies the finish + opponent loss, recomputes the winner, and
/// schedules a debounced merge-mode write. A failed write keeps the local score and
/// surfaces `.failed`; it never touches the recorder. `api == nil` => pure unit mode.
@MainActor
final class ScoringStore: ObservableObject {
    @Published private(set) var match: SoloMatch
    @Published var deployedP1 = 0
    @Published var deployedP2 = 0
    @Published private(set) var syncStatus: SyncStatus = .idle
    @Published private(set) var canUndo = false

    let eventId: String
    private let api: RxsAPI?
    private let debounceMs: UInt64

    private struct Snapshot {
        let match: SoloMatch
        let dep1: Int
        let dep2: Int
    }
    private var undoStack: [Snapshot] = []
    private var pushTask: Task<Void, Never>?

    init(match: SoloMatch, eventId: String, api: RxsAPI?, debounceMs: UInt64 = 600) {
        self.match = match
        self.eventId = eventId
        self.api = api
        self.debounceMs = debounceMs
    }

    var decided: Bool { match.p1.win || match.p2.win }

    // MARK: - Intent

    func selectBey(side: MatchSide, index: Int) {
        guard !decided, index >= 0 else { return }
        switch side {
        case .p1: if index < max(match.p1.builds.count, 1) { deployedP1 = index }
        case .p2: if index < max(match.p2.builds.count, 1) { deployedP2 = index }
        }
    }

    func apply(winner: MatchSide, finish: String) {
        guard !decided else { return }
        snapshot()
        let loser = other(winner)
        let wIdx = index(of: winner)
        let lIdx = index(of: loser)
        ensureBuild(winner, wIdx)
        ensureBuild(loser, lIdx)
        mutate(winner) { $0.builds[wIdx].finishes.append(finish); $0.builds[wIdx].deployed = true }
        mutate(loser) { $0.builds[lIdx].finishes.append("L"); $0.builds[lIdx].deployed = true }
        checkWin()
        schedulePush()
    }

    func undo() {
        guard let snap = undoStack.popLast() else { return }
        match = snap.match
        deployedP1 = snap.dep1
        deployedP2 = snap.dep2
        canUndo = !undoStack.isEmpty
        schedulePush()
    }

    /// Cancel any pending debounce, mark final, and write immediately.
    func submit() async {
        pushTask?.cancel()
        await push(submitted: true)
    }

    // MARK: - Mutation helpers

    private func other(_ s: MatchSide) -> MatchSide { s == .p1 ? .p2 : .p1 }
    private func index(of s: MatchSide) -> Int { s == .p1 ? deployedP1 : deployedP2 }

    private func mutate(_ side: MatchSide, _ block: (inout Side) -> Void) {
        switch side {
        case .p1: block(&match.p1)
        case .p2: block(&match.p2)
        }
    }

    /// Grow a side's roster with placeholders so the deployed index is always valid
    /// (mirrors Android `ensureBey`, e.g. when a row arrived with no builds yet).
    private func ensureBuild(_ side: MatchSide, _ index: Int) {
        mutate(side) { s in
            while s.builds.count <= index {
                s.builds.append(Bey(build: "Bey \(s.builds.count + 1)"))
            }
        }
    }

    private func checkWin() {
        let thr = Scoring.threshold(round: match.round)
        if match.p1.points >= thr { match.p1.win = true }
        if match.p2.points >= thr { match.p2.win = true }
    }

    private func snapshot() {
        undoStack.append(Snapshot(match: match, dep1: deployedP1, dep2: deployedP2))
        canUndo = true
    }

    // MARK: - Live sync

    private func schedulePush() {
        guard api != nil else { syncStatus = .idle; return }
        pushTask?.cancel()
        let final = decided
        syncStatus = .waiting
        pushTask = Task { @MainActor [debounceMs] in
            try? await Task.sleep(nanoseconds: debounceMs * 1_000_000)
            if Task.isCancelled { return }
            await push(submitted: final)
        }
    }

    private func push(submitted: Bool) async {
        guard let api else { return }
        syncStatus = submitted ? .submitting : .syncing
        do {
            try await api.putMatch(eventId: eventId, match: match, submitted: submitted)
            if submitted { match.submitted = true }
            syncStatus = submitted ? .submitted : .synced
        } catch {
            // Retain local score; recording is unaffected.
            syncStatus = .failed(uiMessage(error))
        }
    }
}
