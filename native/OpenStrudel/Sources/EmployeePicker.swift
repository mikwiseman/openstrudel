import SwiftUI

/// The conversations the chat can read: News feeds, employees by device, other devices' assistants, and the Telegram
/// chats and archives found by search. Choosing one opens it over the chat as a reader; nothing here is a place to write.
struct EmployeePicker: View {
    @EnvironmentObject private var library: DeviceLibrary
    @EnvironmentObject private var client: HomeClient
    @Environment(\.dismiss) private var dismiss
    let open: (ReaderRoute) -> Void

    @State private var query = ""
    @State private var showingSettings = false
    @State private var showingHistory = false
    @State private var movingEmployee: EmployeeMoveRequest?
    @State private var renaming: RenameTarget?
    private var searchTerm: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var showsMain: Bool { searchTerm.isEmpty || "OpenStrudel".localizedCaseInsensitiveContains(searchTerm) }

    var body: some View {
        NavigationStack {
            List {
                if searchTerm.isEmpty && library.visibleClients.contains(where: { !$0.usesEmployeeTimeline }) {
                    Button { showingHistory = true } label: {
                        Label(L("Переписки"), systemImage: "clock.arrow.circlepath")
                    }.accessibilityIdentifier("openConversations")
                }
                if searchTerm.isEmpty && !library.newsFeeds.isEmpty {
                    Section(L("Ленты")) {
                        ForEach(library.newsFeeds, id: \.route.id) { feed in
                            // A desk is known by its own character and its latest headline, whatever it is called.
                            let profile = feed.source.profiles.first { $0.id == feed.route.profileID }
                            let line = profile.map { $0.previewText.isEmpty ? $0.roleText : $0.previewText } ?? ""
                            EmployeePickerRow(name: feed.route.title, subtitle: [line, library.hasOtherDevices ? feed.source.displayName : ""].filter { !$0.isEmpty }.joined(separator: " · "),
                                              selected: false, appearance: profile?.resolvedAppearance, offline: feed.source.isOffline(profile)) {
                                open(feed.route); dismiss()
                            }
                            .accessibilityIdentifier("feed-" + (feed.route.profileID ?? ""))
                        }
                    }
                }
                if !showsMain && !library.visibleClients.contains(where: { source in library.visibleProfiles(on: source).contains { $0.name.localizedCaseInsensitiveContains(searchTerm) || $0.roleText.localizedCaseInsensitiveContains(searchTerm) } || source.telegramGroups.contains { $0.title.localizedCaseInsensitiveContains(searchTerm) } }) {
                    SearchEmptyState(query: query) { query = "" }
                }
                ForEach(library.visibleClients) { source in
                    let people = library.visibleProfiles(on: source).filter { searchTerm.isEmpty || $0.name.localizedCaseInsensitiveContains(searchTerm) || $0.roleText.localizedCaseInsensitiveContains(searchTerm) }
                    // The chat's own assistant is the Chat tab; every other device's assistant is read here.
                    let showsAssistant = showsMain && source !== library.primary
                    if showsAssistant || !people.isEmpty {
                    Section {
                        if !searchTerm.isEmpty || !library.collapsedDeviceIDs.contains(source.id) {
                        if showsAssistant {
                            EmployeePickerRow(name: "OpenStrudel", subtitle: source.displayName, selected: false, appearance: nil, offline: source.isOffline(nil)) {
                                open(ReaderRoute(connectionID: source.id, kind: .main, title: "OpenStrudel")); dismiss()
                            }
                        }
                        ForEach(people) { profile in
                            EmployeePickerRow(name: profile.name, subtitle: profile.previewText.isEmpty ? profile.roleText : profile.previewText, selected: false,
                                              appearance: profile.resolvedAppearance, offline: source.isOffline(profile)) {
                                open(ReaderRoute(connectionID: source.id, kind: .employee(profile.id), title: profile.name)); dismiss()
                            }
                            .accessibilityIdentifier("employee-" + profile.id)
                            .contextMenu {
                                Button(L("Переименовать…"), systemImage: "pencil") { renaming = RenameTarget(client: source, profile: profile) }
                                    .disabled(source.isOffline(profile))
                                Button(L("Скрыть у меня"), systemImage: "eye.slash") { Task { await library.setHidden(true, profile: profile, on: source) } }
                                Button(L("Перенести на другое устройство…"), systemImage: "arrow.right.square") { movingEmployee = EmployeeMoveRequest(source: source, profile: profile) }
                                    .disabled(!source.ownsDevice)
                            }
                            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                Button(L("Скрыть"), systemImage: "eye.slash") { Task { await library.setHidden(true, profile: profile, on: source) } }.tint(.gray)
                            }
                        }
                        }
                    } header: {
                        HStack(spacing: 0) {
                        Button {
                            library.setCollapsed(!library.collapsedDeviceIDs.contains(source.id), client: source)
                        } label: {
                            HStack(spacing: 8) {
                                Text(source.displayName)
                                if source.connectionNeedsUnlock { Image(systemName: "lock") }
                                else if source.homeUnreachable { Image(systemName: "wifi.slash") }
                                Spacer(minLength: 0)
                                Image(systemName: !searchTerm.isEmpty || !library.collapsedDeviceIDs.contains(source.id) ? "chevron.down" : "chevron.right")
                                    .font(.caption.weight(.semibold))
                            }
                            .font(.subheadline.weight(.semibold)).foregroundStyle(.primary)
                            .frame(maxWidth: .infinity, minHeight: controlTarget, alignment: .leading)
                            .contentShape(Rectangle())
                        }
                            .buttonStyle(.plain)
                            .accessibilityLabel(headerLabel(source))
                            .accessibilityValue(library.collapsedDeviceIDs.contains(source.id) && searchTerm.isEmpty ? L("Свёрнуто") : L("Развёрнуто"))
                            .accessibilityIdentifier("deviceHeader-" + source.id)
                        Menu {
                                Button(L("Переименовать…"), systemImage: "pencil") { renaming = RenameTarget(client: source) }
                                    .disabled(!source.canRenameDevice)
                        } label: {
                            Image(systemName: "ellipsis").frame(minWidth: controlTarget, minHeight: controlTarget)
                        }
                            .accessibilityLabel(L("Действия: \(source.displayName)"))
                            .accessibilityIdentifier("deviceMenu-" + source.id)
                            }
                    }
                    }
                    // A group found by name opens as a reader of that group.
                    let groups = source.telegramGroups.filter { !searchTerm.isEmpty && $0.title.localizedCaseInsensitiveContains(searchTerm) }
                    if !groups.isEmpty {
                        Section(library.hasOtherDevices ? L("Группы в Telegram · \(source.displayName)") : L("Группы в Telegram")) {
                            ForEach(groups) { group in
                                EmployeePickerRow(name: group.title, subtitle: group.enabled == false ? L("Бот на паузе") : source.profiles.first { $0.id == group.profileId }?.name ?? "OpenStrudel",
                                                  selected: false, appearance: nil, symbol: "person.2") {
                                    if let id = group.conversationId { open(ReaderRoute(connectionID: source.id, kind: .conversation(id), title: group.title)) }
                                    dismiss()
                                }.accessibilityIdentifier("telegramConversation-" + group.chatId)
                            }
                        }
                    }
                }
                HiddenEmployeesButton()
            }
            .navigationTitle(L("Переписки"))
            .navigationDestination(isPresented: $showingHistory) { ConversationBrowser(open: { route in open(route); dismiss() }) }
            .sheet(item: $movingEmployee) { EmployeeMoveView(request: $0) }
            .sheet(item: $renaming) { NameEditor(target: $0) }
            #if os(iOS)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: L("Найти чат"))
            #else
            .searchable(text: $query, prompt: L("Найти чат"))
            .frame(minWidth: 480, idealWidth: 560, minHeight: 480, idealHeight: 640)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button { showingSettings = true } label: { Image(systemName: "gearshape") }
                        .accessibilityLabel(L("Настройки")).accessibilityIdentifier("teamSettings")
                }
                ToolbarItem(placement: .cancellationAction) { Button(L("Готово")) { dismiss() } }
            }
        }
        .sheet(isPresented: $showingSettings) { SettingsView().environmentObject(client) }
        .modifier(InterfaceLanguage())
    }

    /// The device's name and, as the chat shows with a symbol, why it cannot be reached.
    private func headerLabel(_ source: HomeClient) -> String {
        if source.connectionNeedsUnlock { return source.displayName + ", " + L("Unlock connection") }
        return source.homeUnreachable ? source.displayName + ", " + L("Нет связи") : source.displayName
    }
}

