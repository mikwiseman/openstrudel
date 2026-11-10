import SwiftUI

enum PrimaryTab: String, CaseIterable {
    case chat, statistics
    #if os(iOS)
    case insights, progress
    #else
    /// A News feed chosen in the sidebar.
    case news
    #endif
}

/// One chat owns the composer. Statistics reads every connected Home; the Mac lists each News feed beside them, and mobile
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
    @State private var insightRoutes = NavigationPath()
    @State private var progressRoutes = NavigationPath()
    @StateObject private var activity = ActivityModel()
    @StateObject private var limits = ActivityLimitsModel()
    private var activityScope: String { client.id + ":" + (client.health?.homeId ?? "") + ":" + (client.health?.primaryId ?? "") }
    #endif
    @State private var tab = PrimaryTab.chat
    /// The News feeds: what each has shown, what this device has read, and where its reader is.
    @StateObject private var newsroom = Newsroom()
    #if os(macOS)
    /// The feed open while the sidebar is on News.
    @State private var newsRoute: ReaderRoute?
    #endif
    /// The readers opened over the chat, newest last. Back returns to the chat as it was.
    @State private var readers: [ReaderRoute] = []
    @State private var showHistory = false
    @AppStorage("openstrudel.aiConsent.v1") private var aiConsent = false

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
        #if os(macOS)
        // A feed that left with its employee or its device gives the sidebar back to the chat.
        .onChange(of: library.newsFeeds.map(\.route.id)) { _, feeds in
            if tab == .news, !feeds.contains(newsRoute?.id ?? "") { tab = .chat }
        }
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
                // A feed has its own place in the sidebar.
                if case .news = route.kind { newsRoute = route; tab = .news; return }
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
                    Label(L("Чат"), systemImage: "bubble.left.and.text.bubble.right")
                        .tag(SidebarPlace.tab(.chat)).accessibilityIdentifier("primaryTab-chat")
                    // A Home with News has it one click away, with how much of today is unread.
                    ForEach(library.newsFeeds, id: \.route.id) { feed in
                        NewsSidebarRow(feed: newsroom.feed(feed.route, on: feed.source))
                            .tag(SidebarPlace.news(feed.route.id)).accessibilityIdentifier("primaryTab-news-" + (feed.route.profileID ?? ""))
                    }
                    Label(L("Статистика"), systemImage: "chart.bar")
                        .tag(SidebarPlace.tab(.statistics)).accessibilityIdentifier("primaryTab-statistics")
                }
                .listStyle(.sidebar)
                .navigationSplitViewColumnWidth(min: 180, ideal: 220)
            } detail: {
                switch tab {
                case .chat: chatStack
                case .news: newsStack
                case .statistics: statisticsStack
                }
            }
            // View › Chat, News, Statistics: ⌘1, ⌘2… in the sidebar's order.
            .focusedSceneValue(\.places, [PlaceCommand(id: "chat", title: L("Чат")) { sidebarSelection.wrappedValue = .tab(.chat) }]
                + library.newsFeeds.map { feed in PlaceCommand(id: feed.route.id, title: feed.route.title) { sidebarSelection.wrappedValue = .news(feed.route.id) } }
                + [PlaceCommand(id: "statistics", title: L("Статистика")) { sidebarSelection.wrappedValue = .tab(.statistics) }])
            #else
            TabView(selection: $tab) {
                Tab(L("Чат"), systemImage: "bubble.left.and.text.bubble.right", value: PrimaryTab.chat) { chatStack }
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
    }

    #if os(macOS)
    private enum SidebarPlace: Hashable { case tab(PrimaryTab), news(String) }

    private var sidebarSelection: Binding<SidebarPlace?> {
        let current: SidebarPlace? = tab == .news ? newsRoute.map { .news($0.id) } : .tab(tab)
        return Binding(get: { current }, set: { selection in
            guard let selection, selection != current else { return }
            // Leaving a feed for another place closes its pages, not what the reader had open in it.
            newsroom.hold()
            switch selection {
            case .tab(let place): tab = place
            case .news(let id): if let feed = library.newsFeeds.first(where: { $0.route.id == id }) { newsRoute = feed.route; tab = .news }
            }
        })
    }

    /// A feed read in its own place. Where the reader was in it stays with the feed, so the chat and back loses nothing.
    @ViewBuilder private var newsStack: some View {
        if let newsRoute {
            NavigationStack { ReaderScreen(route: newsRoute, discuss: discuss) }.id(newsRoute.id)
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
