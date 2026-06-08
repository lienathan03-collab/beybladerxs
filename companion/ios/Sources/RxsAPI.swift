import Foundation

// ─────────────────────────────────────────────────────────────────────────────
// API client — endpoints/contracts from docs/rxs-companion/phase1-eventmanager-api-report.md
//   POST /api/login            (admin: username/password in body, no token)
//   GET  /api/events           (public)
//   GET  /api/beyresults?eventId=…&_t=…   (public; cache-bust)
//   PUT  /api/beyresults       (admin creds re-sent in every write body, mergeMode)
//
// A network error here MUST never stop or alter CameraController — callers (the
// ScoringStore) catch and surface "sync failed" while recording continues.
// ─────────────────────────────────────────────────────────────────────────────
final class RxsAPI {
    private let settings: AppSettings
    private let session: URLSession
    private let timeout: TimeInterval = 15

    init(settings: AppSettings, session: URLSession = .shared) {
        self.settings = settings
        self.session = session
    }

    // Login uses the URL/creds the user just typed (not yet persisted).
    func login(url: String, username: String, password: String) async throws {
        let body = try JSONSerialization.data(withJSONObject: ["username": username, "password": password])
        let (data, http) = try await send(urlString: base(url) + "/api/login", method: "POST", body: body)
        try ensureOK(data, http)
    }

    func events() async throws -> [EventSummary] {
        let c = await creds()
        let (data, http) = try await send(urlString: c.base + "/api/events", method: "GET", body: nil)
        try ensureOK(data, http)
        return try EventSummary.list(from: data)
    }

    func eventState(eventId: String) async throws -> EventState {
        let c = await creds()
        guard var comps = URLComponents(string: c.base + "/api/beyresults") else {
            throw RxsError.server("Bad server URL")
        }
        comps.queryItems = [
            URLQueryItem(name: "eventId", value: eventId),
            URLQueryItem(name: "_t", value: String(Int(Date().timeIntervalSince1970 * 1000)))
        ]
        guard let url = comps.url else { throw RxsError.server("Bad server URL") }
        let (data, http) = try await send(urlString: url.absoluteString, method: "GET", body: nil)
        try ensureOK(data, http)
        return try EventState.decode(data)
    }

    /// Push this match's two rows (merge mode). `submitted` marks the result final.
    func putMatch(eventId: String, match: SoloMatch, submitted: Bool) async throws {
        let c = await creds()
        let body = try MatchPayload.encode(
            eventId: eventId, match: match, submitted: submitted,
            username: c.user, password: c.pass
        )
        let (data, http) = try await send(urlString: c.base + "/api/beyresults", method: "PUT", body: body)
        try ensureOK(data, http)
        // Gate multi-judge live scoring exactly as the web client does.
        if http.value(forHTTPHeaderField: "X-BEY-CONCURRENCY") == "best-effort-kv" {
            throw RxsError.unsafeConcurrency
        }
    }

    // MARK: - Internals

    private struct Creds { let base: String; let user: String; let pass: String }

    private func creds() async -> Creds {
        await MainActor.run {
            Creds(base: base(settings.serverURL), user: settings.adminUsername, pass: settings.adminPassword)
        }
    }

    /// Strip trailing slashes so `base + "/api/..."` never double-slashes.
    private func base(_ url: String) -> String {
        var s = url.trimmingCharacters(in: .whitespacesAndNewlines)
        while s.hasSuffix("/") { s.removeLast() }
        return s
    }

    private func send(urlString: String, method: String, body: Data?) async throws -> (Data, HTTPURLResponse) {
        guard let url = URL(string: urlString) else { throw RxsError.server("Bad server URL") }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.timeoutInterval = timeout
        if let body {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw RxsError.server("No HTTP response") }
        return (data, http)
    }

    private func ensureOK(_ data: Data, _ http: HTTPURLResponse) throws {
        guard (200..<300).contains(http.statusCode) else {
            throw RxsError.server(serverError(data, http.statusCode))
        }
    }

    /// Surface the server's `error` field when present, else a bare HTTP status.
    private func serverError(_ data: Data, _ code: Int) -> String {
        if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let err = obj["error"] as? String, !err.isEmpty {
            return err
        }
        return "HTTP \(code)"
    }
}
