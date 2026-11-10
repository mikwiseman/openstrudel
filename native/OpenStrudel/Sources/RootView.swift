import SwiftUI

enum PrimaryTab: String, CaseIterable {
    case chat, statistics
    #if os(iOS)
    case team, insights, progress
    #else
    /// An employee chosen in the sidebar.
    case member
    #endif
}

/// One chat owns the composer; the team beside it is read. The Mac sidebar lists the main assistant and every employee with
/// what it is doing now, the iPhone has the same rows under «Команда». Statistics reads every connected Home, and mobile
/// adds sourced insights and recorded progress.
struct OpenStrudelRootView: View {
    @EnvironmentObject private var library: DeviceLibrary
    @Environment(\.scenePhase) private var scenePhase
    @EnvironmentObject private var client: HomeClient
    #if os(macOS)
    /// The toolbar or title bar above this view; the window minimum includes it.
    @State private var titleBarHeight: CGFloat = 0
    #else
    @State private var showSettings = false
    /// The pages opened from «Команда».
    @State private var teamRoutes: [ReaderRoute] = []
    @State private var insightRoutes = NavigationPath()
    @State private var progressRoutes = NavigationPath()
    @StateObject private var activity = ActivityModel()
    @StateObject private var limits = ActivityLimitsModel()
    private var activityScope: String { client.id + ":" + (client.health?.homeId ?? "") + ":" + (client.health?.primaryId ?? "") }
    #endif
    @State private var tab = PrimaryTab.chat
    /// The News feeds: what each has shown, what this device has read, and where its reader is.
    @StateObject private var newsroom = Newsroom()
    /// What this device has read of each employee.
    @StateObject private var marks = TeamReadMarks()
    #if os(macOS)
    /// The employee whose page is open while the sidebar is on one.
    @State private var memberRoute: ReaderRoute?
    @State private var renaming: RenameTarget?
    @State private var moving: EmployeeMoveRequest?
    #endif
    /// The readers opened over the chat, newest last. Back returns to the chat as it was.
    @State private var readers: [ReaderRoute] = []
    @State private var showHistory = false
    @AppStorage("openstrudel.aiConsent.v1") private var aiConsent = false

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
        .onChange(of: client.id) { _, _ in readers.removeAll() }
        #if os(iOS)
        .onChange(of: activityScope) { _, _ in
            insightRoutes = NavigationPath(); progressRoutes = NavigationPath(); activity.clear(); limits.clear()
        }
        .onChange(of: activity.failure) { _, failure in
            if failure == .ownerOnly || failure == .unsupported { insightRoutes = NavigationPath() }
        }
        // These reads belong to entering a place, not another background polling loop.
        .task(id: tab.rawValue + ":" + activityScope) {
            guard client.health != nil, tab == .insights || tab == .progress else { return }
            await refreshActivity(includeLimits: tab == .progress)
        }
        #endif
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
        // Each feed keeps its count and its lead current by itself; a slow Home holds up no other.
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
        // An employee this device meets for the first time starts read.
        .onChange(of: catalogues, initial: true) { _, _ in
            for source in library.teamHomes { marks.meet(source.profiles, on: source) }
        }
        #if os(macOS)
        // An employee that left with its device, or was hidden, gives the sidebar back to the chat. One that published
        // its first story stays chosen as the desk it has become.
        .onChange(of: library.team.map(\.member.id)) { _, rows in
            guard tab == .member, let route = memberRoute, !rows.contains(route.id) else { return }
            if let same = library.team.first(where: { $0.member.route.connectionID == route.connectionID && $0.member.profile.id == route.profileID }) { memberRoute = same.member.route }
            else { tab = .chat }
        }
        .sheet(item: $moving) { EmployeeMoveView(request: $0) }
        .sheet(item: $renaming) { NameEditor(target: $0) }
        #endif
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
                #if os(macOS)
                // An employee has its own place in the sidebar.
                if library.team.contains(where: { $0.member.id == route.id }) { sidebarSelection.wrappedValue = .member(route.id); return }
                #endif
                // A reader opens over the chat, whichever place the list was opened from.
                newsroom.hold()
                tab = .chat
                readers.append(route)
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

