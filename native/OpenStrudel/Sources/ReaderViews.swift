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
    @StateObject private var reader: ConversationReader
    let discuss: (ChatContext) -> Void
    @State private var details: EmployeeProfile?
    @State private var unavailable: String?

    init(reader: ConversationReader, discuss: @escaping (ChatContext) -> Void) {
        _reader = StateObject(wrappedValue: reader)
        self.discuss = discuss
    }

    private var profile: EmployeeProfile? {
        if case .employee(let id) = reader.route.kind { return client.profiles.first { $0.id == id } }
        return nil
    }

    var body: some View {
        ReaderTranscript(reader: reader) { message in quote { home in .message(message, title: reader.title, home: home) } }
        .safeAreaBar(edge: .top, spacing: 0) { topBar }
        .navigationTitle(reader.title)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItem(placement: .principal) {
                Button { if let profile { details = profile } } label: {
                    HStack(spacing: 8) {
                        if let profile { AgentAvatar(appearance: profile.resolvedAppearance, size: AvatarSize.toolbar).offlineCharacter(client.isOffline(profile)) }
                        else if case .main = reader.route.kind { AgentAvatar(appearance: nil, size: AvatarSize.toolbar).offlineCharacter(client.isOffline(nil)) }
                        Text(reader.title).font(.body.weight(.semibold)).lineLimit(1)
                    }
                    .frame(maxWidth: 240)
                    #if os(iOS)
                    .frame(minHeight: controlTarget).contentShape(Rectangle())
                    #endif
                }
                .buttonStyle(.plain)
                .disabled(profile == nil)
                .accessibilityLabel(profile == nil ? reader.title : L("Настройки сотрудника"))
                .accessibilityValue(reader.title)
                .accessibilityIdentifier("readerTitle")
            }
        }
        .environment(\.readerMessages, reader.messages)
        .task { await reader.follow() }
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

    @ViewBuilder private var topBar: some View {
        let offline = client.homeUnreachable || client.connectionNeedsPairing
        if offline || reader.error != nil {
            Label(offline ? L("«\(client.displayName)» не на связи. Показано, что уже прочитано.") : (reader.error ?? ""), systemImage: "wifi.slash")
                .font(AppTypography.meta).foregroundStyle(AppTheme.secondaryText)
                .accessibilityIdentifier("readerUnavailable")
                .frame(maxWidth: Layout.column, alignment: .leading)
                .padding(.horizontal, Layout.edge)
                .padding(.top, 16)
                .padding(.bottom, 8)
                .frame(maxWidth: .infinity)
        }
    }
}

/// The transcript of a reader: the same bubbles as the chat, read-only. Each message can be discussed in the chat.
private struct ReaderTranscript: View {
    @ObservedObject var reader: ConversationReader
    let discuss: (HomeMessage) -> Void
    @State private var columnWidth: CGFloat = Layout.column
    /// Stories live in the News reader; the employee's history keeps the conversation, as the chat does.
    private var messages: [HomeMessage] { reader.messages.filter { $0.story == nil } }

    var body: some View {
        ScrollView {
            if messages.isEmpty {
                if reader.loaded {
                    VStack(spacing: 8) {
                        Text(L("Пока пусто")).font(AppTypography.display)
                        Text(L("Здесь появится переписка этого чата. Писать можно во вкладке «Чат».")).font(AppTypography.interface).foregroundStyle(AppTheme.secondaryText)
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: 360).padding(.horizontal, 24)
                    .frame(maxWidth: .infinity, minHeight: 430)
                    .accessibilityIdentifier("readerEmpty")
                }
            } else {
                rows
                    .frame(maxWidth: Layout.column, alignment: .leading)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.horizontal, Layout.edge)
                    .padding(.top, Layout.belowToolbar)
                    .padding(.bottom, 48)
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