/// Channel history: the bot's Telegram chats and imported archives, each a reader. Browsing never changes routing or delivery.
struct ConversationBrowser: View {
    @EnvironmentObject private var library: DeviceLibrary
    let open: (ReaderRoute) -> Void
    @State private var query = ""
    private var term: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var hasHistory: Bool {
        library.visibleClients.contains { source in
            source.telegram?.chats?.contains(where: { $0.conversationId != nil }) == true || !source.importedConversations.isEmpty
        }
    }

    var body: some View {
        List {
            if !hasHistory {
                ContentUnavailableView(L("Пока нет переписок"), systemImage: "bubble.left.and.bubble.right",
                    description: Text(L("Разговоры с ботом в Telegram появятся здесь автоматически.")))
            } else {
                ForEach(library.visibleClients) { source in
                    let chats = (source.telegram?.chats ?? []).filter { $0.conversationId != nil && (term.isEmpty || $0.title.localizedCaseInsensitiveContains(term)) }
                    let archives = source.importedConversations.filter { term.isEmpty || $0.title.localizedCaseInsensitiveContains(term) }
                    if !chats.isEmpty || !archives.isEmpty {
                        Section {
                            ForEach(chats) { chat in
                                EmployeePickerRow(name: chat.title,
                                    subtitle: (chat.isGroup ? L("Группа в Telegram") : L("Личный разговор в Telegram")) + (chat.enabled == false ? L(" · на паузе") : ""),
                                    selected: false, appearance: nil, symbol: chat.isGroup ? "person.2" : "bubble.left") {
                                        if let id = chat.conversationId { open(ReaderRoute(connectionID: source.id, kind: .conversation(id), title: chat.title)) }
                                    }.accessibilityIdentifier("telegramConversation-" + chat.chatId)
                            }
                            ForEach(archives) { chat in
                                EmployeePickerRow(name: chat.title, subtitle: L("Из прежнего приложения"), selected: false, appearance: nil, symbol: "archivebox") {
                                    open(ReaderRoute(connectionID: source.id, kind: .conversation(chat.id), title: chat.title))
                                }
                            }
                        } header: { if library.hasOtherDevices { Text(source.displayName) } }
                    }
                }
                if !term.isEmpty && !library.visibleClients.contains(where: { source in
                    (source.telegram?.chats ?? []).contains { $0.conversationId != nil && $0.title.localizedCaseInsensitiveContains(term) }
                        || source.importedConversations.contains { $0.title.localizedCaseInsensitiveContains(term) }
                }) { SearchEmptyState(query: query) { query = "" } }
            }
        }
        .navigationTitle(L("Переписки"))
        .searchable(text: $query, prompt: L("Найти переписку"))
    }
}

