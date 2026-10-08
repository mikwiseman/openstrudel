import SwiftUI

@main
struct OpenStrudelApp: App {
    @StateObject private var library = DeviceLibrary()
    private var client: HomeClient { library.active }
    #if os(macOS)
    @StateObject private var updater = AppUpdater.shared
    #endif

    var body: some Scene {
        #if os(macOS)
        mainWindow
        .windowStyle(.hiddenTitleBar)
        .windowToolbarStyle(.unifiedCompact)
        .defaultSize(width: 1120, height: 760)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("Новый сотрудник") { library.beginEmployee() }
                    .keyboardShortcut("n", modifiers: .command)
                    .disabled(client.isCreating || library.isErasing)
            }
            CommandGroup(after: .appInfo) {
                Button("Аккаунты и остатки") {
                    Task { @MainActor in
                        await Task.yield()
                        HomeStatusItem.shared.showAccounts()
                    }
                }
                    .keyboardShortcut("u", modifiers: [.command, .shift])
                Button("Проверить обновления…", action: updater.checkForUpdates)
                    .disabled(!updater.canCheckForUpdates)
            }
        }
        Window("Серверы", id: "servers") {
            Group {
                if library.isErasing { LocalDataResetProgress().environmentObject(library) }
                else { HostingStoreView() }
            }.tint(AppTheme.accent)
        }.defaultSize(width: 1000, height: 760)
        Settings {
            Group {
                if library.isErasing { LocalDataResetProgress() }
                else { SettingsView() }
            }
                .environmentObject(client)
                .environmentObject(library)
                .tint(AppTheme.accent)
                .frame(minWidth: 580, minHeight: 520)
        }
        #else
        mainWindow
        #endif
    }

    @SceneBuilder private var mainWindow: some Scene {
        #if os(macOS)
        // The menu-bar Open action brings back the same workspace, including
        // its draft and reading position, instead of creating another window.
        Window("OpenStrudel", id: "home") { applicationContent }
        #else
        WindowGroup(id: "home") { applicationContent }
        #endif
    }

    private var applicationContent: some View {
        Group {
            #if os(macOS)
            if library.isErasing { LocalDataResetProgress() }
            else { OpenStrudelRootView() }
            #else
            OpenStrudelRootView()
            #endif
        }
            .id(client.id + "-" + String(library.viewGeneration))
            .tint(AppTheme.accent)
            #if os(macOS)
            .modifier(AppIconAppearance())
            .modifier(HomeStatusItemAppearance())
            #endif
            .sheet(item: $library.invitation) { pairing in
                AddDeviceConfirmation(pairing: pairing)
                    .environmentObject(library)
            }
            .task {
                while !Task.isCancelled {
                    await library.refresh()
                    do { try await Task.sleep(for: .seconds(15)) } catch { break }
                }
            }
            .onOpenURL { url in
                guard !library.isErasing else { return }
                if url.scheme == "openstrudel" && url.host == "oauth" && url.path == "/digitalocean" {
                    #if os(macOS)
                    DigitalOceanCloud.shared.acceptBrowserCallback(url)
                    #endif
                    return
                }
                library.preparePairing(url)
            }
            .environmentObject(client)
            .environmentObject(library)
    }
}
