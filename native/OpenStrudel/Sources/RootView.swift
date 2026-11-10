import SwiftUI

extension EnvironmentValues {
    /// The namespace a page zooms in: a tile, a row or a capsule on one page is where the next page grows from.
    @Entry var zoomNamespace: Namespace.ID? = nil
}

/// One chat owns the composer; everything else is read. Home is the root: what the team did today as tiles, the team
/// as rows, and the way to write. On a phone it is the first screen and every place pushes over it; on a Mac or an
/// iPad it is the sidebar beside the open place, the chat by default. There are no tabs.
struct OpenStrudelRootView: View {
    @EnvironmentObject private var library: DeviceLibrary
    @Environment(\.scenePhase) private var scenePhase
    @EnvironmentObject private var client: HomeClient
    #if os(macOS)
    /// The toolbar or title bar above this view; the window minimum includes it.
    @State private var titleBarHeight: CGFloat = 0
    #else
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var showSettings = false
    #endif
    /// The place open beside the home, when the home is a sidebar.
    @State private var place = HomePlace.chat
    /// The pages pushed over that place.
    @State private var detailPath: [HomePlace] = []
    /// The pages pushed over the home, when the home is the whole screen.
    @State private var path: [HomePlace] = []
    /// What each page grew out of: a row, a tile or a capsule. Its way back leads there.
    @State private var sources: [HomePlace: AnyHashable] = [:]
    /// Counts the times the chat was opened to write; its composer takes the keyboard on each.
    @State private var writes = 0
    @Namespace private var zoom
    /// The News desks: what each has shown, what this device has read, and where its reader is.
    @StateObject private var newsroom = Newsroom()
    /// What this device has read of each employee.
    @StateObject private var marks = TeamReadMarks()
    /// What the shelf shows of the chat's Home: results, what needs attention, progress and the subscriptions' limits.
    @StateObject private var activity = ActivityModel()
    @StateObject private var limits = ActivityLimitsModel()
    @State private var showHistory = false
    @AppStorage("openstrudel.aiConsent.v1") private var aiConsent = false

    private var activityScope: String { client.id + ":" + (client.health?.homeId ?? "") + ":" + (client.health?.primaryId ?? "") }

    private var isSplit: Bool {
        #if os(macOS)
        true
        #else
        sizeClass == .regular
        #endif
    }

    /// Changes when a Home's list of employees does, or when a Home begins to list its team's work.
    private var catalogues: [String] {
        library.teamHomes.map { source in
            let employees = source.profiles.map(\.id).joined(separator: ",")
            let listsWork = source.profiles.contains { $0.working != nil }
            return source.catalogueIdentity + ":" + employees + ":" + String(listsWork)
        }
    }

    private var pollingPhase: ScenePhase {
        #if os(iOS)
        scenePhase
        #else
        // A visible Mac window stays current even when another app has focus.
        .active
        #endif
    }

