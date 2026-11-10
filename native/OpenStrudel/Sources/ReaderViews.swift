import SwiftUI

extension EnvironmentValues {
    /// The messages of a reader, for the lines a bubble draws from its neighbours. Nil in the chat itself.
    @Entry var readerMessages: [HomeMessage]? = nil
}

/// A place of the Mac sidebar, as the View menu lists it: ⌘1, ⌘2… in the sidebar's order.
struct PlaceCommand: Identifiable {
    let id: String
    let title: String
    let open: () -> Void
}

extension FocusedValues {
    @Entry var places: [PlaceCommand]?
    /// Edit › Find a chat (⌘F): the chat opens its conversations and their search.
    @Entry var findChat: (() -> Void)?
}

/// One conversation read over the chat: an employee's feed or its News, another Home's assistant, a Telegram chat or an
/// archive. There is nothing to type into here. "Обсудить в чате" takes a message or a story back to the one composer as context.
struct ReaderScreen: View {
    @EnvironmentObject private var library: DeviceLibrary
    @EnvironmentObject private var newsroom: Newsroom
    let route: ReaderRoute
    let discuss: (ChatContext) -> Void

    var body: some View {
        if let client = library.clients.first(where: { $0.id == route.connectionID && !$0.isSignedOut }) {
            Group {
                if case .news = route.kind { NewsScreen(feed: newsroom.feed(route, on: client), discuss: discuss) }
                else { ReaderView(reader: ConversationReader(client: client, route: route), discuss: discuss) }
            }
            .environmentObject(client)
        } else {
            ContentUnavailableView(L("Подключение не найдено"), systemImage: "wifi.slash",
                                   description: Text(L("Это устройство больше не подключено. Переписка осталась на нём.")))
        }
    }
}

private struct ReaderView: View {
    @EnvironmentObject private var library: DeviceLibrary
    @EnvironmentObject private var client: HomeClient
    @EnvironmentObject private var marks: TeamReadMarks
    @StateObject private var reader: ConversationReader
    let discuss: (ChatContext) -> Void
    @State private var details: EmployeeProfile?
    @State private var unavailable: String?
    @State private var onScreen = false
    #if os(macOS)
    @Environment(\.appearsActive) private var appearsActive
    #else
    @Environment(\.scenePhase) private var scenePhase
    #endif

    init(reader: ConversationReader, discuss: @escaping (ChatContext) -> Void) {
        _reader = StateObject(wrappedValue: reader)
        self.discuss = discuss
    }

    private var profile: EmployeeProfile? {
        if case .employee(let id) = reader.route.kind { return client.profiles.first { $0.id == id } }
        return nil
    }
    /// The employee's name as it is now, also after a rename while its page is open.
    private var title: String { profile?.name ?? reader.title }
    /// The employee's latest words: what the toolbar's «Обсудить в чате» takes to the chat.
    private var latest: HomeMessage? {
        reader.messages.last { $0.direction == "outbound" && $0.kind != "notice" && $0.story == nil && !$0.text.isEmpty && !MessagePages.isOwnerReply($0) }
    }
    private var windowIsActive: Bool {
        #if os(macOS)
        appearsActive
        #else
        scenePhase == .active
        #endif
    }
    /// What the Home says wins; a Home that does not say is read from the runs themselves.
    private var failure: (since: Date?, reason: String?)? {
        guard let profile, !client.isOffline(profile) else { return nil }
        let found = Team.failure(reader.runs, schedules: reader.schedules)
        guard profile.failing ?? (found != nil) else { return nil }
        return (found?.since, found?.reason)
    }

