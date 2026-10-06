import SwiftUI

@main
struct OpenStrudelApp: App {
    @StateObject private var client = HomeClient()
    #if os(macOS)
    @StateObject private var updater = AppUpdater.shared
    #endif

    var body: some Scene {
        WindowGroup(id: "home") {
            OpenStrudelRootView()
                .environmentObject(client)
                .tint(AppTheme.accent)
                #if os(macOS)
                .modifier(AppIconAppearance())
                .modifier(HomeStatusItemAppearance())
                .environmentObject(client)
                #endif
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
            CommandGroup(replacing: .newItem) {
                Button("Новый сотрудник") { client.beginEmployee() }
                    .keyboardShortcut("n", modifiers: .command)
                    .disabled(client.health == nil || client.isCreating)
            }
            CommandGroup(after: .appInfo) {
                Button("Аккаунты и остатки") {
                    Task { @MainActor in
                        // Let the application menu finish tracking before opening
                        // the transient status popover.
                        await Task.yield()
                        HomeStatusItem.shared.showAccounts()
                    }
                }
                    .keyboardShortcut("u", modifiers: [.command, .shift])
                Button("Проверить обновления…", action: updater.checkForUpdates)
                    .disabled(!updater.canCheckForUpdates)
            }
        }
        #endif
        #if os(macOS)
        Window("Серверы", id: "servers") {
            HostingStoreView().tint(AppTheme.accent)
        }.defaultSize(width: 1000, height: 760)
        Settings {
            SettingsView()
                .environmentObject(client)
                .tint(AppTheme.accent)
                .frame(minWidth: 580, minHeight: 520)
        }
        #endif
    }
}
