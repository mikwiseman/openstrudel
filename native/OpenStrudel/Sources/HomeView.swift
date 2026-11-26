import SwiftUI

/// Home: what waits for the owner first, then what the team did today, the team itself and one way to write. Beside
/// an open place, on a Mac or an iPad, it is one sidebar. On a phone it is the whole first screen and has two pages
/// under two words, «Сегодня» and «Команда»: what waits and the paper to read, then the employees. A swipe or a word
/// changes the page; a card, a story or a row opens its place.
struct HomeView: View {
    @EnvironmentObject private var library: DeviceLibrary
    @EnvironmentObject private var client: HomeClient
    @EnvironmentObject private var newsroom: Newsroom
    @EnvironmentObject private var marks: TeamReadMarks
    @EnvironmentObject private var arrangement: TeamArrangement
    @EnvironmentObject private var needs: NeedsYouModel
    @EnvironmentObject private var failures: TeamFailures
    @EnvironmentObject private var polls: CheckInHomes
    @ObservedObject var activity: ActivityModel
    @ObservedObject var limits: ActivityLimitsModel
    /// The Home whose activity and limits are shown; older answers for another Home are not.
    let scope: String
    /// The place open beside the home, when the home is a sidebar.
    let selection: HomePlace?
    let split: Bool
    let zoom: Namespace.ID
    /// Opens a place; the second value names what it grows out of.
    let open: (HomePlace, AnyHashable) -> Void
    let openSearch: () -> Void
    let openSettings: () -> Void
    /// Carries out a card's button, with the words it was given when it takes words.
    let act: (NeedCard, NeedCard.Action, String?) -> Void
    @State private var renaming: RenameTarget?
    @State private var moving: EmployeeMoveRequest?
    /// The long-quiet employees are in sight for now.
    @State private var showsQuiet = false
    /// The phone's page in sight.
    @State private var page: HomePage? = .today
    @ScaledMetric(relativeTo: .title2) private var wordmark: CGFloat = HomeMetrics.wordmark
    #if os(iOS)
    @ScaledMetric(relativeTo: .title2) private var word: CGFloat = HomeMetrics.word
    #endif

    private var margin: CGFloat { split ? HomeMetrics.sidebarMargin : HomeMetrics.margin }

    /// Each News desk's paper, in the team's own order: the way into the news, whichever Home the desk lives on.
    private var papers: [NewsPaperShelf.Paper] {
        library.team.filter(\.member.isDesk).map { desk in
            NewsPaperShelf.Paper(route: desk.member.route, name: desk.member.profile.name, appearance: desk.member.profile.resolvedAppearance,
                                 feed: newsroom.feed(desk.member.route, on: desk.source), host: URL(string: desk.source.normalizedBaseURL)?.host)
        }
    }

    private var tiles: [ShelfTile] {
        // The desks stand above the shelf as papers of their own.
        let team = library.team.map { (route: $0.member.route, profile: $0.member.profile) }
        return Shelf.tiles(desks: [], boards: polls.boards(library.pollHomes), next: Shelf.next(team), results: Shelf.results(team))
    }

    private var known: HomeActivity? { activity.scope == scope ? activity.activity : nil }

    /// The results of today on the chat's Home, for the calm sentence.
    private var doneToday: Int {
        (known?.results ?? []).filter { result in HomeActivity.date(result.occurredAt).map { Calendar.current.isDateInToday($0) } ?? false }.count
    }

    var body: some View {
        let cards = needs.cards(library, failures: failures)
        Group {
            #if os(iOS)
            if split { sidebar(cards) } else { pages(cards) }
            #else
            sidebar(cards)
            #endif
        }
        // Nothing is typed here: a keyboard leaving the chat must not carry the dock with it.
        .ignoresSafeArea(.keyboard, edges: .bottom)
        .sheet(item: $moving) { EmployeeMoveView(request: $0) }
        .sheet(item: $renaming) { NameEditor(target: $0) }
    }

    // MARK: Beside an open place

