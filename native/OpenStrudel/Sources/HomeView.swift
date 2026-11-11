import SwiftUI

/// Home: what the team did today, the team itself and one way to write. It is the whole first screen on a phone and
/// the sidebar beside the open place on a Mac or an iPad. Nothing here is a tab: a tile or a row opens its page.
struct HomeView: View {
    @EnvironmentObject private var library: DeviceLibrary
    @EnvironmentObject private var client: HomeClient
    @EnvironmentObject private var newsroom: Newsroom
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
    @State private var renaming: RenameTarget?
    @State private var moving: EmployeeMoveRequest?
    @ScaledMetric(relativeTo: .title2) private var wordmark: CGFloat = HomeMetrics.wordmark

    private var margin: CGFloat { split ? HomeMetrics.sidebarMargin : HomeMetrics.margin }

    private var tiles: [ShelfTile] {
        // The desks in the team's own order, so a tile and its row never disagree about who comes first.
        let desks = library.team.filter(\.member.isDesk).map { desk -> Shelf.Desk in
            let feed = newsroom.feed(desk.member.route, on: desk.source)
            let page = feed.latest.page(read: feed.read)
            return Shelf.Desk(route: desk.member.route, name: desk.member.profile.name, appearance: desk.member.profile.resolvedAppearance,
                              story: (page.edition.first ?? page.fresh.first?.item ?? page.radar.first?.item)?.story,
                              host: URL(string: desk.source.normalizedBaseURL)?.host, unseen: feed.unseen)
        }
        let team = library.team.map { (route: $0.member.route, profile: $0.member.profile) }
        return Shelf.tiles(desks: desks, activity: activity.scope == scope ? activity.activity : nil, next: Shelf.next(team),
                           accounts: limits.scope == scope ? limits.accounts : [], results: Shelf.results(team))
    }

    var body: some View {
        let tiles = tiles
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                header
                // On a phone the chat is a tap away, so what stops every answer is said here too.
                if !split, client.openAIAccount?.connected == false, !client.homeUnreachable, client.health != nil {
                    OpenAIRecoveryNotice().padding(.horizontal, margin).padding(.bottom, 16)
                }
                if !tiles.isEmpty {
                    HomeShelf(tiles: tiles, margin: margin, source: { AnyHashable("tile:" + $0.id) }, zoom: zoom) { open($0.place, AnyHashable("tile:" + $0.id)) }
                }
                team.padding(.top, tiles.isEmpty ? 8 : 0)
            }
            .padding(.bottom, 16)
        }
        .scrollIndicators(.hidden)
        // Named before the dock joins it, so the dock's buttons keep their own names.
        .accessibilityIdentifier("homeRoot")
        .safeAreaBar(edge: .bottom, spacing: 0) { dock }
        // Beside an open place the rows end at the search capsule instead of showing through it, and the shelf goes
        // under the window's top edge cleanly. On a phone the home closes into the paper at the top like every page.
        #if os(macOS)
        .scrollEdgeEffectStyle(.hard, for: .bottom)
        #else
        .modifier(HomeEdges(split: split))
        #endif
        // Nothing is typed here: a keyboard leaving the chat must not carry the dock with it.
        .ignoresSafeArea(.keyboard, edges: .bottom)
        .sheet(item: $moving) { EmployeeMoveView(request: $0) }
        .sheet(item: $renaming) { NameEditor(target: $0) }
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: 8) {
            AgentAvatar(appearance: nil, size: wordmark * 1.32)
            Text(verbatim: "OpenStrudel").font(.system(size: wordmark, weight: .semibold)).tracking(-wordmark * 0.034).lineLimit(1).minimumScaleFactor(0.7)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 8)
            #if os(iOS)
            // Who is signed in opens the settings, as an account picture does.
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
            #endif
        }
        .padding(.horizontal, margin)
        .padding(.top, split ? 6 : 10).padding(.bottom, split ? 10 : 12)
        // The wordmark is a mark, not reading text: it grows like a bar's title and never loses its end.
        .dynamicTypeSize(...DynamicTypeSize.accessibility1)
    }

    // MARK: The team

    private var team: some View {
        VStack(alignment: .leading, spacing: split ? 2 : 0) {
            row(.chat, identifier: "teamLead") { TeamLeadRow(selected: selection == .chat) }
            ForEach(library.team(on: library.primary)) { member($0, on: library.primary) }
            // Every other Home folds under its name, with its own assistant first.
            ForEach(Array(library.teamHomes.dropFirst())) { source in
                homeHeader(source)
                if !library.collapsedDeviceIDs.contains(source.id) {
                    let assistant = HomePlace.reader(ReaderRoute(connectionID: source.id, kind: .main, title: "OpenStrudel"))
                    row(assistant, identifier: "teamAssistant-" + source.id) {
                        TeamRow(content: TeamRowContent(name: "OpenStrudel", appearance: nil, preview: L("Главный помощник"), date: nil,
                                                        state: source.isOffline(nil) ? .offline : .resting), selected: selection == assistant)
                    }
                    ForEach(library.team(on: source)) { member($0, on: source) }
                }
            }
            HiddenEmployeesButton().font(RowMetrics.preview).padding(.horizontal, margin).padding(.top, 16)
        }
    }

    private func member(_ member: TeamMember, on source: HomeClient) -> some View {
        let place = HomePlace.reader(member.route)
        return row(place, identifier: "teamMember-" + member.profile.id) { TeamMemberRow(member: member, source: source, selected: selection == place) }
            .modifier(TeamMenu(member: member, source: source, renaming: $renaming, moving: $moving))
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

    private func homeHeader(_ source: HomeClient) -> some View {
        let collapsed = library.collapsedDeviceIDs.contains(source.id)
        return Button { withAnimation(.smooth(duration: 0.25)) { library.setCollapsed(!collapsed, client: source) } } label: {
            HStack(spacing: 6) {
                TeamHomeTitle(source: source)
                Image(systemName: "chevron.forward").imageScale(.small).rotationEffect(.degrees(collapsed ? 0 : 90))
                Spacer(minLength: 0)
            }
            .font(AppTypography.label).foregroundStyle(AppTheme.secondaryText)
            .frame(maxWidth: .infinity, minHeight: controlTarget, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, margin).padding(.top, 18)
        .accessibilityValue(collapsed ? L("Свёрнуто") : L("Развёрнуто"))
        .accessibilityIdentifier("teamHome-" + source.id)
        .contextMenu {
            Button(L("Переименовать…"), systemImage: "pencil") { renaming = RenameTarget(client: source) }.disabled(!source.canRenameDevice)
        }
    }

    // MARK: The dock

    /// On a phone: the one composer as a glass capsule, which opens the chat with the keyboard up, and search beside it.
    /// Beside an open place the composer is already there, so only search remains.
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

enum HomeMetrics {
    #if os(macOS)
    static let margin: CGFloat = 14
    static let sidebarMargin: CGFloat = 14
    static let wordmark: CGFloat = 19
    #else
    static let margin: CGFloat = 22
    static let sidebarMargin: CGFloat = 16
    static let wordmark: CGFloat = 25
    #endif
    /// How far a selected row's plate reaches past its content.
    static let plate: CGFloat = 10
}

#if os(iOS)
/// The home's scroll edges: hard beside an open place; on a phone the paper closes over what scrolls up under the
/// clock, which also leaves no rule there when the reader has asked for less transparency.
private struct HomeEdges: ViewModifier {
    let split: Bool
    func body(content: Content) -> some View {
        if split { content.scrollEdgeEffectStyle(.hard, for: .vertical) } else { content.paperTop() }
    }
}
#endif

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