    var body: some View {
        screens
        .onChange(of: client.id) { _, _ in path.removeAll(); detailPath.removeAll(); place = .chat }
        .onChange(of: activityScope) { _, _ in activity.clear(); limits.clear() }
        .task(id: "\(pollingPhase)-\(client.id)") {
            guard pollingPhase == .active else { return }
            #if os(macOS)
            if Bundle.main.bundleIdentifier == "is.openstrudel.mac",
               let local = library.localClientToRestore, LocalHome.isAvailable {
                await local.startLocalHome()
            }
            #endif
            if client.shouldRestoreConnection && !client.isPairing { await client.load(quiet: true) }
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(client.health == nil ? 5 : 1)) } catch { break }
                if client.health != nil { await client.refreshConversation() }
                else if client.shouldRestoreConnection && !client.isPairing && !client.connectionNeedsPairing {
                    await client.load(quiet: true)
                }
            }
        }
        .task(id: "\(pollingPhase)-\(client.id)") {
            guard pollingPhase == .active else { return }
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(10)) } catch { break }
                await client.refreshOpenAIAccount()
            }
        }
        // Each desk keeps its count and its lead current by itself; a slow Home holds up no other.
        .task(id: "\(pollingPhase)-" + library.newsFeeds.map(\.route.id).joined(separator: ",")) {
            guard pollingPhase == .active else { return }
            await withTaskGroup(of: Void.self) { group in
                for feed in library.newsFeeds.map({ newsroom.feed($0.route, on: $0.source) }) {
                    group.addTask {
                        while !Task.isCancelled {
                            await feed.poll()
                            do { try await Task.sleep(for: .seconds(5)) } catch { break }
                        }
                    }
                }
            }
        }
        // The shelf reads the Home's activity and limits when the home comes into sight and every few minutes after:
        // they change with a run, not with a keystroke.
        .task(id: "\(pollingPhase)-" + activityScope) {
            guard pollingPhase == .active else { return }
            while !Task.isCancelled {
                if client.health != nil { await refreshActivity(includeLimits: true) }
                do { try await Task.sleep(for: .seconds(client.health == nil ? 5 : 300)) } catch { break }
            }
        }
        // Coming back to the home, or opening one of the pages behind its tiles, reads them again at once.
        .onChange(of: path) { _, pages in
            guard pages.isEmpty || pages.last == .insights || pages.last == .progress else { return }
            Task { await refreshActivity(includeLimits: true) }
        }
        .onChange(of: place) { _, place in
            guard place == .insights || place == .progress else { return }
            Task { await refreshActivity(includeLimits: true) }
        }
        // An employee this device meets for the first time starts read.
        .onChange(of: catalogues, initial: true) { _, _ in
            for source in library.teamHomes { marks.meet(source.profiles, on: source) }
        }
        // An employee that left with its device, or was hidden, gives its place back to the chat. One that published
        // its first story stays open as the desk it has become.
        .onChange(of: library.team.map(\.member.id)) { _, rows in
            guard case .reader(let route) = place, route.profileID != nil, !rows.contains(route.id) else { return }
            if let same = library.team.first(where: { $0.member.route.connectionID == route.connectionID && $0.member.profile.id == route.profileID }) { place = .reader(same.member.route) }
            else { place = .chat }
        }
        #if os(macOS)
        // A server that finishes installing after its setup window closed joins the list by itself.
        .task { await library.watchPendingServer() }
        #endif
        #if os(iOS)
        .sheet(isPresented: $showSettings) {
            SettingsView().environmentObject(client)
        }
        #endif
        .sheet(isPresented: $showHistory) {
            EmployeePicker { route in
                showHistory = false
                open(.reader(route))
            }
            .environmentObject(client)
        }
        .sheet(item: $client.pendingPairing) { pairing in
            AddDeviceConfirmation(pairing: pairing).environmentObject(library)
        }
        .alert(
            "OpenStrudel",
            isPresented: Binding(
                get: { client.errorMessage != nil },
                set: { if !$0 { client.errorMessage = nil } }
            )
        ) {
            Button(L("Понятно"), role: .cancel) {}
        } message: {
            Text(UserFacingError.text(client.errorMessage ?? ""))
        }
        #if os(macOS)
        // SwiftUI measures this view below the toolbar, so the window's 560 includes the toolbar.
        .frame(minWidth: 760, minHeight: 560 - titleBarHeight)
        .onGeometryChange(for: CGFloat.self) { $0.safeAreaInsets.top } action: { titleBarHeight = $0 }
        .containerBackground(AppTheme.canvas, for: .window)
        #endif
    }

    @ViewBuilder private var screens: some View {
        #if os(macOS)
        state.frame(maxWidth: .infinity, maxHeight: .infinity)
        #else
        ZStack {
            HomeBackground()
            state
        }
        #endif
    }

    @ViewBuilder private var state: some View {
        if client.isConnecting && !library.hasOtherDevices {
            HomeConnectingView()
        } else if client.health == nil && !library.hasOtherDevices {
            #if os(iOS)
            MobileWelcomeView()
            #else
            HomeUnavailableView()
            #endif
        } else if !aiConsent {
            AIDataConsentView { aiConsent = true }
        } else if client.openAIAccount?.connected == false && !client.hasOpenedConversation && client.profiles.isEmpty && client.devices.count < 2 {
            OpenAIWelcomeView()
        } else {
            places
        }
    }

    /// The home beside the open place, or the home alone with every place pushed over it.
    private var places: some View {
        Group {
            if isSplit { splitLayout } else { stackLayout }
        }
        // Edit › Find a chat (⌘F) opens the conversations and their search.
        .focusedSceneValue(\.findChat) { showHistory = true }
        .environment(\.zoomNamespace, zoom)
        .environmentObject(newsroom)
        .environmentObject(marks)
    }

    private var splitLayout: some View {
        NavigationSplitView {
            home(selection: place)
                .navigationSplitViewColumnWidth(min: 300, ideal: 320, max: 420)
                #if os(iOS)
                .toolbar(.hidden, for: .navigationBar)
                #endif
        } detail: {
            NavigationStack(path: $detailPath) {
                page(place).navigationDestination(for: HomePlace.self) { page($0) }
            }
            // Another place, or the chat of another Home, is another stack.
            .id(AnyHashable([AnyHashable(place), AnyHashable(place == .chat ? client.id : "")]))
        }
        #if os(macOS)
        // View › the chat, each employee in sight, Statistics: ⌘1, ⌘2… in the home's order.
        .focusedSceneValue(\.places, placeCommands)
        #endif
    }

    private var stackLayout: some View {
        NavigationStack(path: $path) {
            home(selection: nil)
                .background(AppTheme.canvas)
                #if os(iOS)
                .toolbar(.hidden, for: .navigationBar)
                #endif
                .navigationDestination(for: HomePlace.self) { place in
                    page(place)
                        #if os(iOS)
                        // A page grows out of what was pressed and goes back into it.
                        .navigationTransition(.zoom(sourceID: sources[place] ?? AnyHashable(place), in: zoom))
                        #endif
                }
        }
    }

    private func home(selection: HomePlace?) -> some View {
        HomeView(activity: activity, limits: limits, scope: activityScope, selection: selection, split: selection != nil, zoom: zoom,
                 open: { place, source in open(place, from: source, writing: source == AnyHashable("composer")) },
                 openSearch: { showHistory = true },
                 openSettings: {
                     #if os(iOS)
                     showSettings = true
                     #endif
                 })
    }

    @ViewBuilder private func page(_ place: HomePlace) -> some View {
        switch place {
        case .chat: chat
        case .reader(let route): ReaderScreen(route: route, discuss: discuss)
        case .insights:
            InsightsPage(model: activity, scope: activityScope, refresh: { await refreshActivity(includeLimits: false) }, openChat: { open(.chat) })
        case .insight(let item): InsightDetail(item: item, discuss: discuss)
        case .progress:
            ProgressPage(model: activity, limits: limits, scope: activityScope, refresh: { await refreshActivity(includeLimits: true, force: true) }, openChat: { open(.chat) })
        case .statistics: StatisticsScreen()
        }
    }

    /// Opens a place. The chat is one page: when it is already under the open pages, the way to it is back.
    private func open(_ next: HomePlace, from source: AnyHashable? = nil, writing: Bool = false) {
        if writing { writes += 1 }
        if isSplit {
            // Leaving a desk for another place closes its pages, not what the reader had open in it.
            if next != place { newsroom.hold() }
            detailPath.removeAll()
            place = next
        } else if next == .chat, let index = path.firstIndex(of: .chat) {
            path.removeSubrange(path.index(after: index)...)
        } else if path.last != next {
            sources[next] = source ?? AnyHashable(next)
            path.append(next)
        }
    }

    #if os(macOS)
    private var placeCommands: [PlaceCommand] {
        let shown = library.team.filter { $0.source === library.primary || !library.collapsedDeviceIDs.contains($0.source.id) }
        let members = shown.map { row in PlaceCommand(id: row.member.id, title: row.member.profile.name) { open(.reader(row.member.route)) } }
        return [PlaceCommand(id: "chat", title: L("Чат")) { open(.chat) }] + members
            + [PlaceCommand(id: "statistics", title: L("Статистика")) { open(.statistics) }]
    }
    #endif

    private func refreshActivity(includeLimits: Bool, force: Bool = false) async {
        let source = client, scope = activityScope
        await activity.load(scope: scope) { try await source.readActivity() }
        guard includeLimits, !Task.isCancelled, scope == activityScope else { return }
        await limits.load(scope: scope) { try await source.management("/v1/accounts?refresh=" + String(force)) }
    }

    /// «Обсудить» and «Спросить про…»: the message or the story goes to the one composer, and the reader with it.
    private func discuss(_ context: ChatContext) {
        library.attach(context)
        // A story stays open in its desk for when the reader comes back.
        newsroom.hold()
        open(.chat, from: AnyHashable("ask"), writing: true)
    }

    private var chat: some View {
        // Each device keeps its own draft, files and reading position.
        #if os(macOS)
        ConversationView(writes: writes, covered: showHistory, openHistory: { showHistory = true })
        #else
        ConversationView(showSettings: $showSettings, writes: writes, startsWriting: !isSplit && sources[.chat] != AnyHashable(HomePlace.chat),
                         covered: showHistory || showSettings, openHistory: { showHistory = true })
        #endif
    }
}
