import Foundation

// ─────────────────────────────────────────────────────────────────────────────
// Settings — PROTOTYPE: plain UserDefaults. Admin creds are NOT encrypted here;
// Keychain hardening / scoped token is a TODO before real deployment (mirrors the
// Android Settings note). Stored on this device only; admin login writes scores.
// ─────────────────────────────────────────────────────────────────────────────
@MainActor
final class AppSettings: ObservableObject {
    @Published var serverURL: String
    @Published var adminUsername: String
    @Published var adminPassword: String

    static let defaultURL = "https://beybladerxs.pages.dev"
    private static let urlKey = "rxs.url"
    private static let userKey = "rxs.user"
    private static let passKey = "rxs.pass"

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.serverURL = defaults.string(forKey: Self.urlKey) ?? Self.defaultURL
        self.adminUsername = defaults.string(forKey: Self.userKey) ?? ""
        self.adminPassword = defaults.string(forKey: Self.passKey) ?? ""
    }

    var isConfigured: Bool {
        !serverURL.isEmpty && !adminUsername.isEmpty && !adminPassword.isEmpty
    }

    func save() {
        defaults.set(serverURL, forKey: Self.urlKey)
        defaults.set(adminUsername, forKey: Self.userKey)
        defaults.set(adminPassword, forKey: Self.passKey)
    }

    /// Normalize a user-entered server URL so a typo can't cause a redirect that
    /// downgrades POST→GET (answered 405). Forces https, drops any path/trailing
    /// slash, leaving scheme://host[:port]. Mirrors Android `normalizeServerUrl`.
    /// `nonisolated` so it is callable from non-main contexts (tests, request setup).
    nonisolated static func normalizeServerURL(_ raw: String) -> String {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { return s }
        if s.hasPrefix("https://") {
            // already https
        } else if s.hasPrefix("http://") {
            s = "https://" + s.dropFirst("http://".count)
        } else {
            s = "https://" + s
        }
        guard let scheme = s.range(of: "://") else { return s }
        if let slash = s.range(of: "/", range: scheme.upperBound..<s.endIndex) {
            s = String(s[s.startIndex..<slash.lowerBound])
        }
        return s
    }
}