    /// Native sidebar sections on the Mac, tabs on iOS; each place owns its detail stack.
    private var places: some View {
        Group {
            #if os(macOS)
            NavigationSplitView {
                List(selection: sidebarSelection) {
                    TeamLeadRow(selected: tab == .chat)
                        .tag(SidebarPlace.tab(.chat)).accessibilityIdentifier("primaryTab-chat")
                    ForEach(library.team(on: library.primary)) { sidebarRow($0, on: library.primary) }
                    // Every other Home folds under its name.
                    ForEach(Array(library.teamHomes.dropFirst())) { source in
                        let members = library.team(on: source)
                        if !members.isEmpty {
                            Section(isExpanded: Binding(get: { !library.collapsedDeviceIDs.contains(source.id) }, set: { library.setCollapsed(!$0, client: source) })) {
                                ForEach(members) { sidebarRow($0, on: source) }
                            } header: {
                                TeamHomeTitle(source: source).accessibilityIdentifier("teamHome-" + source.id)
                            }
                        }
                    }
                    Section {
                        HiddenEmployeesButton()
                        // The numbers stay within reach and out of the team's way.
                        Label(L("Статистика"), systemImage: "chart.bar").foregroundStyle(.secondary)
                            .tag(SidebarPlace.tab(.statistics)).accessibilityIdentifier("primaryTab-statistics")
                    }
                }
                .listStyle(.sidebar)
                .navigationSplitViewColumnWidth(min: 220, ideal: 264, max: 360)
            } detail: {
                switch tab {
                case .chat: chatStack
                case .member: memberStack
                case .statistics: statisticsStack
                }
            }
            // View › the chat, each employee in sight, Statistics: ⌘1, ⌘2… in the sidebar's order.
            .focusedSceneValue(\.places, placeCommands)
            #else
            TabView(selection: $tab) {
                Tab(L("Чат"), systemImage: "bubble.left.and.text.bubble.right", value: PrimaryTab.chat) { chatStack }
                Tab(L("Команда"), systemImage: "person.2", value: PrimaryTab.team) { teamStack }
                Tab(L("Insights"), systemImage: "sparkle", value: PrimaryTab.insights) { insightsStack }
                Tab(L("Progress"), systemImage: "checkmark.circle", value: PrimaryTab.progress) { progressStack }
                Tab(L("Статистика"), systemImage: "chart.bar", value: PrimaryTab.statistics) { statisticsStack }
            }
            .tabViewStyle(.sidebarAdaptable)
            .tabBarMinimizeBehavior(.onScrollDown)
            #endif
        }
        // Edit › Find a chat (⌘F) opens the conversations and their search.
        .focusedSceneValue(\.findChat) { showHistory = true }
        .environmentObject(newsroom)
        .environmentObject(marks)
    }

    #if os(macOS)
    private enum SidebarPlace: Hashable { case tab(PrimaryTab), member(String) }

    private var sidebarSelection: Binding<SidebarPlace?> {
        let current: SidebarPlace? = tab == .member ? memberRoute.map { .member($0.id) } : .tab(tab)
        return Binding(get: { current }, set: { selection in
            guard let selection, selection != current else { return }
            // Leaving a desk for another place closes its pages, not what the reader had open in it.
            newsroom.hold()
            switch selection {
            case .tab(let place): tab = place
            case .member(let id): if let row = library.team.first(where: { $0.member.id == id }) { memberRoute = row.member.route; tab = .member }
            }
        })
    }

