import SwiftUI

@main
struct OpenStrudelApp: App {
    @StateObject private var client = HomeClient()
    #if os(macOS)
    @StateObject private var updater = AppUpdater.shared
    #endif

    var body: some Scene {
        WindowGroup {
            OpenStrudelRootView()
                .environmentObject(client)
                .tint(AppTheme.accent)
                .onOpenURL { url in
                    if url.scheme == "openstrudel" && url.host == "oauth" && url.path == "/digitalocean" {
                        #if os(macOS)
                        DigitalOceanCloud.shared.acceptBrowserCallback(url)
                        #endif
                        return
                    }
                    client.preparePairing(url)
                }
        }
        #if os(macOS)
        .windowStyle(.hiddenTitleBar)
        .windowToolbarStyle(.unifiedCompact)
        .defaultSize(width: 1120, height: 760)
        .commands {
            CommandGroup(after: .appInfo) {
                Button("Проверить обновления…", action: updater.checkForUpdates)
                    .disabled(!updater.canCheckForUpdates)
            }
        }
        #endif
        #if os(macOS)
        Settings {
            SettingsView()
                .environmentObject(client)
                .tint(AppTheme.accent)
                .frame(minWidth: 580, minHeight: 520)
        }
        #endif
    }
}
