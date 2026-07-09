import XCTest
@testable import RXSRecorder

@MainActor
final class ScoringStoreTests: XCTestCase {

    func testFinishAddsWinnerCodeAndOpponentLoss() {
        let store = ScoringStore(match: .fixture(), eventId: "e", api: nil)
        store.apply(winner: .p1, finish: "O")
        XCTAssertEqual(store.match.p1.builds[0].finishes, ["O"])
        XCTAssertEqual(store.match.p2.builds[0].finishes, ["L"])
        XCTAssertEqual(store.match.p1.points, 2)
    }

    func testThresholdDeclaresWinner() {
        var match = SoloMatch.fixture(round: "R1")
        match.p1.builds[0].finishes = ["E"] // 3 pts; +S = 4 = R1 threshold
        let store = ScoringStore(match: match, eventId: "e", api: nil)
        store.apply(winner: .p1, finish: "S")
        XCTAssertTrue(store.match.p1.win)
    }

    func testUndoRestoresPreviousSnapshot() {
        let store = ScoringStore(match: .fixture(), eventId: "e", api: nil)
        store.apply(winner: .p1, finish: "B")
        store.undo()
        XCTAssertEqual(store.match.p1.points, 0)
        XCTAssertEqual(store.match.p2.builds[0].finishes, [])
    }

    func testIgnoresFinishAfterWinnerDecided() {
        var match = SoloMatch.fixture(round: "R1")
        match.p1.builds[0].finishes = ["E"]
        let store = ScoringStore(match: match, eventId: "e", api: nil)
        store.apply(winner: .p1, finish: "S") // p1 reaches 4 -> win; p2 gets one "L"
        XCTAssertTrue(store.match.p1.win)
        store.apply(winner: .p2, finish: "O") // ignored once decided
        XCTAssertEqual(store.match.p2.builds[0].finishes, ["L"])
    }

    func testSelectBeyChangesDeployedTarget() {
        var match = SoloMatch.fixture(round: "R1")
        match.p1.builds = [Bey(build: "A1"), Bey(build: "A2")]
        let store = ScoringStore(match: match, eventId: "e", api: nil)
        store.selectBey(side: .p1, index: 1)
        store.apply(winner: .p1, finish: "O")
        XCTAssertEqual(store.match.p1.builds[0].finishes, [])
        XCTAssertEqual(store.match.p1.builds[1].finishes, ["O"])
    }
}
