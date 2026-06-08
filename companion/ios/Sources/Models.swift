import Foundation

// ─────────────────────────────────────────────────────────────────────────────
// Scoring rules — mirror eventmanager.html / Android Rxs.kt exactly.
// FINISH_PTS = { S:1, O:2, E:3, B:2, L:0 }; solo thresholds F=7, SF=5, else 4.
// ─────────────────────────────────────────────────────────────────────────────
enum Scoring {
    static let finishPoints = ["S": 1, "O": 2, "E": 3, "B": 2, "L": 0]

    static func points(for finishes: [String]) -> Int {
        finishes.reduce(0) { $0 + (finishPoints[$1] ?? 0) }
    }

    static func threshold(round: String) -> Int {
        switch round {
        case "F": return 7
        case "SF": return 5
        default: return 4
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Models (1v1 / solo). `id` on Bey is local-only and never encoded into a row.
// ─────────────────────────────────────────────────────────────────────────────
struct Bey: Codable, Equatable, Identifiable {
    var id = UUID()
    var build: String
    var finishes: [String] = []
    var deployed = false

    enum CodingKeys: String, CodingKey { case build, finishes, deployed }
}

struct Side: Codable, Equatable {
    var player: String
    var entryId: String?
    var displayLabel: String?
    var builds: [Bey]
    var win: Bool

    var name: String { displayLabel?.isEmpty == false ? displayLabel! : player }
    var points: Int {
        builds.flatMap(\.finishes).reduce(0) {
            $0 + (Scoring.finishPoints[$1] ?? 0)
        }
    }
}

struct SoloMatch: Equatable, Identifiable {
    var id: String { sid }
    var sid: String
    var round: String
    var p1: Side
    var p2: Side
    var submitted: Bool
    var label: String { "\(round) · \(p1.name) vs \(p2.name)" }
}

// ─────────────────────────────────────────────────────────────────────────────
// Events
// ─────────────────────────────────────────────────────────────────────────────
struct Joiner: Equatable, Hashable {
    var entryId: String?
    var name: String
    var type: String?
    var entryType: String?
}

struct EventSummary: Identifiable, Equatable, Hashable {
    var id: String
    var title: String
    var type: String?
    var joiners: [Joiner]

    /// Parse `GET /api/events` -> `{events:[...]}`.
    static func list(from data: Data) throws -> [EventSummary] {
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw RxsError.parse("events response was not a JSON object")
        }
        let arr = root["events"] as? [[String: Any]] ?? []
        return arr.map(parse)
    }

    static func parse(_ o: [String: Any]) -> EventSummary {
        var joiners: [Joiner] = []
        if let ja = o["joiners"] as? [[String: Any]] {
            for jo in ja {
                let displayLabel = (jo["displayLabel"] as? String) ?? ""
                let name = (jo["name"] as? String) ?? ""
                joiners.append(Joiner(
                    entryId: nonBlank(jo["entryId"] as? String),
                    name: displayLabel.isEmpty ? name : displayLabel,
                    type: nonBlank(jo["type"] as? String),
                    entryType: nonBlank(jo["entryType"] as? String)
                ))
            }
        }
        return EventSummary(
            id: (o["id"] as? String) ?? "",
            title: nonBlank(o["title"] as? String) ?? "(untitled)",
            type: nonBlank(o["type"] as? String),
            joiners: joiners
        )
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Event state — reconstruct solo matches by grouping per-player rows on _matchSid.
// State is a flat `beyResults[]` array (a match = the rows sharing a _matchSid).
// Lenient JSONSerialization parsing mirrors Android (tolerant of nulls / extra fields).
// ─────────────────────────────────────────────────────────────────────────────
struct EventState: Equatable {
    var matches: [SoloMatch]
    var buildsByPlayer: [String: [String]]

    static func decode(_ data: Data) throws -> EventState {
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw RxsError.parse("event state response was not a JSON object")
        }

        var buildsByPlayer: [String: [String]] = [:]
        if let b = root["builds"] as? [String: Any] {
            for (k, v) in b {
                if let arr = v as? [Any] {
                    buildsByPlayer[k] = arr.compactMap { $0 as? String }
                }
            }
        }

        let rows = root["beyResults"] as? [[String: Any]] ?? []
        var order: [String] = []
        var groups: [String: [[String: Any]]] = [:]
        for r in rows {
            if let team = r["team"] as? String, !team.isEmpty { continue } // solo only
            guard let sid = r["_matchSid"] as? String, !sid.isEmpty else { continue }
            if groups[sid] == nil { order.append(sid); groups[sid] = [] }
            groups[sid]?.append(r)
        }

        var matches: [SoloMatch] = []
        for sid in order {
            guard let g = groups[sid], g.count >= 2 else { continue }
            let submitted = g.contains { ($0["_submitted"] as? Bool) == true }
            matches.append(SoloMatch(
                sid: sid,
                round: nonBlank(g[0]["round"] as? String) ?? "?",
                p1: side(from: g[0]),
                p2: side(from: g[1]),
                submitted: submitted
            ))
        }
        return EventState(matches: matches, buildsByPlayer: buildsByPlayer)
    }

    private static func side(from r: [String: Any]) -> Side {
        var builds: [Bey] = []
        if let ba = r["builds"] as? [[String: Any]] {
            for bo in ba {
                let finishes = (bo["finishes"] as? [Any])?.compactMap { $0 as? String } ?? []
                builds.append(Bey(
                    build: (bo["build"] as? String) ?? "",
                    finishes: finishes,
                    deployed: (bo["deployed"] as? Bool) ?? false
                ))
            }
        }
        return Side(
            player: (r["player"] as? String) ?? "",
            entryId: nonBlank(r["entryId"] as? String),
            displayLabel: nonBlank(r["displayLabel"] as? String),
            builds: builds,
            win: (r["win"] as? Bool) ?? false
        )
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUT payload — merge-mode write of a single match's two rows.
// { adminUsername, adminPassword, eventId, beyResults:[row,row], builds{}, mergeMode, revivedSids }
// `_submitted` is added per row only when `submitted` is true (live pushes omit it).
// ─────────────────────────────────────────────────────────────────────────────
enum MatchPayload {
    static func encode(eventId: String, match: SoloMatch, submitted: Bool,
                       username: String, password: String) throws -> Data {
        let body: [String: Any] = [
            "adminUsername": username,
            "adminPassword": password,
            "eventId": eventId,
            "beyResults": [
                row(match.p1, round: match.round, sid: match.sid, submitted: submitted),
                row(match.p2, round: match.round, sid: match.sid, submitted: submitted)
            ],
            "builds": [
                match.p1.player: match.p1.builds.map(\.build),
                match.p2.player: match.p2.builds.map(\.build)
            ],
            "mergeMode": true,
            "revivedSids": [String]()
        ]
        return try JSONSerialization.data(withJSONObject: body, options: [])
    }

    private static func row(_ side: Side, round: String, sid: String, submitted: Bool) -> [String: Any] {
        var o: [String: Any] = [
            "player": side.player,
            "round": round,
            "builds": side.builds.map { b -> [String: Any] in
                ["build": b.build, "finishes": b.finishes, "deployed": b.deployed]
            },
            "pointsTotal": side.points,
            "win": side.win,
            "_matchSid": sid
        ]
        if let e = side.entryId { o["entryId"] = e }
        if let d = side.displayLabel { o["displayLabel"] = d }
        if submitted { o["_submitted"] = true }
        return o
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────
enum RxsError: LocalizedError {
    case server(String)
    case parse(String)
    case unsafeConcurrency

    var errorDescription: String? {
        switch self {
        case .server(let m): return m
        case .parse(let m): return m
        case .unsafeConcurrency:
            return "Live scoring unsafe (best-effort-kv). Confirm BEY_STATE_DO is bound before multi-judge use."
        }
    }
}

/// Trim a server string field to nil when blank (mirrors Android `.ifBlank { null }`).
func nonBlank(_ s: String?) -> String? {
    guard let s, !s.isEmpty else { return nil }
    return s
}