    var body: some View {
        ReaderTranscript(reader: reader, profile: profile, offline: client.isOffline(profile), showDetails: { details = profile }) { message in
            quote { home in .message(message, title: title, home: home) }
        }
        .safeAreaBar(edge: .top, spacing: 0) { topBar }
        .navigationTitle(title)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItem(placement: .principal) {
                Button { if let profile { details = profile } } label: {
                    HStack(spacing: 8) {
                        if let profile { AgentAvatar(appearance: profile.resolvedAppearance, size: AvatarSize.toolbar).offlineCharacter(client.isOffline(profile)) }
                        else if case .main = reader.route.kind { AgentAvatar(appearance: nil, size: AvatarSize.toolbar).offlineCharacter(client.isOffline(nil)) }
                        Text(title).font(.body.weight(.semibold)).lineLimit(1)
                    }
                    .frame(maxWidth: 240)
                    #if os(iOS)
                    .frame(minHeight: controlTarget).contentShape(Rectangle())
                    #endif
                }
                .buttonStyle(.plain)
                .disabled(profile == nil)
                .accessibilityLabel(profile == nil ? reader.title : L("Настройки сотрудника"))
                .accessibilityValue(title)
                .accessibilityIdentifier("readerTitle")
            }
            if profile != nil {
                // The page's one way to the composer: the employee's latest words go to the chat as context.
                ToolbarItem(placement: .primaryAction) {
                    Button { if let latest { quote { home in .message(latest, title: title, home: home) } } } label: {
                        Label(L("Обсудить в чате"), systemImage: "text.quote")
                    }
                    #if os(macOS)
                    .labelStyle(.titleAndIcon)
                    #endif
                    .disabled(latest == nil)
                    .help(L("Взять последнее сообщение в чат"))
                    .accessibilityIdentifier("discussLatest")
                }
            }
        }
        .environment(\.readerMessages, reader.messages)
        .task { await reader.follow() }
        // The rhythm is read when the page opens, when a run starts or ends, and when the details close.
        .task(id: [reader.conversationID ?? "", profile?.nextRunAt ?? "", String(profile?.working == true), String(profile?.failing == true), String(details == nil)].joined(separator: "|")) {
            await reader.loadRhythm()
        }
        .onAppear { onScreen = true }
        .onDisappear { onScreen = false }
        // What is on screen in the active window has been read.
        .onChange(of: [profile?.previewAt ?? "", String(onScreen && windowIsActive)], initial: true) { _, _ in
            if onScreen, windowIsActive, let profile { marks.see(profile, on: client) }
        }
        .sheet(item: $details) { profile in BotDetailsView(profile: profile, conversationID: reader.conversationID).environmentObject(client) }
        .alert(L("Нет связи"), isPresented: Binding(get: { unavailable != nil }, set: { if !$0 { unavailable = nil } })) {
            Button(L("Понятно"), role: .cancel) {}
        } message: { Text(unavailable ?? "") }
        .accessibilityIdentifier("reader")
    }

    /// A quote carries where it came from. Without a verified Home there is no truthful origin, so nothing is attached.
    private func quote(_ make: (ChatContext.Home?) -> ChatContext) {
        guard let home = client.quoteHome(for: reader.route, primary: library.primary) else {
            unavailable = L("«\(client.displayName)» не на связи. Цитату можно передать, когда устройство подключится.")
            return
        }
        discuss(make(home))
    }

    /// What the reader must know wherever the page is scrolled: the device is out of reach, or the employee's runs fail.
    @ViewBuilder private var topBar: some View {
        let offline = client.homeUnreachable || client.connectionNeedsPairing
        if offline || reader.error != nil || failure != nil {
            VStack(alignment: .leading, spacing: 8) {
                if offline || reader.error != nil {
                    Label(offline ? L("«\(client.displayName)» не на связи. Показано, что уже прочитано.") : (reader.error ?? ""), systemImage: "wifi.slash")
                        .foregroundStyle(AppTheme.secondaryText)
                        .accessibilityIdentifier("readerUnavailable")
                }
                if let failure {
                    // Since when it has not worked, and why. The way to its schedules is one click away.
                    Button { details = profile } label: {
                        TimelineView(.everyMinute) { timeline in
                            Label(TeamWords().failure(since: failure.since, reason: failure.reason, now: timeline.date), systemImage: "exclamationmark.triangle")
                                .multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                        }
                        .frame(minHeight: controlTarget).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(AppTheme.warning)
                    .accessibilityIdentifier("readerFailing")
                }
            }
            .font(AppTypography.meta)
            // Each line keeps its own name for assistive tools and tests, under the reader's.
            .accessibilityElement(children: .contain)
            .frame(maxWidth: Layout.column, alignment: .leading)
            .padding(.horizontal, Layout.edge)
            .padding(.top, offline || reader.error != nil ? 16 : 8)
            .padding(.bottom, failure == nil ? 8 : 0)
            .frame(maxWidth: .infinity)
        }
    }
}

/// The top of an employee's page: who it is, what it is for and when it works. The rhythm line opens its details,
/// where a schedule can be paused.
private struct EmployeePageHeader: View {
    let profile: EmployeeProfile
    let offline: Bool
    let schedules: [ChatSchedule]
    let showDetails: () -> Void
    @State private var hovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            WorkingCharacter(appearance: profile.resolvedAppearance, size: AvatarSize.header, working: profile.working == true && !offline, offline: offline)
            Text(profile.name).font(AppTypography.display).fixedSize(horizontal: false, vertical: true)
                .padding(.top, 16).accessibilityAddTraits(.isHeader)
            if !profile.roleText.isEmpty {
                Text(profile.roleText).font(AppTypography.reading).lineSpacing(AppTypography.readingLineSpacing)
                    .foregroundStyle(AppTheme.secondaryText).fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 4).accessibilityIdentifier("employeeRole")
            }
            // "Tomorrow" becomes "today" by itself.
            TimelineView(.everyMinute) { timeline in
                if let rhythm = TeamWords().rhythm(schedules, now: timeline.date) {
                    Button(action: showDetails) {
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Image(systemName: "clock").accessibilityHidden(true)
                            Text(rhythm).monospacedDigit().multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                            Image(systemName: "chevron.forward").imageScale(.small).opacity(hovering ? 1 : 0.5).accessibilityHidden(true)
                        }
                        .font(AppTypography.meta)
                        .foregroundStyle(hovering ? AnyShapeStyle(.primary) : AnyShapeStyle(AppTheme.secondaryText))
                        .frame(minHeight: controlTarget).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .onHover { hovering = $0 }
                    .animation(.easeInOut(duration: 0.15), value: hovering)
                    .padding(.top, 8)
                    .accessibilityHint(L("Открыть расписание"))
                    .accessibilityIdentifier("employeeRhythm")
                    .transition(.opacity)
                }
            }
            .animation(.smooth(duration: 0.25), value: schedules.map(\.id))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("employeeHeader")
    }
}

