import SwiftUI

@main
struct OpenStrudelApp: App {
    @StateObject private var client = HomeClient()

    var body: some Scene {
        WindowGroup {
            OpenStrudelRootView()
                .environmentObject(client)
                .tint(.indigo)
                .onOpenURL { url in
                    // ASWebAuthenticationSession owns OAuth callbacks; these are not pairing links.
                    guard !(url.scheme == "openstrudel" && url.host == "oauth" && url.path == "/digitalocean") else { return }
                    client.preparePairing(url)
                }
        }
        #if os(macOS)
        .windowStyle(.hiddenTitleBar)
        .windowToolbarStyle(.unifiedCompact)
        .defaultSize(width: 1120, height: 760)
        #endif
        #if os(macOS)
        Settings {
            SettingsView()
                .environmentObject(client)
                .frame(minWidth: 580, minHeight: 520)
        }
        #endif
    }
}
