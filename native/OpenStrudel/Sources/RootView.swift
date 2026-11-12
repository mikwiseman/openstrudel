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
    /// Who is pinned to the top of the team list on this device, and which Homes are open.
    @StateObject private var arrangement = TeamArrangement()
    /// Why a failing employee is failing, from every Home that lets its owner read it.
    @StateObject private var failures = TeamFailures()
    /// What waits for the owner on every Home: the cards the home leads with.
    @StateObject private var needs = NeedsYouModel()
    /// The daily polls of every Home in sight: they may live on a Home other than the chat's.
    @StateObject private var polls = CheckInHomes()
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

    /// Changes when a Home joins or leaves, and when anyone starts or stops failing.
    private var failingKey: String {
        let homes: [String] = library.teamHomes.map(\.id)
        let failing: [String] = library.team.filter { $0.member.profile.failing == true }.map(\.member.id)
        return "\(pollingPhase)-" + homes.joined(separator: ",") + "|" + failing.joined(separator: ",")
    }

    /// Changes when a Home joins or leaves, or the app comes into sight.
    private var homesKey: String {
        let homes: [String] = library.teamHomes.map(\.id)
        return "\(pollingPhase)-" + homes.joined(separator: ",")
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
        // Why someone is failing is asked of every Home when the home comes into sight, and again whenever anyone starts
        // or stops failing; the main assistant's own schedules are asked about every few minutes with the rest.
        .task(id: failingKey) {
            guard pollingPhase == .active else { return }
            while !Task.isCancelled {
                for source in library.teamHomes {
                    do { failures.take(try await source.readScheduleOverview().schedules, from: source) }
                    // A connection that is no longer its owner's forgets what only the owner may read. A Home out of
                    // reach keeps its last word.
                    catch StatisticsReadError.ownerOnly, StatisticsReadError.unsupported { failures.take([], from: source) }
                    catch {}
                }
                do { try await Task.sleep(for: .seconds(300)) } catch { break }
            }
        }
        // What waits is asked of every Home when the home comes into sight and every ten seconds after: a card answered
        // in Telegram leaves here soon, and a new one is not kept waiting.
        .task(id: homesKey) {
            guard pollingPhase == .active else { return }
            while !Task.isCancelled {
                await needs.refresh(library.teamHomes)
                do { try await Task.sleep(for: .seconds(10)) } catch { break }
            }
        }
        // Coming back to the home, or opening one of the pages behind its tiles, reads them again at once.
        .onChange(of: path) { _, pages in
            guard pages.isEmpty || pages.last == .insights || pages.last == .progress || pages.last == .checkIns else { return }
            Task { await refreshActivity(includeLimits: true); await needs.refresh(library.teamHomes) }
        }
        .onChange(of: place) { _, place in
            guard place == .insights || place == .progress || place == .checkIns else { return }
            Task { await refreshActivity(includeLimits: true); await needs.refresh(library.teamHomes) }
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
        .environmentObject(arrangement)
        .environmentObject(failures)
        .environmentObject(needs)
        .environmentObject(polls)
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
                 },
                 act: act)
    }

    /// Carries out a card's button. A card its Home keeps is answered by the Home. What an older Home can only tell
    /// is answered here: a failing employee's page is opened or the card set aside until tomorrow, and a question is
    /// answered with the choice or in its chat.
    private func act(_ card: NeedCard, _ action: NeedCard.Action, _ text: String?) {
        guard let source = library.home(of: card) else { return }
        switch card.origin {
        case .card:
            Task { await needs.press(action, on: card, text: text, home: source) }
        case .failing(let route):
            if action.id == NeedsYou.later { withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) { needs.setAside(card) } }
            else { open(.reader(route)) }
        case .question(let interaction):
            if action.id.hasPrefix(NeedsYou.option), let question = interaction.questions.first {
                let choice = String(action.id.dropFirst(NeedsYou.option.count))
                Task { await needs.run(card) { try await source.answer(interaction, answers: [question.id: choice]) } }
            } else {
                open(source === library.primary ? .chat : .reader(ReaderRoute(connectionID: source.id, kind: .main, title: "OpenStrudel")))
            }
        }
    }

    @ViewBuilder private func page(_ place: HomePlace) -> some View {
        switch place {
        case .chat: chat
        case .reader(let route): ReaderScreen(route: route, discuss: discuss)
        case .insights:
            InsightsPage(model: activity, scope: activityScope, refresh: { await refreshActivity(includeLimits: false); await needs.refresh(library.teamHomes) },
                         openChat: { open(.chat) }, act: act)
        case .insight(let item): InsightDetail(item: item, discuss: discuss)
        case .checkIns:
            CheckInsPage(refresh: { await refreshActivity(includeLimits: false) })
        case .progress:
            ProgressPage(model: activity, limits: limits, scope: activityScope, refresh: { await refreshActivity(includeLimits: true, force: true) }, openChat: { open(.chat) })
        case .statistics: StatisticsScreen(limit: limits.scope == activityScope ? Shelf.limit(limits.accounts) : nil)
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
        // The home's own order: the pinned first, then the list as it stands, without the long-quiet.
        let cards = needs.cards(library, failures: failures)
        let waiting = Set(cards.compactMap { card in card.profileID.map { card.home + ":" + $0 } })
        let waits = Set(library.team.map(\.member).filter { waiting.contains($0.route.connectionID + ":" + $0.profile.id) }.map(\.id))
        let list = library.teamList(arrangement, waiting: waits) { member, _ in Team.isQuiet(member.profile) }
        let members = list.shown.map(\.member).map { member in PlaceCommand(id: member.id, title: member.profile.name) { open(.reader(member.route)) } }
        // Every page has its line in View too: what waits, what the Home has to show, then the numbers.
        let known = activity.scope == activityScope ? activity.activity : nil
        var pages: [PlaceCommand] = [PlaceCommand(id: "insights", title: L("Ждёт вас"), page: true) { open(.insights) }]
        if let board = polls.boards(library.pollHomes).first {
            pages.append(PlaceCommand(id: "checkIns", title: board.title, page: true) { open(.checkIns) })
        }
        if known != nil { pages.append(PlaceCommand(id: "progress", title: L("Progress"), page: true) { open(.progress) }) }
        pages.append(PlaceCommand(id: "statistics", title: L("Статистика"), page: true) { open(.statistics) })
        return [PlaceCommand(id: "chat", title: L("Чат")) { open(.chat) }] + members + pages
    }
    #endif

    private func refreshActivity(includeLimits: Bool, force: Bool = false) async {
        let source = client, scope = activityScope
        await activity.load(scope: scope) { try await source.readActivity() }
        // The polls may live on any Home: the chat's own was just read, the others are read after it.
        if activity.scope == scope, activity.failure != .unavailable { polls.take(activity.activity, from: source.id) }
        if includeLimits, !Task.isCancelled, scope == activityScope {
            await limits.load(scope: scope) { try await source.management("/v1/accounts?refresh=" + String(force)) }
        }
        await polls.refresh(library.teamHomes.filter { $0 !== source })
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
