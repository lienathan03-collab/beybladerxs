import XCTest
@testable import RXSRecorder

final class ModelsTests: XCTestCase {
    func testScoringContractExists() {
        XCTAssertEqual(Scoring.points(for: ["S"]), 1)
    }
}