    private var placeCommands: [PlaceCommand] {
        let shown = library.team.filter { $0.source === library.primary || !library.collapsedDeviceIDs.contains($0.source.id) }
        let members = shown.map { row in PlaceCommand(id: row.member.id, title: row.member.profile.name) { sidebarSelection.wrappedValue = .member(row.member.id) } }
        return [PlaceCommand(id: "chat", title: L("Чат")) { sidebarSelection.wrappedValue = .tab(.chat) }] + members
            + [PlaceCommand(id: "statistics", title: L("Статистика")) { sidebarSelection.wrappedValue = .tab(.statistics) }]
    }

    private func sidebarRow(_ member: TeamMember, on source: HomeClient) -> some View {
        TeamMemberRow(member: member, source: source, selected: tab == .member && memberRoute?.id == member.id)
            .tag(SidebarPlace.member(member.id))
            .accessibilityIdentifier("teamMember-" + member.profile.id)
            .modifier(TeamMenu(member: member, source: source, renaming: $renaming, moving: $moving))
    }

    /// An employee read in its own place: a desk's reader, or its page. Where the reader was in a desk stays with the
    /// desk, so the chat and back loses nothing.
    @ViewBuilder private var memberStack: some View {
        if let memberRoute {
            NavigationStack { ReaderScreen(route: memberRoute, discuss: discuss) }.id(memberRoute.id)
        }
    }
    #endif

    private var chatStack: some View {
        NavigationStack(path: $readers) {
            chat
                .navigationDestination(for: ReaderRoute.self) { route in
                    ReaderScreen(route: route) { context in
                        library.attach(context)
                        // The reader is closed, not the story that was open in it.
                        newsroom.hold()
                        readers.removeAll()
                    }
                }
        }
        .id(client.id)
    }

    /// Every connected Home's usage; it does not follow the chat's Home.
    private var statisticsStack: some View {
        NavigationStack { StatisticsScreen() }
    }

    #if os(iOS)
    /// The team's pages keep their place while the reader is in another tab.
    private var teamStack: some View {
        NavigationStack(path: $teamRoutes) {
            TeamTab(openChat: { tab = .chat }, open: { teamRoutes.append($0) })
                .navigationDestination(for: ReaderRoute.self) { route in ReaderScreen(route: route, discuss: discuss) }
        }
    }

    private var insightsStack: some View {
        NavigationStack(path: $insightRoutes) {
            InsightsTab(model: activity, scope: activityScope, refresh: { await refreshActivity(includeLimits: false) }, openChat: { tab = .chat })
                .navigationDestination(for: HomeActivity.Insight.self) { item in InsightDetail(item: item, discuss: discuss) }
                .navigationDestination(for: ReaderRoute.self) { route in ReaderScreen(route: route, discuss: discuss) }
        }
        .id(client.id)
    }

    private var progressStack: some View {
        NavigationStack(path: $progressRoutes) {
            ProgressTab(model: activity, limits: limits, scope: activityScope, refresh: { await refreshActivity(includeLimits: true, force: true) }, openChat: { tab = .chat })
                .navigationDestination(for: ReaderRoute.self) { route in ReaderScreen(route: route, discuss: discuss) }
        }
        .id(client.id)
    }

    private func refreshActivity(includeLimits: Bool, force: Bool = false) async {
        let source = client, scope = activityScope
        await activity.load(scope: scope) { try await source.readActivity() }
        guard includeLimits, !Task.isCancelled, scope == activityScope else { return }
        await limits.load(scope: scope) { try await source.management("/v1/accounts?refresh=" + String(force)) }
    }
    #endif

    private func discuss(_ context: ChatContext) {
        library.attach(context)
        // A story stays open in its feed for when the reader comes back.
        newsroom.hold()
        // Back to the one composer, not to a reader left open over it.
        readers.removeAll()
        #if os(iOS)
        insightRoutes = NavigationPath(); progressRoutes = NavigationPath()
        #endif
        tab = .chat
    }

    private var chat: some View {
        // Each device keeps its own draft, files and reading position.
        #if os(macOS)
        ConversationView(openHistory: { showHistory = true })
        #else
        ConversationView(showSettings: $showSettings, openHistory: { showHistory = true })
        #endif
    }
}
