import SwiftUI

@main
struct RXSRecorderApp: App {
    var body: some Scene {
        WindowGroup {
            AppRoot()
                .preferredColorScheme(.dark)
                .statusBarHidden(true)
        }
    }
}
