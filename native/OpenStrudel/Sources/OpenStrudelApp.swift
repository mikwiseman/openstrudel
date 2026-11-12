import SwiftUI

@main
struct OpenStrudelApp: App {
    @StateObject private var library = DeviceLibrary()
    @Environment(\.scenePhase) private var scenePhase
    private var client: HomeClient { library.active }
    #if os(macOS)
    @StateObject private var updater = AppUpdater.shared
    #endif

    var body: some Scene {
        #if os(macOS)
        mainWindow
        .windowToolbarStyle(.unified(showsTitle: false))
        .defaultSize(width: 1120, height: 760)
        .commands {
            CommandGroup(replacing: .newItem) {
                EmployeeDetailsCommand()
            }
            CommandGroup(after: .textEditing) { FindChatCommand() }
            // View › the sidebar's places, in its order.
            CommandGroup(after: .sidebar) { PlaceCommands() }
            CommandGroup(after: .appInfo) {
                Button(L("Аккаунты и остатки")) {
                    Task { @MainActor in
                        await Task.yield()
                        HomeStatusItem.shared.showAccounts()
                    }
                }
                    .keyboardShortcut("u", modifiers: [.command, .shift])
                Button(L("Проверить обновления…"), action: updater.checkForUpdates)
                    .disabled(!updater.canCheckForUpdates)
            }
        }
        Window(L("Серверы"), id: "servers") {
            Group {
                if library.isErasing { LocalDataResetProgress().environmentObject(library) }
                else { HostingStoreView() }
            }.tint(AppTheme.accent)
            .modifier(InterfaceLanguage())
        }.defaultSize(width: 1000, height: 760)
        // It opens only from General's Servers row, which a build shows only when it has a hosting store.
        .commandsRemoved()
        .restorationBehavior(.disabled)
        Settings {
            Group {
                if library.isErasing { LocalDataResetProgress() }
                else { SettingsView(standalone: true) }
            }
                .environmentObject(client)
                .environmentObject(library)
                .tint(AppTheme.accent)
            .modifier(InterfaceLanguage())
        }.windowResizability(.contentSize)
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
            // Only an erase rebuilds the window; each device's conversation keeps its own identity.
            .id(library.viewGeneration)
            .tint(AppTheme.accent)
            .modifier(InterfaceLanguage())
            #if os(macOS)
            .modifier(AppIconAppearance())
            .modifier(HomeStatusItemAppearance())
            #endif
            .sheet(item: $library.invitation) { pairing in
                AddDeviceConfirmation(pairing: pairing)
                    .environmentObject(library)
            }
            .task(id: library.connectionListKey + (scenePhase == .background ? ":background" : ":visible")) {
                #if os(macOS)
                // A Mac app lives on in the menu bar with its window closed. The library keeps its lists of Homes and
                // employees current for as long as the app runs, so no window opens on this morning's team.
                library.keepCataloguesCurrent()
                #else
                guard scenePhase != .background else { return }
                await library.watchCatalogues()
                #endif
            }
            .onOpenURL { url in
                guard !library.isErasing else { return }
                if url.scheme == "openstrudel" && url.host == "oauth" && url.path == "/digitalocean" {
                    #if os(macOS)
                    DigitalOceanCloud.shared.acceptBrowserCallback(url)
                    #endif
                    return
                }
                if url.scheme == "openstrudel" && url.host == "oauth" && url.path.hasPrefix("/service/") {
                    _ = library.clients.first { $0.acceptServiceCallback(url) }
                    return
                }
                library.preparePairing(url)
            }
            .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                if let url = activity.webpageURL { library.preparePairing(url) }
            }
            .environmentObject(client)
            .environmentObject(library)
    }
}

#if os(macOS)
extension FocusedValues {
    /// Opens the selected employee's details from the menu bar.
    @Entry var showEmployeeDetails: (() -> Void)?
    /// Opens the conversations and their search.
}

private struct FindChatCommand: View {
    @FocusedValue(\.findChat) private var findChat

    var body: some View {
        Button(L("Переписки")) { findChat?() }
            .keyboardShortcut("f", modifiers: .command)
            .disabled(findChat == nil)
    }
}

private struct PlaceCommands: View {
    @FocusedValue(\.places) private var places

    var body: some View {
        if let places {
            // The chat and the team in the home's order: ⌘1 to ⌘9 for the first nine, the rest by name only. Then the
            // pages behind the home's tiles, which a long team must never push off the menu.
            ForEach(Array(places.filter { !$0.page }.enumerated()), id: \.element.id) { index, place in
                if index < 9 {
                    Button(place.title, action: place.open)
                        .keyboardShortcut(KeyEquivalent(Character(String(index + 1))), modifiers: .command)
                } else {
                    Button(place.title, action: place.open)
                }
            }
            Divider()
            ForEach(places.filter(\.page)) { place in Button(place.title, action: place.open) }
        } else {
            Button(L("Чат")) {}.keyboardShortcut("1", modifiers: .command).disabled(true)
            Button(L("Статистика")) {}.keyboardShortcut("2", modifiers: .command).disabled(true)
        }
    }
}

private struct EmployeeDetailsCommand: View {
    @FocusedValue(\.showEmployeeDetails) private var showDetails

    var body: some View {
        Button(L("Настройки сотрудника")) { showDetails?() }
            .keyboardShortcut("i", modifiers: .command)
            .disabled(showDetails == nil)
    }
}
#endif
