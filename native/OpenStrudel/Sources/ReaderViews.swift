import SwiftUI

extension EnvironmentValues {
    /// The messages of a reader, for the lines a bubble draws from its neighbours. Nil in the chat itself.
    @Entry var readerMessages: [HomeMessage]? = nil
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

/// One conversation read over the chat: a desk's News, another Home's assistant, a Telegram chat or an archive. There is
/// nothing to type into here. "Обсудить в чате" takes a message or a story back to the chat as context. An employee's
/// page is its own chat (`ConversationView`), not a reader.
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
    @StateObject private var reader: ConversationReader
    let discuss: (ChatContext) -> Void
    @State private var unavailable: String?

    init(reader: ConversationReader, discuss: @escaping (ChatContext) -> Void) {
        _reader = StateObject(wrappedValue: reader)
        self.discuss = discuss
    }

    private var isAssistant: Bool { if case .main = reader.route.kind { true } else { false } }

    var body: some View {
        ReaderTranscript(reader: reader) { message in
            quote { home in .message(message, title: reader.title, home: home) }
        }
        // Named before the bars join it, so their lines keep their own names.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("reader")
        .safeAreaBar(edge: .top, spacing: 0) { VStack(spacing: 0) { topBar }.frame(maxWidth: .infinity).topFade() }
        .scrollEdgeEffectStyle(.soft, for: .top)
        .navigationTitle(reader.title)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        .containerBackground(AppTheme.canvas, for: .navigation)
        #endif
        .toolbar {
            ToolbarItem(placement: .principal) {
                TitleCapsule(appearance: nil, showsCharacter: isAssistant, name: reader.title, offline: client.isOffline(nil), action: nil)
                    .accessibilityLabel(reader.title)
                    .accessibilityValue(reader.title)
                    .accessibilityIdentifier("readerTitle")
            }
        }
        .environment(\.readerMessages, reader.messages)
        .task { await reader.follow() }
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

    /// Under the capsule, wherever the page is scrolled: that the device is out of reach, when it is.
    @ViewBuilder private var topBar: some View {
        let offline = client.homeUnreachable || client.connectionNeedsPairing
        if offline || reader.error != nil {
            Label(offline ? L("«\(client.displayName)» не на связи. Показано, что уже прочитано.") : (reader.error ?? ""), systemImage: "wifi.slash")
                .foregroundStyle(AppTheme.secondaryText)
                .frame(minHeight: 24)
                .accessibilityIdentifier("readerUnavailable")
                .font(ReaderLine.font)
                .frame(maxWidth: Layout.column, alignment: .leading)
                .padding(.horizontal, Layout.edge)
                .padding(.top, 6).padding(.bottom, 6)
                .frame(maxWidth: .infinity)
        }
    }
}

/// Under an employee's capsule, wherever its chat is scrolled: its rhythm in one quiet line (two at accessibility text
/// sizes), and since when and why its runs fail. Both open its details, where a schedule can be paused.
struct EmployeeHeader: View {
    @EnvironmentObject private var client: HomeClient
    @EnvironmentObject private var failures: TeamFailures
    @Environment(\.dynamicTypeSize) private var typeSize
    let profile: EmployeeProfile
    let conversationID: String?
    let openDetails: () -> Void
    @State private var schedules: [ChatSchedule] = []
    @State private var runs: [ScheduleRun] = []

    /// What the Home says wins; a Home that does not say is read from the runs themselves.
    private var failure: (since: Date?, reason: String?, code: String?)? {
        guard !client.isOffline(profile) else { return nil }
        let found = Team.failure(runs, schedules: schedules)
        guard profile.failing ?? (found != nil) else { return nil }
        // The cause is the Home's own word for it, as the team list has it.
        let told = failures.failure(profile.id, on: client)
        return (found?.since ?? told?.since, found?.reason ?? told?.reason, told?.code)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            // "Tomorrow" becomes "today" by itself.
            TimelineView(.everyMinute) { timeline in
                let line = EmployeeLine(profile, schedules: schedules, now: timeline.date)
                Button(action: openDetails) {
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
            if let failure {
                // Since when it has not worked, and why. The way to its schedules is one press away.
                Button(action: openDetails) {
                    TimelineView(.everyMinute) { timeline in
                        Label(TeamWords().failure(since: failure.since, reason: failure.reason, code: failure.code, now: timeline.date), systemImage: "exclamationmark.triangle")
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
        // Each line keeps its own name for assistive tools and tests.
        .accessibilityElement(children: .contain)
        .frame(maxWidth: Layout.column, alignment: .leading)
        #if os(iOS)
        .padding(.horizontal, Layout.edge)
        #endif
        .padding(.top, 6).padding(.bottom, 6)
        .frame(maxWidth: .infinity)
        // The rhythm is read when the page opens, when a run starts or ends, and when the Home names another conversation.
        .task(id: [conversationID ?? "", profile.nextRunAt ?? "", String(profile.working == true), String(profile.failing == true)].joined(separator: "|")) {
            guard let conversationID, let found = await ConversationReader.rhythm(of: profile.id, in: conversationID, on: client) else { return }
            schedules = found.schedules; runs = found.runs
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

/// The transcript of a reader, read-only: a Telegram chat, an archive or another Home's assistant, with its bubbles.
/// Each message can be discussed in the chat.
private struct ReaderTranscript: View {
    @ObservedObject var reader: ConversationReader
    let discuss: (HomeMessage) -> Void
    @State private var columnWidth: CGFloat = Layout.column
    /// Stories live in the News reader; the employee's history keeps the conversation, as the chat does.
    private var messages: [HomeMessage] { reader.messages.filter { $0.story == nil } }

    var body: some View {
        ScrollView {
            // Nothing is drawn before the first page arrives, so the page opens at its latest message.
            if reader.loaded || !messages.isEmpty {
                if messages.isEmpty {
                    // One sentence, nothing to press.
                    VStack(spacing: 16) {
                        Text(L("Сообщения этой переписки появятся здесь."))
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
        // One Telegram chat or an archive shows who wrote; an assistant's history reads like a one-to-one conversation.
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
                VStack(alignment: .leading, spacing: 16) {
                    if let header = row.header { ClusterHeader(date: header, hasTime: row.message.hasTime) }
                    MessageBubble(message: row.message, shared: shared || row.message.origin?.channel == "telegram" || row.message.origin?.channel == "archive",
                                  bubbleWidth: bubbleWidth, previous: row.previous, headed: row.header != nil)
                        #if os(macOS)
                        .help(row.message.sentAt.map { ChatClock.exact($0, hasTime: row.message.hasTime) } ?? "")
                        #endif
                }
                .padding(.top, index == 0 ? 0 : row.header != nil ? 40 : row.startsTurn ? 28 : 10)
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
