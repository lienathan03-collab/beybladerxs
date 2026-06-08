import SwiftUI

/// Server/admin connection screen. Mirrors Android SetupScreen: default live URL,
/// Connect disabled while empty/busy, normalize before login, persist only on
/// success, and keep the user on this screen when login fails.
struct SetupView: View {
    @ObservedObject var settings: AppSettings
    let api: RxsAPI
    let onDone: () -> Void

    @State private var url = ""
    @State private var user = ""
    @State private var pass = ""
    @State private var busy = false
    @State private var error: String?
    @State private var loaded = false

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            VStack(alignment: .leading, spacing: 12) {
                Text("RXS Recorder — connect")
                    .foregroundColor(.white)
                    .font(.system(size: 20, weight: .semibold))

                field("Server URL (your live site)", text: $url, keyboard: .URL)
                field("Admin username", text: $user)
                field("Admin password", text: $pass, secure: true)

                if let error {
                    Text(error).foregroundColor(Color(red: 1, green: 0.53, blue: 0.57)).font(.system(size: 13))
                }

                Button(action: connect) {
                    Text(busy ? "Connecting…" : "Connect")
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                }
                .buttonStyle(.borderedProminent)
                .disabled(busy || url.isEmpty || user.isEmpty || pass.isEmpty)

                Text("Stored on this device only. Admin login is required to write scores.")
                    .foregroundColor(Color(red: 0.53, green: 0.58, blue: 0.65))
                    .font(.system(size: 11))
                Spacer()
            }
            .padding(20)
        }
        .onAppear {
            guard !loaded else { return }
            loaded = true
            url = settings.serverURL.isEmpty ? AppSettings.defaultURL : settings.serverURL
            user = settings.adminUsername
            pass = settings.adminPassword
        }
    }

    private func connect() {
        busy = true
        error = nil
        let normalized = AppSettings.normalizeServerURL(url)
        url = normalized
        let u = user.trimmingCharacters(in: .whitespaces)
        let p = pass
        Task { @MainActor in
            do {
                try await api.login(url: normalized, username: u, password: p)
                settings.serverURL = normalized
                settings.adminUsername = u
                settings.adminPassword = p
                settings.save()
                busy = false
                onDone()
            } catch {
                busy = false
                self.error = uiMessage(error)
            }
        }
    }

    @ViewBuilder
    private func field(_ label: String, text: Binding<String>,
                       secure: Bool = false, keyboard: UIKeyboardType = .default) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).foregroundColor(Color(white: 0.6)).font(.system(size: 11))
            Group {
                if secure {
                    SecureField("", text: text)
                } else {
                    TextField("", text: text)
                        .keyboardType(keyboard)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
            }
            .foregroundColor(.white)
            .padding(10)
            .background(Color(red: 0.07, green: 0.08, blue: 0.11))
            .cornerRadius(8)
        }
    }
}