/// The transcript of a reader: the same bubbles as the chat, read-only. An employee's page opens with who it is.
/// Each message can be discussed in the chat.
private struct ReaderTranscript: View {
    @ObservedObject var reader: ConversationReader
    /// The employee whose page this is; nil for a Telegram chat, an archive or another Home's assistant.
    let profile: EmployeeProfile?
    let offline: Bool
    let showDetails: () -> Void
    let discuss: (HomeMessage) -> Void
    @State private var columnWidth: CGFloat = Layout.column
    /// Stories live in the News reader; the employee's history keeps the conversation, as the chat does.
    private var messages: [HomeMessage] { reader.messages.filter { $0.story == nil } }

    var body: some View {
        ScrollView {
            // Nothing is drawn before the first page arrives, so the page opens at its latest message.
            if reader.loaded || !messages.isEmpty {
                if let profile {
                    VStack(alignment: .leading, spacing: 0) {
                        EmployeePageHeader(profile: profile, offline: offline, schedules: reader.schedules, showDetails: showDetails)
                            .padding(.bottom, 48)
                        if messages.isEmpty {
                            Text(L("Пока тихо. Первый результат появится здесь.")).font(AppTypography.reading).lineSpacing(AppTypography.readingLineSpacing)
                                .foregroundStyle(AppTheme.secondaryText).fixedSize(horizontal: false, vertical: true)
                                .accessibilityIdentifier("readerEmpty")
                        } else { rows }
                    }
                    .modifier(ReaderColumn())
                } else if messages.isEmpty {
                    VStack(spacing: 8) {
                        Text(L("Пока пусто")).font(AppTypography.display)
                        Text(L("Сообщения этой переписки появятся здесь.")).font(AppTypography.interface).foregroundStyle(AppTheme.secondaryText)
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: 360).padding(.horizontal, 24)
                    .frame(maxWidth: .infinity, minHeight: 430)
                    .accessibilityIdentifier("readerEmpty")
                } else {
                    rows.modifier(ReaderColumn())
                }
            }
        }
        .scrollIndicators(.hidden)
        #if os(macOS)
        .scrollEdgeEffectStyle(.hard, for: .top)
        #endif
        .defaultScrollAnchor(.bottom, for: .initialOffset)
        .accessibilityIdentifier("readerTranscript")
    }

    private var rows: some View {
        let rows = MessagePages.rows(messages)
        // One Telegram chat or an archive shows who wrote; an employee's feed reads like a one-to-one conversation.
        let shared = !reader.route.usesTimeline || MessagePages.isMultiAuthor(messages)
        let bubbleWidth = (columnWidth * 0.75).rounded()
        return LazyVStack(alignment: .leading, spacing: 0) {
            if reader.hasEarlierMessages {
                Button {
                    Task { await reader.loadEarlier() }
                } label: {
                    HStack(spacing: 8) {
                        if reader.isLoadingEarlier { ProgressView().controlSize(.mini) }
                        Text(reader.isLoadingEarlier ? L("Загружаем историю…") : L("Показать более ранние сообщения"))
                    }
                    .font(AppTypography.meta).foregroundStyle(AppTheme.secondaryText)
                    .frame(minHeight: controlTarget).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(reader.isLoadingEarlier)
                .frame(maxWidth: .infinity)
            }
            ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                VStack(alignment: .leading, spacing: 16) {
                    if let header = row.header { ClusterHeader(date: header, hasTime: row.message.hasTime) }
                    MessageBubble(message: row.message, shared: shared || row.message.origin?.channel == "telegram" || row.message.origin?.channel == "archive",
                                  bubbleWidth: bubbleWidth, previous: row.previous, headed: row.header != nil)
                        #if os(macOS)
                        .help(row.message.sentAt.map { ChatClock.exact($0, hasTime: row.message.hasTime) } ?? "")
                        #endif
                }
                .padding(.top, index == 0 ? 0 : row.header != nil ? 48 : row.startsTurn ? 32 : 12)
                .id(row.id)
                .contentShape(Rectangle())
                // The one action a reader offers: take this message to the chat as quoted context.
                .contextMenu { Button(L("Обсудить в чате"), systemImage: "text.quote") { discuss(row.message) } }
                .accessibilityElement(children: .contain)
                .accessibilityAction(named: Text(L("Обсудить в чате"))) { discuss(row.message) }
                .accessibilityIdentifier("readerMessage-" + row.message.id)
            }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { columnWidth = $0 }
    }
}

/// The reading column: the chat's width, centred, with the chat's margins.
private struct ReaderColumn: ViewModifier {
    func body(content: Content) -> some View {
        content
            .frame(maxWidth: Layout.column, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.horizontal, Layout.edge)
            .padding(.top, Layout.belowToolbar)
            .padding(.bottom, 48)
    }
}