/// A row like the chat's title: the character at 36, 12 to the name, the name over one line of preview.
/// An employee whose device is out of reach rests in grey and says so in words.
struct EmployeePickerRow: View {
    @Environment(\.dynamicTypeSize) private var textSize
    let name: String
    let subtitle: String
    let selected: Bool
    let appearance: AgentAppearance?
    var offline = false
    var symbol: String? = nil
    let action: () -> Void
    private var preview: String { offline ? L("Нет связи") : subtitle }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                if !textSize.isAccessibilitySize {
                    if let symbol {
                        Image(systemName: symbol).font(.title3).foregroundStyle(AppTheme.secondaryText)
                            .frame(width: AvatarSize.row, height: AvatarSize.row)
                    } else {
                        AgentAvatar(appearance: appearance, size: AvatarSize.row).offlineCharacter(offline)
                    }
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(name).font(AppTypography.interface.weight(.medium)).foregroundStyle(Color.primary)
                        .lineLimit(textSize.isAccessibilitySize ? nil : 1)
                    if !preview.isEmpty {
                        Text(preview).font(AppTypography.interface).foregroundStyle(AppTheme.secondaryText)
                            .lineLimit(textSize.isAccessibilitySize ? nil : 1)
                    }
                }
                Spacer(minLength: 0)
                if selected { Image(systemName: "checkmark").fontWeight(.semibold).foregroundStyle(AppTheme.accent) }
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.automatic)
        .accessibilityLabel(name)
        .accessibilityValue(preview)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

struct SearchEmptyState: View {
    let query: String
    let clear: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(L("Ничего не найдено")).font(AppTypography.interface.weight(.semibold))
            Text(L("Нет совпадений для «\(query)». Проверьте название или очистите поиск."))
                .font(AppTypography.interface).foregroundStyle(AppTheme.secondaryText).fixedSize(horizontal: false, vertical: true)
            Button(L("Очистить поиск"), action: clear).frame(minHeight: controlTarget)
        }.padding(.vertical, 16).accessibilityIdentifier("searchEmptyState")
    }
}