    private func sidebar(_ cards: [NeedCard]) -> some View {
        let tiles = tiles, papers = papers
        return ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                header
                waiting(cards)
                // Then the paper, then what else the team has to show, then the team.
                if !papers.isEmpty {
                    NewsPaperShelf(papers: papers, margin: margin, zoom: zoom) { open(.reader($0), AnyHashable("tile:desk:" + $0.id)) }
                }
                if !tiles.isEmpty {
                    HomeShelf(tiles: tiles, margin: margin, source: { AnyHashable("tile:" + $0.id) }, zoom: zoom) { open($0.place, AnyHashable("tile:" + $0.id)) }
                }
                team(waiting: Set(cards.compactMap { card in card.profileID.map { card.home + ":" + $0 } })).padding(.top, tiles.isEmpty && papers.isEmpty ? 4 : 0)
            }
            .padding(.bottom, 16)
        }
        .scrollIndicators(.hidden)
        // Named before the dock joins it, so the dock's buttons keep their own names.
        .accessibilityIdentifier("homeRoot")
        .safeAreaBar(edge: .bottom, spacing: 0) { dock }
        // The rows end at the search capsule instead of showing through it, and the shelf goes under the window's top
        // edge cleanly.
        #if os(macOS)
        .scrollEdgeEffectStyle(.hard, for: .bottom)
        #else
        .scrollEdgeEffectStyle(.hard, for: .vertical)
        #endif
    }

    /// What waits comes first. A Home out of reach says nothing about it, so nothing is claimed.
    @ViewBuilder private func waiting(_ cards: [NeedCard]) -> some View {
        if !cards.isEmpty || client.health != nil {
            let decided = needs.recent(library)
            HomeNeeds(cards: cards, split: split, margin: margin, last: decided.first, done: doneToday,
                      readable: !decided.isEmpty || !(known?.results ?? []).isEmpty, zoom: zoom,
                      open: { card in needs.focus = card?.id; open(.insights, AnyHashable("needs")) }, act: act)
        }
    }

    // MARK: On a phone

    #if os(iOS)
    /// Two pages side by side under their words. The words stay; the page under them moves with the finger.
    private func pages(_ cards: [NeedCard]) -> some View {
        ScrollView(.horizontal) {
            HStack(spacing: 0) {
                today(cards).containerRelativeFrame(.horizontal).id(HomePage.today)
                people(cards).containerRelativeFrame(.horizontal).id(HomePage.team)
            }
            .scrollTargetLayout()
        }
        .scrollTargetBehavior(.paging)
        .scrollPosition(id: $page)
        .scrollIndicators(.hidden)
        // Named before the bars join it, so their buttons keep their own names.
        .accessibilityIdentifier("homeRoot")
        .safeAreaBar(edge: .top, spacing: 0) { words }
        .safeAreaBar(edge: .bottom, spacing: 0) { dock }
    }

    /// «Сегодня» and «Команда»: the page in sight in ink, the other in the quiet colour of a time. The account's
    /// picture stands beside them and opens the settings.
    private var words: some View {
        HStack(spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: word * 0.6) {
                ForEach(HomePage.allCases) { item in
                    let shown = (page ?? .today) == item
                    Button { withAnimation(.smooth(duration: 0.3)) { page = item } } label: {
                        Text(item.title).font(.system(size: word, weight: .semibold)).tracking(-word * 0.034).lineLimit(1)
                            .foregroundStyle(shown ? AnyShapeStyle(.primary) : AnyShapeStyle(AppTheme.faint))
                            .frame(minHeight: controlTarget).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(shown ? [.isHeader, .isSelected] : [])
                    .accessibilityIdentifier("homePage-" + item.rawValue)
                }
            }
            .minimumScaleFactor(0.7)
            Spacer(minLength: 8)
            account
        }
        .padding(.horizontal, margin)
        .padding(.top, 6).padding(.bottom, 6)
        // The words are the page's title: they grow like a bar's title and never lose their end.
        .dynamicTypeSize(...DynamicTypeSize.accessibility1)
        .sensoryFeedback(.selection, trigger: page)
        .topFade()
    }

    /// What waits for the owner, then the paper of each desk. Nothing else: a page to read from the top.
    private func today(_ cards: [NeedCard]) -> some View {
        let papers = papers, board = polls.boards(library.pollHomes).first { $0.latestDay != nil }
        return ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                TimelineView(.everyMinute) { timeline in
                    Text(HomePage.day(timeline.date)).font(.footnote).foregroundStyle(AppTheme.faint)
                }
                .padding(.horizontal, margin).padding(.bottom, 12)
                .accessibilityIdentifier("homeDay")
                // The chat is a tap away, so what stops every answer is said here too.
                if client.openAIAccount?.connected == false, !client.homeUnreachable, client.health != nil {
                    OpenAIRecoveryNotice().padding(.horizontal, margin).padding(.bottom, 16)
                }
                waiting(cards)
                ForEach(Array(papers.enumerated()), id: \.element.id) { index, paper in
                    TodayPaper(paper: paper, feed: paper.feed, leads: index == 0, zoom: zoom,
                               openDesk: { open(.reader(paper.route), AnyHashable("tile:desk:" + paper.route.id)) },
                               openStory: { story in
                                   // The story opens over today's paper of its desk, where the way back leads.
                                   paper.feed.storyScroll = nil
                                   paper.feed.place = NewsPlace(story: story)
                                   open(.reader(paper.route), AnyHashable("story:" + paper.route.id + ":" + story))
                               })
                        .padding(.horizontal, margin).padding(.bottom, 30)
                }
                if let board {
                    // The answers to a chat's daily polls keep their page; here they are one quiet line.
                    Button { open(.checkIns, AnyHashable(HomePlace.checkIns)) } label: {
                        HStack(spacing: 6) {
                            Text(board.title).lineLimit(1)
                            Image(systemName: "chevron.forward").imageScale(.small)
                        }
                        .font(AppTypography.label).foregroundStyle(AppTheme.secondaryText)
                        .frame(minHeight: controlTarget).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .zoomSource(AnyHashable(HomePlace.checkIns), in: zoom)
                    .padding(.horizontal, margin)
                    .accessibilityIdentifier("homeCheckIns")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            // Clear of the paper that closes under the words, so the day is read at rest.
            .padding(.top, 10).padding(.bottom, 16)
        }
        .scrollIndicators(.hidden)
        .scrollEdgeEffectStyle(.soft, for: .top)
        .accessibilityIdentifier("homeToday")
    }

    /// The chat and every employee, as one list.
    private func people(_ cards: [NeedCard]) -> some View {
        ScrollView {
            team(waiting: Set(cards.compactMap { card in card.profileID.map { card.home + ":" + $0 } }))
                .padding(.top, 4).padding(.bottom, 16)
        }
        .scrollIndicators(.hidden)
        .scrollEdgeEffectStyle(.soft, for: .top)
        .accessibilityIdentifier("homeTeam")
    }
    #endif

    // MARK: Header

    private var header: some View {
        HStack(spacing: 8) {
            AgentAvatar(appearance: nil, size: wordmark * 1.32)
            Text(verbatim: "OpenStrudel").font(.system(size: wordmark, weight: .semibold)).tracking(-wordmark * 0.034).lineLimit(1).minimumScaleFactor(0.7)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 8)
            #if os(iOS)
            account
            #endif
        }
        .padding(.horizontal, margin)
        .padding(.top, split ? 6 : 10).padding(.bottom, split ? 10 : 12)
        // The wordmark is a mark, not reading text: it grows like a bar's title and never loses its end.
        .dynamicTypeSize(...DynamicTypeSize.accessibility1)
    }

    #if os(iOS)
    /// Who is signed in opens the settings, as an account picture does.
    private var account: some View {
        Button(action: openSettings) {
            Group {
                if let initial = client.openAIAccount?.email?.first { Text(String(initial).uppercased()).font(.system(size: 15, weight: .semibold)) }
                else { Image(systemName: "person.fill").font(.system(size: 15, weight: .semibold)) }
            }
            .foregroundStyle(AppTheme.secondaryText)
            .frame(width: 40, height: 40).background(AppTheme.surface, in: Circle())
            .frame(minWidth: controlTarget, minHeight: controlTarget).contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(L("Настройки")).accessibilityIdentifier("openSettings")
    }
    #endif

    // MARK: The team

    /// The chat, then one list across every Home: the pinned employees, then whoever has something waiting, whoever is
    /// working, and the latest answers first. Whoever has said nothing for two weeks waits under one line. Beside an
    /// open place a Home is a quiet word on a row and a filter over the list. On a phone the list is every Home's and
    /// names none: the person reads a team, not its machines.
    private func team(waiting: Set<String>) -> some View {
        let homes = library.teamHomes, several = split && homes.count > 1
        let chosen = split ? library.shownHome(arrangement) : nil
        let waits = { (member: TeamMember) in waiting.contains(member.route.connectionID + ":" + member.profile.id) }
        let list = library.teamList(arrangement, waiting: Set(library.team.map(\.member).filter(waits).map(\.id)), everyHome: !split) { isQuiet($0, on: $1) }
        // On a phone a Home is named only to tell two employees of one name apart.
        let twins = Set(Dictionary(grouping: library.team.map { $0.member.profile.name.lowercased() }, by: { $0 }).filter { $0.value.count > 1 }.keys)
        let named = { (member: TeamMember) in split ? several && chosen == nil : twins.contains(member.profile.name.lowercased()) }
        return VStack(alignment: .leading, spacing: split ? 2 : 0) {
            if several { homeFilter(homes, chosen: chosen) }
            row(.chat, identifier: "teamLead") { TeamLeadRow(selected: selection == .chat) }
            // Another Home's own assistant is listed when that Home alone is in sight.
            if let chosen, chosen !== library.primary {
                let assistant = HomePlace.reader(ReaderRoute(connectionID: chosen.id, kind: .main, title: "OpenStrudel"))
                row(assistant, identifier: "teamAssistant-" + chosen.id) {
                    // Two assistants now stand one under the other; this one says whose it is.
                    TeamRow(content: TeamRowContent(name: "OpenStrudel", appearance: nil, preview: L("Главный помощник"), date: nil,
                                                    state: chosen.isOffline(nil) ? .offline : .resting, home: chosen.displayName), selected: selection == assistant)
                }
            }
            ForEach(list.pinned, id: \.member.id) { member($0.member, on: $0.source, pinned: true, named: named($0.member), waits: waits($0.member)) }
            ForEach(list.live, id: \.member.id) { member($0.member, on: $0.source, named: named($0.member), waits: waits($0.member)) }
            if !list.quiet.isEmpty {
                quietLine(list.quiet.map(\.member))
                if showsQuiet { ForEach(list.quiet, id: \.member.id) { member($0.member, on: $0.source, named: named($0.member)) } }
            }
            footer
        }
        .animation(.smooth(duration: 0.3), value: list.shown.map(\.member.id))
        // A pin taken or given back is felt.
        .sensoryFeedback(.selection, trigger: arrangement.pinned)
    }

    private func member(_ member: TeamMember, on source: HomeClient, pinned: Bool = false, named: Bool = false, waits: Bool = false) -> some View {
        let place = HomePlace.reader(member.route)
        return row(place, identifier: "teamMember-" + member.profile.id) {
            // The Home is a quiet word beside the name, and only where it is not the chat's own.
            TeamMemberRow(member: member, source: source, selected: selection == place, pinned: pinned,
                          home: named && source !== library.primary ? source.displayName : nil, waits: waits)
        }
        .modifier(TeamMenu(member: member, source: source, renaming: $renaming, moving: $moving))
    }

    /// Quiet for two weeks, with nothing unread and not the page that is open.
    private func isQuiet(_ member: TeamMember, on source: HomeClient) -> Bool {
        guard Team.isQuiet(member.profile), selection != .reader(member.route) else { return false }
        return member.isDesk ? newsroom.feed(member.route, on: source).unseen == 0 : !marks.isUnread(member.profile, on: source)
    }

    /// «Все», then each Home by name: one word chooses whose employees are listed. A Home with something new that
    /// the list does not show carries a dot; one out of reach says so beside its name.
    private func homeFilter(_ homes: [HomeClient], chosen: HomeClient?) -> some View {
        ScrollView(.horizontal) {
            HStack(spacing: 0) {
                homeWord(nil, chosen: chosen) { Text(L("Все")) }
                ForEach(homes, id: \.id) { source in
                    homeWord(source, chosen: chosen) {
                        HStack(spacing: 5) {
                            TeamHomeTitle(source: source)
                            if chosen != nil, chosen !== source, hasNew(on: source) {
                                Circle().fill(AppTheme.signal).frame(width: 6, height: 6).transition(.scale.combined(with: .opacity))
                            }
                        }
                    }
                    .contextMenu {
                        Button(L("Переименовать…"), systemImage: "pencil") { renaming = RenameTarget(client: source) }.disabled(!source.canRenameDevice)
                    }
                }
            }
            .padding(.horizontal, margin - 9)
        }
        .scrollIndicators(.hidden)
        .padding(.bottom, 2)
        .accessibilityIdentifier("teamHomes")
    }

    private func homeWord<Label: View>(_ source: HomeClient?, chosen: HomeClient?, @ViewBuilder label: () -> Label) -> some View {
        let on = chosen === source
        return Button { withAnimation(.smooth(duration: 0.25)) { arrangement.show(home: source?.id); showsQuiet = false } } label: {
            label().font(AppTypography.label).foregroundStyle(on ? AnyShapeStyle(.primary) : AnyShapeStyle(AppTheme.secondaryText))
                .padding(.horizontal, 9).frame(minHeight: max(30, controlTarget * 0.8)).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
        .accessibilityIdentifier("teamHome-" + (source?.id ?? "all"))
    }

    /// «Давно молчат» and their faces: a tap brings the rows back for as long as the home is open.
    private func quietLine(_ quiet: [TeamMember]) -> some View {
        Button {
            withAnimation(.smooth(duration: 0.25)) { showsQuiet.toggle() }
        } label: {
            HStack(spacing: 6) {
                Text(L("Давно молчат"))
                Image(systemName: "chevron.forward").imageScale(.small).rotationEffect(.degrees(showsQuiet ? 90 : 0))
                Spacer(minLength: 8)
                if !showsQuiet { TeamFaces(members: quiet).transition(.opacity) }
            }
            .font(AppTypography.label).foregroundStyle(AppTheme.secondaryText)
            .frame(maxWidth: .infinity, minHeight: controlTarget, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, margin).padding(.top, 4)
        .accessibilityValue(showsQuiet ? L("Развёрнуто") : L("Свёрнуто"))
        .accessibilityIdentifier("teamQuiet")
    }

    /// Something on a Home this device has not had on screen.
    private func hasNew(on source: HomeClient) -> Bool {
        library.team(on: source).contains { member in
            member.isDesk ? newsroom.feed(member.route, on: source).unseen > 0 : marks.isUnread(member.profile, on: source)
        }
    }

    /// The list ends with its quiet doors: the numbers, with the fullest limit as a figure, and who is hidden here.
    private var footer: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { open(.statistics, AnyHashable(HomePlace.statistics)) } label: {
                HStack(spacing: 6) {
                    Label(L("Статистика"), systemImage: "chart.bar")
                    if limits.scope == scope, let limit = Shelf.limit(limits.accounts) {
                        Text(verbatim: "· " + (limit.weekly ? L("Лимит недели") : L("Лимит")).lowercased(with: L10n.locale) + " " + limit.used.formatted(.percent.precision(.fractionLength(0))))
                            .monospacedDigit().foregroundStyle(limit.used >= 0.9 ? AppTheme.warning : AppTheme.faint)
                    }
                }
                .foregroundStyle(AppTheme.secondaryText)
                .frame(minHeight: max(32, controlTarget * 0.8)).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .zoomSource(AnyHashable(HomePlace.statistics), in: zoom)
            .accessibilityIdentifier("homeStatistics")
            HiddenEmployeesButton().frame(minHeight: max(32, controlTarget * 0.8))
        }
        .font(RowMetrics.preview)
        .padding(.horizontal, margin).padding(.top, 14)
    }

    /// A row is its own button. Beside an open place it wears a soft plate when it is the one open.
    private func row<Label: View>(_ place: HomePlace, identifier: String, @ViewBuilder label: () -> Label) -> some View {
        Button { open(place, AnyHashable(place)) } label: {
            label()
                .padding(.horizontal, split ? HomeMetrics.plate : margin).padding(.vertical, split ? 8 : 9)
                .background {
                    if split && selection == place { RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color.primary.opacity(0.07)) }
                }
        }
        .buttonStyle(RowPressStyle(plate: !split))
        .zoomSource(AnyHashable(place), in: zoom)
        .padding(.horizontal, split ? margin - HomeMetrics.plate : 0)
        .accessibilityIdentifier(identifier)
        .accessibilityAddTraits(selection == place ? .isSelected : [])
    }

    // MARK: The dock

    /// On a phone: the one composer as a glass capsule, which opens the chat with the keyboard up, and search beside it,
    /// under both pages. Beside an open place the composer is already there, so only search remains.
    @ViewBuilder private var dock: some View {
        if split {
            Button(action: openSearch) {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass")
                    Text(L("Найти"))
                    Spacer(minLength: 0)
                }
                .font(RowMetrics.preview).foregroundStyle(AppTheme.secondaryText)
                .padding(.horizontal, 12).frame(minHeight: max(36, controlTarget))
                .background(Color.primary.opacity(0.06), in: Capsule())
                .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .padding(.horizontal, margin).padding(.vertical, 12)
            .accessibilityLabel(L("Переписки")).accessibilityIdentifier("openChats")
        } else {
            HStack(spacing: 10) {
                Button { open(.chat, AnyHashable("composer")) } label: {
                    HStack(spacing: 12) {
                        Image(systemName: "plus").font(.system(size: 19, weight: .regular)).foregroundStyle(.primary)
                        Text(L("Сообщение")).font(.body).foregroundStyle(AppTheme.secondaryText).lineLimit(1)
                        Spacer(minLength: 0)
                        Image(systemName: "mic").font(.system(size: 18)).foregroundStyle(AppTheme.secondaryText)
                    }
                    .padding(.horizontal, 18).frame(minHeight: 54)
                    .contentShape(Capsule())
                    .dockGlass()
                }
                .buttonStyle(TilePressStyle())
                .zoomSource(AnyHashable("composer"), in: zoom)
                .accessibilityLabel(L("Сообщение")).accessibilityIdentifier("homeComposer")
                Button(action: openSearch) {
                    Image(systemName: "magnifyingglass").font(.system(size: 19, weight: .medium)).foregroundStyle(.primary)
                        .frame(width: 54, height: 54).contentShape(Circle())
                        .dockGlass()
                }
                .buttonStyle(TilePressStyle())
                .accessibilityLabel(L("Переписки")).accessibilityIdentifier("openChats")
            }
            .dynamicTypeSize(...DynamicTypeSize.accessibility1)
            .padding(.horizontal, 18).padding(.top, 10).padding(.bottom, 8)
            .dockFade()
        }
    }
}

