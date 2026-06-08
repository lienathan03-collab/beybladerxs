import XCTest
@testable import RXSRecorder

final class ModelsTests: XCTestCase {

    // MARK: - Scoring rules (mirror eventmanager.html FINISH_PTS + thresholds)

    func testScoringContractExists() {
        XCTAssertEqual(Scoring.points(for: ["S"]), 1)
    }

    func testFinishPointsAndThresholds() {
        XCTAssertEqual(Scoring.points(for: ["S", "O", "B", "E", "L"]), 8)
        XCTAssertEqual(Scoring.threshold(round: "F"), 7)
        XCTAssertEqual(Scoring.threshold(round: "SF"), 5)
        XCTAssertEqual(Scoring.threshold(round: "R1"), 4)
    }

    // MARK: - Event-state parsing (group solo rows by _matchSid)

    func testEventStateGroupsSoloRowsByMatchSid() throws {
        let data = Data(#"""
        {
          "builds":{"alice":["A1","A2"],"bob":["B1","B2"]},
          "beyResults":[
            {"player":"alice","round":"R1","_matchSid":"R1|alice|bob|0",
             "builds":[{"build":"A1","finishes":["O"],"deployed":true}],"win":false},
            {"player":"bob","round":"R1","_matchSid":"R1|alice|bob|0",
             "builds":[{"build":"B1","finishes":["L"],"deployed":true}],"win":false}
          ]
        }
        """#.utf8)
        let state = try EventState.decode(data)
        XCTAssertEqual(state.matches.count, 1)
        XCTAssertEqual(state.matches[0].sid, "R1|alice|bob|0")
        XCTAssertEqual(state.matches[0].p1.points, 2)
    }

    func testEventStateIgnoresTeamRowsAndIncompleteMatches() throws {
        let data = Data(#"""
        {
          "builds":{},
          "beyResults":[
            {"player":"t1","team":"Reds","round":"R1","_matchSid":"R1|T|Reds|Blues|0",
             "builds":[],"win":false},
            {"player":"solo","round":"R1","_matchSid":"R1|solo|x|0","builds":[],"win":false}
          ]
        }
        """#.utf8)
        let state = try EventState.decode(data)
        XCTAssertEqual(state.matches.count, 0)
    }

    // MARK: - PUT payload encoding (merge mode, two rows)

    func testPutPayloadUsesMergeModeAndTwoRows() throws {
        let match = SoloMatch.fixture()
        let payload = try MatchPayload.encode(
            eventId: "event-1", match: match, submitted: true,
            username: "judge", password: "secret"
        )
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: payload) as? [String: Any]
        )
        XCTAssertEqual(object["mergeMode"] as? Bool, true)
        XCTAssertEqual(object["adminUsername"] as? String, "judge")
        XCTAssertEqual(object["adminPassword"] as? String, "secret")
        XCTAssertEqual(object["eventId"] as? String, "event-1")
        XCTAssertNotNil(object["revivedSids"] as? [Any])
        XCTAssertEqual((object["beyResults"] as? [[String: Any]])?.count, 2)
        let firstRow = (object["beyResults"] as? [[String: Any]])?.first
        XCTAssertEqual(firstRow?["_submitted"] as? Bool, true)
        XCTAssertEqual(firstRow?["_matchSid"] as? String, match.sid)
        XCTAssertEqual(firstRow?["entryId"] as? String, "alice")
    }

    func testLivePushPayloadOmitsSubmittedFlag() throws {
        let match = SoloMatch.fixture()
        let payload = try MatchPayload.encode(
            eventId: "event-1", match: match, submitted: false,
            username: "judge", password: "secret"
        )
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: payload) as? [String: Any]
        )
        let firstRow = (object["beyResults"] as? [[String: Any]])?.first
        XCTAssertNil(firstRow?["_submitted"])
    }
}

// Test-only fixture shared with ScoringStoreTests.
extension SoloMatch {
    static func fixture(round: String = "R1") -> SoloMatch {
        SoloMatch(
            sid: "\(round)|alice|bob|0",
            round: round,
            p1: Side(player: "alice", entryId: "alice", displayLabel: nil,
                     builds: [Bey(build: "A1")], win: false),
            p2: Side(player: "bob", entryId: "bob", displayLabel: nil,
                     builds: [Bey(build: "B1")], win: false),
            submitted: false
        )
    }
}
