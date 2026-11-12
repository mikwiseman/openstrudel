import SwiftUI

extension EnvironmentValues {
    /// The messages of a reader, for the lines a bubble draws from its neighbours. Nil in the chat itself.
    @Entry var readerMessages: [HomeMessage]? = nil
    /// An employee's page reads as a feed of its results: what it was asked is one quiet line, not a bubble.
    @Entry var readerFeed = false
}

/// A place of the Mac sidebar, as the View menu lists it: ⌘1, ⌘2… in the sidebar's order.
struct PlaceCommand: Identifiable {
    let id: String
    let title: String
    /// A page of the home (what waits, the polls, Progress, Statistics) rather than a row of the team list.
    var page = false
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
    @Environment(\.dynamicTypeSize) private var typeSize
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
    private var isAssistant: Bool { if case .main = reader.route.kind { true } else { false } }
    /// The employee's name as it is now, also after a rename while its page is open.
    private var title: String { profile?.name ?? reader.title }
    /// The employee's latest words: what «Спросить про…» takes to the chat.
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
        ReaderTranscript(reader: reader, profile: profile, offline: client.isOffline(profile)) { message in
            quote { home in .message(message, title: title, home: home) }
        }
        // Named before the bars join it, so their lines and the capsule keep their own names.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("reader")
        .safeAreaBar(edge: .top, spacing: 0) { VStack(spacing: 0) { topBar }.frame(maxWidth: .infinity).topFade() }
        .scrollEdgeEffectStyle(.soft, for: .top)
        .safeAreaBar(edge: .bottom, spacing: 0) {
            // The page's one way to the composer: the employee's latest words go to the chat as context.
            if profile != nil, let latest {
                AskCapsule(title: L("Спросить про \(title)")) { quote { home in .message(latest, title: title, home: home) } }
                    .accessibilityIdentifier("discussLatest")
            }
        }
        .navigationTitle(title)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        .containerBackground(AppTheme.canvas, for: .navigation)
        #endif
        .toolbar {
            ToolbarItem(placement: .principal) {
                TitleCapsule(appearance: profile?.resolvedAppearance, showsCharacter: profile != nil || isAssistant, name: title,
                             offline: client.isOffline(profile), action: profile == nil ? nil : { details = profile })
                    .accessibilityLabel(profile == nil ? reader.title : L("Настройки сотрудника"))
                    .accessibilityValue(title)
                    .accessibilityIdentifier("readerTitle")
            }
            if let profile {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button(L("Настройки сотрудника"), systemImage: "slider.horizontal.3") { details = profile }
                        Button(L("Обсудить в чате"), systemImage: "text.quote") { if let latest { quote { home in .message(latest, title: title, home: home) } } }
                            .disabled(latest == nil)
                    } label: { Image(systemName: "ellipsis") }
                    .menuIndicator(.hidden)
                    .accessibilityLabel(L("Ещё"))
                    .accessibilityIdentifier("readerMore")
                }
            }
        }
        .environment(\.readerMessages, reader.messages)
        .environment(\.readerFeed, profile != nil)
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
    }

    /// A quote carries where it came from. Without a verified Home there is no truthful origin, so nothing is attached.
    private func quote(_ make: (ChatContext.Home?) -> ChatContext) {
        guard let home = client.quoteHome(for: reader.route, primary: library.primary) else {
            unavailable = L("«\(client.displayName)» не на связи. Цитату можно передать, когда устройство подключится.")
            return
        }
        discuss(make(home))
    }

    /// Under the capsule, wherever the page is scrolled: the employee's rhythm in one quiet line (two at accessibility text sizes), and
    /// what the reader must know now: the device is out of reach, or the employee's runs fail.
    @ViewBuilder private var topBar: some View {
        let offline = client.homeUnreachable || client.connectionNeedsPairing
        if profile != nil || offline || reader.error != nil {
            VStack(alignment: .leading, spacing: 2) {
                if let profile {
                    // "Tomorrow" becomes "today" by itself.
                    TimelineView(.everyMinute) { timeline in
                        let line = EmployeeLine(profile, schedules: reader.schedules, now: timeline.date)
                        Button { details = profile } label: {
                            // «и ещё N» is said only when the line has room for it.
                            ViewThatFits(in: .horizontal) {
                                Text(line.whole).lineLimit(1).fixedSize()
                                Text(line.text).lineLimit(1).fixedSize()
                                // Large text takes a second line rather than losing the next run.
                                Text(line.text).lineLimit(typeSize.isAccessibilitySize ? 2 : 1).truncationMode(.tail).multilineTextAlignment(.leading)
                            }
                            .monospacedDigit()
                            .frame(maxWidth: .infinity, minHeight: controlTarget, alignment: .leading).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(AppTheme.secondaryText)
                        .accessibilityLabel(line.whole)
                        .accessibilityHint(L("Открыть расписание"))
                        .accessibilityIdentifier("employeeRhythm")
                    }
                }
                if offline || reader.error != nil {
                    Label(offline ? L("«\(client.displayName)» не на связи. Показано, что уже прочитано.") : (reader.error ?? ""), systemImage: "wifi.slash")
                        .foregroundStyle(AppTheme.secondaryText)
                        .frame(minHeight: 24)
                        .accessibilityIdentifier("readerUnavailable")
                }
                if let failure {
                    // Since when it has not worked, and why. The way to its schedules is one click away.
                    Button { details = profile } label: {
                        TimelineView(.everyMinute) { timeline in
                            Label(TeamWords().failure(since: failure.since, reason: failure.reason, now: timeline.date), systemImage: "exclamationmark.triangle")
                                .multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                        }
                        .frame(minHeight: 24).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(AppTheme.warning)
                    .accessibilityIdentifier("readerFailing")
                }
            }
            .font(ReaderLine.font)
            // Each line keeps its own name for assistive tools and tests, under the reader's.
            .accessibilityElement(children: .contain)
            .frame(maxWidth: Layout.column, alignment: .leading)
            .padding(.horizontal, Layout.edge)
            .padding(.top, 6).padding(.bottom, 6)
            .frame(maxWidth: .infinity)
        }
    }
}

/// The quiet line under a page's capsule: 13.5 on a phone, the meta size on the Mac.
enum ReaderLine {
    static var font: Font {
        #if os(macOS)
        .system(size: 12.5)
        #else
        .footnote
        #endif
    }
}

/// «Каждый день в 07:15 · следующий завтра», with «и ещё 2» kept apart for when there is room. No date: each entry
/// carries its own. An employee without a schedule says what it is for instead.
struct EmployeeLine {
    let text: String
    let more: String?
    var whole: String { [text, more].compactMap { $0 }.joined(separator: " · ") }

    init(_ profile: EmployeeProfile, schedules: [ChatSchedule], now: Date) {
        let rhythm = TeamWords().rhythm(schedules, now: now)
        text = rhythm?.line ?? profile.roleText
        more = rhythm?.more
    }
}

/// The transcript of a reader, read-only. An employee's page is a calm feed: each result as open text under its
/// time, what it was asked as one quiet line, pictures as tiles. A Telegram chat or an archive keeps its bubbles.
/// Each message can be discussed in the chat.
private struct ReaderTranscript: View {
    @ObservedObject var reader: ConversationReader
    /// The employee whose page this is; nil for a Telegram chat, an archive or another Home's assistant.
    let profile: EmployeeProfile?
    let offline: Bool
    let discuss: (HomeMessage) -> Void
    @State private var columnWidth: CGFloat = Layout.column
    /// Stories live in the News reader; the employee's history keeps the conversation, as the chat does.
    private var messages: [HomeMessage] { reader.messages.filter { $0.story == nil } }

    var body: some View {
        ScrollView {
            // Nothing is drawn before the first page arrives, so the page opens at its latest message.
            if reader.loaded || !messages.isEmpty {
                if messages.isEmpty {
                    // The character large, one sentence, nothing to press.
                    VStack(spacing: 16) {
                        if let profile { ToneAvatar(appearance: profile.resolvedAppearance, size: AvatarSize.hero, offline: offline) }
                        Text(profile == nil ? L("Сообщения этой переписки появятся здесь.") : L("Пока тихо. Первый результат появится здесь."))
                            .font(AppTypography.reading).lineSpacing(AppTypography.readingLineSpacing)
                            .foregroundStyle(AppTheme.secondaryText).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(maxWidth: 320).padding(.horizontal, 24)
                    .frame(maxWidth: .infinity, minHeight: 420)
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("readerEmpty")
                } else {
                    rows
                        .frame(maxWidth: Layout.column, alignment: .leading)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.horizontal, Layout.edge)
                        .padding(.top, 16)
                        .padding(.bottom, 32)
                }
            }
        }
        .scrollIndicators(.hidden)
        .defaultScrollAnchor(.bottom, for: .initialOffset)
        .accessibilityIdentifier("readerTranscript")
    }

    private var rows: some View {
        let rows = MessagePages.rows(messages)
        let feed = profile != nil
        // One Telegram chat or an archive shows who wrote; an employee's feed reads like a one-to-one conversation.
        let shared = !reader.route.usesTimeline || MessagePages.isMultiAuthor(messages)
        let bubbleWidth = (columnWidth * 0.78).rounded()
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
                let result = feed && row.message.direction == "outbound" && row.message.kind != "notice"
                VStack(alignment: .leading, spacing: feed ? 8 : 16) {
                    if feed {
                        // Every result carries its own time, on the text's edge; a request borrows the one above it.
                        if result || row.header != nil, let date = row.message.sentAt {
                            Text(ChatClock.cluster(date, hasTime: row.message.hasTime)).font(ReaderLine.font).monospacedDigit()
                                .foregroundStyle(AppTheme.faint).accessibilityAddTraits(.isHeader)
                        }
                    } else if let header = row.header { ClusterHeader(date: header, hasTime: row.message.hasTime) }
                    MessageBubble(message: row.message, shared: shared || row.message.origin?.channel == "telegram" || row.message.origin?.channel == "archive",
                                  bubbleWidth: bubbleWidth, previous: row.previous, headed: row.header != nil || result)
                        #if os(macOS)
                        .help(row.message.sentAt.map { ChatClock.exact($0, hasTime: row.message.hasTime) } ?? "")
                        #endif
                }
                .padding(.top, index == 0 ? 0 : feed ? (row.startsTurn && !result ? 36 : result && row.previous?.direction == "inbound" ? 12 : 36) : row.header != nil ? 40 : row.startsTurn ? 28 : 10)
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