/// The pages of the phone's home, in their order.
enum HomePage: String, CaseIterable, Identifiable {
    case today, team
    var id: String { rawValue }
    var title: String { self == .today ? L("Сегодня") : L("Команда") }

    /// «Четверг, 26 ноября»: the day the page is read on, in the interface's language.
    static func day(_ date: Date, locale: Locale = L10n.locale) -> String {
        let text = date.formatted(Date.FormatStyle(locale: locale).weekday(.wide).day().month(.wide))
        return text.prefix(1).uppercased(with: locale) + text.dropFirst()
    }
}

enum HomeMetrics {
    #if os(macOS)
    static let margin: CGFloat = 14
    static let sidebarMargin: CGFloat = 14
    static let wordmark: CGFloat = 19
    #else
    static let margin: CGFloat = 22
    static let sidebarMargin: CGFloat = 16
    static let wordmark: CGFloat = 25
    /// The words over the phone's pages.
    static let word: CGFloat = 27
    #endif
    /// How far a selected row's plate reaches past its content.
    static let plate: CGFloat = 10
}

/// A row answers a press at once and settles with a spring.
private struct RowPressStyle: ButtonStyle {
    let plate: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background { if plate && configuration.isPressed { Color.primary.opacity(0.05) } }
            .scaleEffect(configuration.isPressed && !reduceMotion && !plate ? 0.985 : 1)
            .opacity(configuration.isPressed && !plate ? 0.75 : 1)
            .animation(configuration.isPressed ? .easeOut(duration: 0.08) : .spring(response: 0.35, dampingFraction: 0.8), value: configuration.isPressed)
    }
}
