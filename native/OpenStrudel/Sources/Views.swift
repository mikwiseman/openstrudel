import SwiftUI
import PhotosUI
import UniformTypeIdentifiers
import QuickLook

/// The native surface is intentionally small: chats on the left, one calm
/// composer, and settings only for the two connections a person can act on.
struct OpenStrudelRootView: View {
    @EnvironmentObject private var library: DeviceLibrary
    @Environment(\.scenePhase) private var scenePhase
    @EnvironmentObject private var client: HomeClient
    @State private var showSettings = false
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
        ZStack {
            HomeBackground()
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
                #if os(macOS)
                HStack(spacing: 0) {
                    Sidebar(showSettings: $showSettings)
                        .frame(width: 280)
                    Rectangle().fill(.primary.opacity(0.08)).frame(width: 1)
                    ConversationView(showSettings: $showSettings)
                }
                #else
                NavigationStack { ConversationView(showSettings: $showSettings).background(HomeBackground()) }
                #endif
            }
        }
        .task(id: pollingPhase) {
            guard pollingPhase == .active else { return }
            #if os(macOS)
            if Bundle.main.bundleIdentifier == "is.openstrudel.mac",
               client.normalizedBaseURL == "http://127.0.0.1:7788",
               client.hasToken && !client.isPairing && LocalHome.isAvailable {
                await client.startLocalHome()
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
        .task(id: pollingPhase) {
            guard pollingPhase == .active else { return }
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(10)) } catch { break }
                await client.refreshOpenAIAccount()
            }
        }
        .sheet(isPresented: $showSettings) {
            SettingsView().environmentObject(client)
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
            Button("Понятно", role: .cancel) {}
        } message: {
            Text(UserFacingError.text(client.errorMessage ?? ""))
        }
        #if os(macOS)
        .frame(minWidth: 940, minHeight: 620)
        #endif
    }
}

private struct HomeConnectingView: View {
    @EnvironmentObject private var client: HomeClient
    var body: some View {
        VStack(spacing: 24) {
            OpenStrudelMark(size: 76)
            Text(client.isStartingLocalHome ? "Запускаем OpenStrudel" : "Подключаемся к вашей команде")
                .font(.system(.title, design: .serif, weight: .medium))
                .multilineTextAlignment(.center)
            ProgressView().controlSize(.large).accessibilityLabel("Подключение")
        }
        .padding(28).frame(maxWidth: 620)
        .accessibilityIdentifier("homeConnecting")
    }
}

#if os(macOS)
/// Home runs beside the app. It is found again automatically once it starts.
private struct HomeUnavailableView: View {
    @EnvironmentObject private var client: HomeClient
    @State private var showingInvitation = false
    @State private var invitation: MacPairing?
    @State private var starting = false
    private var reconnecting: Bool { client.shouldRestoreConnection && client.connectionState == .unavailable }

    var body: some View {
        ScrollView {
        VStack(spacing: 28) {
            OpenStrudelMark(size: 76)
            VStack(spacing: 12) {
                Text(reconnecting ? "Нет связи с OpenStrudel" : client.isSignedOut ? "Вы вышли на этом устройстве" : "Помощники для ваших задач")
                    .font(AppTypography.welcome)
                    .multilineTextAlignment(.center)
                Text(reconnecting
                     ? "Пока не удаётся подключиться к вашей команде. Ваши чаты сохранены. Подключимся автоматически."
                     : client.isSignedOut ? "Сотрудники сохранены на своих устройствах. Подключитесь снова, чтобы продолжить." : "Начните на этом Mac. Создайте сотрудников или восстановите их из копии. Другие устройства можно подключить позже.")
                    .font(.body).foregroundStyle(AppTheme.secondaryText)
                    .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
            }
            VStack(spacing: 12) {
                if client.isConfigured && !client.isLocalConnection {
                    Button { Task { await client.load() } } label: {
                        SetupActionLabel(title: "Попробовать ещё раз", icon: "arrow.clockwise")
                    }.buttonStyle(.glassProminent).controlSize(.large)
                    if let managementURL = DigitalOceanCloud.managementURL(for: client.normalizedBaseURL) {
                        Link(destination: managementURL) {
                            SetupActionLabel(title: "Управлять облаком", icon: "arrow.up.right.square")
                        }.buttonStyle(.glass).controlSize(.large)
                            .accessibilityIdentifier("manageCloudOffline")
                            .accessibilityHint("Открыть вашу установку в DigitalOcean")
                    }
                } else if LocalHome.isAvailable {
                    Button {
                        starting = true
                        Task { await client.startLocalHome(); starting = false }
                    } label: {
                        SetupChoiceLabel(title: starting ? "Готовим ваш Mac…" : "Начать на этом Mac", subtitle: "Сотрудники и их файлы будут храниться здесь.", icon: "desktopcomputer")
                    }.buttonStyle(.glassProminent).controlSize(.large)
                        .buttonBorderShape(.roundedRectangle(radius: 22))
                        .disabled(starting).accessibilityIdentifier("setupThisMac")
                }
                Button { showingInvitation = true } label: {
                    SetupActionLabel(title: "Подключить другое устройство", icon: "link")
                }.buttonStyle(.plain).foregroundStyle(AppTheme.secondaryText)
                    .disabled(starting).accessibilityIdentifier("setupExisting")
            }
            if client.isConfigured { DeviceSignOutButton {} }
            Link("Конфиденциальность", destination: URL(string: "https://waiwai.is/openstrudel/privacy")!)
                .font(.caption).buttonStyle(.plain).foregroundStyle(AppTheme.secondaryText)
        }
        .padding(40).frame(maxWidth: 520).frame(maxWidth: .infinity)
        }.defaultScrollAnchor(.center, for: .alignment)
        .sheet(isPresented: $showingInvitation, onDismiss: {
            if let invitation { client.pendingPairing = invitation; client.pairingError = nil; self.invitation = nil }
        }) { ConnectionInvitationView { invitation = $0 } }
    }
}

private struct SetupChoiceLabel: View {
    let title: String
    let subtitle: String
    let icon: String
    var body: some View {
        HStack(spacing: 16) {
            Image(systemName: icon).font(.title3).frame(width: 28).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.system(size: 16, weight: .semibold))
                Text(subtitle).font(.system(size: 13)).opacity(0.8)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }.padding(.horizontal, 8).padding(.vertical, 12)
            .frame(maxWidth: .infinity, minHeight: 62).contentShape(Rectangle())
    }
}

private struct Sidebar: View {
    @EnvironmentObject private var library: DeviceLibrary
    @EnvironmentObject private var client: HomeClient
    @Binding var showSettings: Bool
    @State private var searching = false
    @State private var query = ""
    private var searchTerm: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
    @FocusState private var searchFocused: Bool
    @FocusState private var focusedEmployee: String?
    @State private var deletion: EmployeeDeletion?
    @State private var confirmDeletion = false
    @State private var deleting = false

    private struct EmployeeDeletion {
        let client: HomeClient
        let id: String
        let name: String
        let device: String
    }

    private var showsMain: Bool { searchTerm.isEmpty || "OpenStrudel".localizedCaseInsensitiveContains(searchTerm) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                if searching {
                    HStack(spacing: 6) {
                        Image(systemName: "magnifyingglass").foregroundStyle(AppTheme.secondaryText)
                        TextField("Найти чат", text: $query)
                            .textFieldStyle(.plain)
                            .focused($searchFocused)
                            .task {
                                // The field has to be in the window before it can take focus from the composer.
                                try? await Task.sleep(for: .milliseconds(50))
                                searchFocused = true
                            }
                            .onExitCommand(perform: closeSearch)
                        Button(action: closeSearch) { Image(systemName: "xmark.circle.fill") }
                            .buttonStyle(.plain)
                            .foregroundStyle(.tertiary)
                            .accessibilityLabel("Закрыть поиск")
                            .help("Закрыть поиск (Escape)")
                    }
                    .padding(.horizontal, 10)
                    .frame(height: 32)
                    .background(.primary.opacity(0.07), in: Capsule())
                } else {
                    Button { searching = true } label: {
                        Image(systemName: "magnifyingglass")
                            .font(.system(size: 16, weight: .medium))
                            .frame(width: 36, height: 36)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(AppTheme.secondaryText)
                    .accessibilityLabel("Поиск чата")
                    .help("Найти сотрудника (⌘F)")
                    .keyboardShortcut("f", modifiers: .command)

                    Spacer()
                }

                Button {
                    closeSearch()
                    library.beginEmployee()
                } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 17, weight: .medium))
                        .frame(width: 36, height: 36)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(AppTheme.secondaryText)
                .disabled(client.isCreating)
                .accessibilityLabel("Новый сотрудник")
                .help("Новый сотрудник (⌘N)")
            }
            .padding(.horizontal, 15)
            .padding(.top, 12)
            .padding(.bottom, 10)

            ScrollView {
                VStack(spacing: 3) {
                    if !showsMain && !library.visibleClients.contains(where: { source in source.profiles.contains { $0.name.localizedCaseInsensitiveContains(searchTerm) || $0.roleText.localizedCaseInsensitiveContains(searchTerm) } || source.telegramGroups.contains { $0.title.localizedCaseInsensitiveContains(searchTerm) } }) {
                        SearchEmptyState(query: query) { query = "" }
                    }
                    ForEach(library.visibleClients) { source in
                        let people = source.profiles.filter { searchTerm.isEmpty || $0.name.localizedCaseInsensitiveContains(searchTerm) || $0.roleText.localizedCaseInsensitiveContains(searchTerm) }
                        if showsMain || !people.isEmpty {
                            if library.hasOtherDevices {
                                HStack(spacing: 5) {
                                    Text(source.displayName)
                                    if source.homeUnreachable { Image(systemName: "wifi.slash").accessibilityLabel("Нет связи") }
                                }.font(.system(size: 11, weight: .medium)).foregroundStyle(AppTheme.secondaryText)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.horizontal, 12).padding(.top, 14).padding(.bottom, 5)
                            }
                            if showsMain {
                                SidebarRow(name: "OpenStrudel", subtitle: library.hasOtherDevices ? source.displayName : "Помощник для ваших задач",
                                           selected: source === client && source.selectedProfileID == nil && source.selectedChatID == nil, appearance: nil) {
                                    closeSearch(); Task { await library.select(source, profile: nil) }
                                }
                            }
                            if source.isEmployeeDraft && searchTerm.isEmpty {
                                SidebarRow(name: "Новый сотрудник", subtitle: "Опишите его задачу", selected: source === client, appearance: source.draftAppearance) { library.select(source) }
                            }
                            ForEach(people) { profile in
                                SidebarRow(name: profile.name, subtitle: profile.previewText.isEmpty ? profile.roleText : profile.previewText,
                                           selected: source === client && source.selectedProfileID == profile.id && source.activeTelegramGroup == nil, appearance: profile.resolvedAppearance) {
                                    closeSearch()
                                    focusedEmployee = source.id + profile.id
                                    Task { await library.select(source, profile: profile.id) }
                                }
                                .focusable()
                                .focused($focusedEmployee, equals: source.id + profile.id)
                                .focusEffectDisabled()
                                #if os(macOS)
                                .onDeleteCommand {
                                    guard !deleting, source.canManageOpenAI else { return }
                                    requestDeletion(profile, from: source)
                                }
                                #endif
                                .contextMenu {
                                    Button("Удалить сотрудника…", role: .destructive) { requestDeletion(profile, from: source) }
                                        .disabled(deleting || !source.canManageOpenAI || source.homeUnreachable)
                                }
                            }
                        }
                        let groups = source.telegramGroups.filter { searchTerm.isEmpty || $0.title.localizedCaseInsensitiveContains(searchTerm) }
                        if !groups.isEmpty {
                            Text(library.hasOtherDevices ? "Telegram · " + source.displayName : "Telegram")
                                .font(.caption.weight(.medium)).foregroundStyle(AppTheme.secondaryText)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 12).padding(.top, 14).padding(.bottom, 5)
                            ForEach(groups) { group in
                                SidebarRow(name: group.title, subtitle: group.enabled == false ? "Бот на паузе" : "Группа в Telegram",
                                           selected: source === client && source.selectedChatID == group.conversationId,
                                           appearance: source.profiles.first(where: { $0.id == group.profileId })?.resolvedAppearance,
                                           symbol: "person.2") {
                                    closeSearch(); Task { await library.select(source, group: group) }
                                }
                                .accessibilityIdentifier("telegramConversation-" + group.chatId)
                            }
                        }
                    }
                }
                .padding(.horizontal, 9)
            }
            .scrollIndicators(.hidden)

            Spacer(minLength: 12)

            Button { showSettings = true } label: {
                HStack(spacing: 10) {
                    Image(systemName: library.hasOtherDevices ? "desktopcomputer" : client.isLocalConnection ? "laptopcomputer" : "desktopcomputer")
                        .font(.system(size: 19)).frame(width: 30)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(library.hasOtherDevices ? "Мои устройства" : client.displayName)
                            .font(.subheadline.weight(.medium)).lineLimit(1).truncationMode(.middle)
                        Text("Устройства и настройки").font(.caption).foregroundStyle(AppTheme.secondaryText)
                    }
                    Spacer(minLength: 4)
                    Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                }
                .padding(.horizontal, 10).padding(.vertical, 10)
                .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Устройства и настройки")
            .accessibilityValue(library.hasOtherDevices ? "Мои устройства" : client.displayName)
            .accessibilityIdentifier("openDeviceSettings")
            .help("Устройства и настройки OpenStrudel (⌘,)")
            .padding(.horizontal, 12)
            .padding(.bottom, 13)
        }
        .alert("Удалить «\(deletion?.name ?? "сотрудника")»?", isPresented: $confirmDeletion) {
            Button("Отмена", role: .cancel) {}
            Button("Удалить", role: .destructive) {
                guard let target = deletion else { return }
                deleting = true
                Task {
                    defer { deleting = false }
                    do { try await target.client.deleteProfile(target.id) }
                    catch { client.errorMessage = error.localizedDescription }
                }
            }
        } message: {
            Text("Сотрудник, его переписка и расписания будут удалены с «\(deletion?.device ?? "устройства")». Это действие нельзя отменить.")
        }
    }

    private func requestDeletion(_ profile: EmployeeProfile, from source: HomeClient) {
        guard !deleting else { return }
        let device = source.devices.first(where: { $0.id == profile.deviceId })?.name ?? source.displayName
        deletion = EmployeeDeletion(client: source, id: profile.id, name: profile.name, device: device)
        confirmDeletion = true
    }

    private func select(_ profileID: String?) {
        closeSearch()
        Task { await client.selectProfile(profileID) }
    }

    private func closeSearch() {
        searching = false
        query = ""
    }
}

private struct SidebarRow: View {
    let name: String
    let subtitle: String
    let selected: Bool
    let appearance: AgentAppearance?
    var symbol: String? = nil
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 11) {
                if let symbol {
                    Image(systemName: symbol).font(.title3).foregroundStyle(AppTheme.accent)
                        .frame(width: 36, height: 36).background(AppTheme.accent.opacity(0.10), in: RoundedRectangle(cornerRadius: 10))
                } else { AgentAvatar(appearance: appearance, size: 36) }
                VStack(alignment: .leading, spacing: 2) {
                    Text(name).font(AppTypography.sidebarTitle).lineLimit(1)
                    if !subtitle.isEmpty { Text(subtitle).font(AppTypography.sidebarDetail).foregroundStyle(AppTheme.secondaryText).lineLimit(1) }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(height: 60)
            .background(selected ? Color.primary.opacity(0.10) : .clear, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
        .contentShape(Rectangle())
        .accessibilityLabel(name)
        .accessibilityValue(subtitle)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .help(name + (subtitle.isEmpty ? "" : "\n" + subtitle))
    }
}
#endif

private struct ConversationView: View {
    @EnvironmentObject private var library: DeviceLibrary
    @EnvironmentObject private var client: HomeClient
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Binding var showSettings: Bool
    @State private var draft = ""
    @State private var pickedFiles: [PickedFile] = []
    @State private var drafts = UserDefaults.standard.dictionary(forKey: "openstrudel.drafts") as? [String: String] ?? [:]
    @State private var showEmployees = false
    @State private var showBotDetails = false
    @State private var followsLatest = true
    @State private var userIsScrolling = false
    @State private var visibleMessageID: String?
    @State private var hasNewMessages = false
    @FocusState private var focused: Bool
    private var draftKey: String { HomeDrafts.key(home: client.baseURLString, profile: client.selectedProfileID, chat: client.selectedChatID) }

    var body: some View {
        VStack(spacing: 0) {
            #if os(macOS)
            ConversationHeader { showBotDetails = true }
            #endif

            if client.connectionNeedsPairing || client.homeUnreachable || client.health == nil {
                HStack(spacing: 10) {
                    if client.isConnecting { ProgressView().controlSize(.small) }
                    else { Image(systemName: "wifi.slash") }
                    Text(client.connectionNeedsPairing ? "Подключите «\(client.displayName)» снова. Переписка сохранена на устройстве." : client.isConnecting ? "Подключаемся к «\(client.displayName)»…" : "«\(client.displayName)» не на связи. Переписка и черновики сохранены. Подключимся автоматически.")
                        .font(.callout)
                    Spacer(minLength: 0)
                    if client.connectionNeedsPairing { Button("Подключить") { showSettings = true } }
                }.foregroundStyle(AppTheme.secondaryText).padding(.horizontal, chatInset).padding(.vertical, 10)
            }

            if client.openAIAccount?.connected == false && !client.homeUnreachable && client.health != nil {
                OpenAIRecoveryNotice()
                    .padding(.horizontal, chatInset).padding(.vertical, 8)
            }

            ScrollViewReader { proxy in
                ScrollView {
                    if client.messages.isEmpty && client.visiblePendingMessages.isEmpty {
                        EmptyChat()
                            .frame(maxWidth: .infinity, minHeight: 430)
                    } else {
                        TranscriptStack {
                            if client.hasEarlierMessages {
                                Button {
                                    let anchor = visibleMessageID ?? client.messages.first?.id
                                    let conversation = draftKey
                                    followsLatest = false
                                    visibleMessageID = anchor
                                    Task {
                                        await client.loadEarlierMessages()
                                        guard conversation == draftKey, let anchor else { return }
                                        proxy.scrollTo(anchor, anchor: .top)
                                    }
                                } label: {
                                    HStack {
                                        if client.isLoadingEarlier { ProgressView().controlSize(.small) }
                                        Text(client.isLoadingEarlier ? "Загружаем историю…" : "Показать более ранние сообщения")
                                    }
                                }
                                    .disabled(client.isLoadingEarlier)
                                    .font(.caption).buttonStyle(.plain).foregroundStyle(AppTheme.secondaryText)
                                    .frame(maxWidth: .infinity, minHeight: controlTarget)
                            }
                            ForEach(MessagePages.rows(client.messages)) { row in
                                // Keep one stable layout node per message,
                                // including its optional day heading.
                                VStack(alignment: .leading, spacing: 16) {
                                    if let day = row.day { DayDivider(date: day) }
                                    MessageBubble(message: row.message)
                                }.id(row.id)
                            }
                            ForEach(client.visiblePendingMessages) { pending in
                                VStack(alignment: .trailing, spacing: 4) {
                                    PendingMessageBubble(text: pending.text, files: pending.files)
                                    if let error = pending.error {
                                        Text(UserFacingError.text(error)).font(.caption).foregroundStyle(AppTheme.secondaryText)
                                        if pending.operationID == nil {
                                            Button("Проверить доставку и повторить") { Task { await client.retry(pending) } }.buttonStyle(.plain).frame(minHeight: controlTarget)
                                        }
                                    } else if let delivery = pending.deliveryState {
                                        Text(delivery == "waiting_for_device" ? "Сообщение сохранено. Ждём подключения устройства." : "Сообщение сохранено. Передаём сотруднику.")
                                            .font(.caption).foregroundStyle(AppTheme.secondaryText)
                                        if client.canManageOpenAI {
                                            Button("Отменить доставку") { Task { await client.cancelPending(pending) } }.buttonStyle(.plain).frame(minHeight: controlTarget)
                                        }
                                    }
                                }
                                    .id(pending.id)
                            }
                            ForEach(client.interactions) { interaction in
                                InteractionCard(interaction: interaction).id(interaction.id)
                            }
                            if client.isSending && client.interactions.isEmpty {
                                ThinkingBubble(name: client.activeAgentName, appearance: client.activeAppearance).id("thinking-message")
                            }
                            if let error = client.syncError {
                                Text(UserFacingError.text(error)).font(.caption).foregroundStyle(AppTheme.secondaryText)
                            }
                            Color.clear.frame(height: 1).id("conversation-bottom")
                        }
                        .frame(maxWidth: chatColumn, alignment: .leading)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.horizontal, chatInset)
                        .padding(.top, 18)
                        .padding(.bottom, 24)
                    }
                }
                .scrollIndicators(.hidden)
                .scrollPosition(id: Binding(
                    get: { followsLatest ? nil : visibleMessageID },
                    set: { if !followsLatest { visibleMessageID = $0 } }
                ), anchor: .top)
                .defaultScrollAnchor(.bottom, for: .initialOffset)
                .defaultScrollAnchor(followsLatest ? .bottom : nil, for: .sizeChanges)
                #if os(macOS)
                .mask(EdgeFade())
                #endif
                .scrollDismissesKeyboard(.interactively)
                .onScrollPhaseChange { oldPhase, phase, context in
                    // A touch on an answer button also enters .tracking. Only an
                    // actual drag should change the transcript reading anchor.
                    if phase == .interacting {
                        userIsScrolling = true
                        followsLatest = false
                    }
                    if phase == .idle && userIsScrolling {
                        userIsScrolling = false
                        followsLatest = context.geometry.visibleRect.maxY >= context.geometry.contentSize.height - 60
                        if followsLatest { hasNewMessages = false }
                    }
                }
                .onChange(of: client.messages.last?.id) { _, _ in
                    if followsLatest { scrollToBottom(proxy, animated: true) }
                    else { hasNewMessages = true }
                }
                .onChange(of: client.visiblePendingMessages.map(\.id)) { old, new in
                    if new.contains(where: { !old.contains($0) }) {
                        followsLatest = true
                        hasNewMessages = false
                        scrollToBottom(proxy, animated: true)
                    }
                }
                .onChange(of: client.interactions) { _, _ in
                    if followsLatest { scrollToBottom(proxy, animated: true) }
                    else { hasNewMessages = true }
                }
                .onChange(of: draftKey) { _, _ in
                    followsLatest = true
                    hasNewMessages = false
                    scrollToBottom(proxy, animated: false)
                }
                // Animate scrolling, not pending-row replacement: an implicit
                // layout animation can loop while the iPad keyboard is visible.
                .overlay(alignment: .bottom) {
                    if hasNewMessages && !followsLatest {
                        Button("Новые сообщения", systemImage: "arrow.down") {
                            followsLatest = true
                            hasNewMessages = false
                            scrollToBottom(proxy, animated: true)
                        }
                        .font(.subheadline).buttonStyle(.glass)
                        .padding(.bottom, 8)
                    }
                }
                .task {
                    await Task.yield()
                    await Task.yield()
                    scrollToBottom(proxy, animated: false)
                }
            }

            if client.activeTelegramGroup != nil {
                Text("Здесь можно обсудить переписку с помощником. Ответ останется в OpenStrudel.")
                    .font(.caption).foregroundStyle(AppTheme.secondaryText)
                    .frame(maxWidth: chatColumn, alignment: .leading).padding(.horizontal, chatInset)
                    .accessibilityIdentifier("telegramReplyDestination")
            }
            Composer(draft: $draft, files: $pickedFiles, focused: $focused, contextID: draftKey, canSend: client.isConfigured && !client.connectionNeedsPairing && client.openAIAccount?.connected != false) {
                guard client.openAIAccount?.connected != false else { return }
                let value = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !value.isEmpty || !pickedFiles.isEmpty else { return }
                let files = pickedFiles
                pickedFiles = []
                draft = ""
                focused = true
                Task { await client.sendMessage(value, files: files) }
            }
            .frame(maxWidth: chatColumn)
            .padding(.horizontal, chatInset)
        }
        .task { draft = drafts[draftKey] ?? ""; pickedFiles = library.fileDrafts[draftKey] ?? [] }
        .onChange(of: client.openAIAccount?.connected) { _, connected in
            if connected == false { focused = false }
        }
        .onChange(of: pickedFiles) { _, value in library.fileDrafts[draftKey] = value }
        .onChange(of: draft) { _, value in
            drafts[draftKey] = value.isEmpty ? nil : value
            UserDefaults.standard.set(drafts, forKey: "openstrudel.drafts")
        }
        .onChange(of: draftKey) { old, new in
            drafts[old] = draft
            draft = drafts[new] ?? ""
            library.fileDrafts[old] = pickedFiles
            pickedFiles = library.fileDrafts[new] ?? []
            #if os(macOS)
            focused = client.isEmployeeDraft
            #else
            focused = false
            #endif
        }
        #if os(macOS)
        .padding(.horizontal, 13)
        .padding(.vertical, 9)
        #else
        .padding(.bottom, 8)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button { focused = false; showEmployees = true } label: { Image(systemName: "line.3.horizontal") }
                    .foregroundStyle(.primary)
                    .accessibilityLabel("Чаты")
            }
            ToolbarItem(placement: .principal) {
                ConversationTitle { focused = false; showBotDetails = true }
            }
            ToolbarItem(placement: .topBarTrailing) {
                if client.activeProfile == nil {
                    Button { focused = false; showSettings = true } label: { Image(systemName: "gearshape") }
                        .foregroundStyle(.primary).accessibilityLabel("Настройки")
                }
            }
        }
        #endif
        .sheet(isPresented: $showEmployees) {
            EmployeePicker().environmentObject(client)
        }
        .sheet(isPresented: $showBotDetails) {
            if client.activeTelegramGroup != nil { TelegramChatsView() }
            else if let profile = client.activeProfile {
                BotDetailsView(profile: profile).environmentObject(client)
            }
        }
    }

    /// Messages and the composer share one column.
    private var chatInset: CGFloat {
        #if os(macOS)
        24
        #else
        8
        #endif
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy, animated: Bool) {
        Task { @MainActor in
            await Task.yield()
            if animated && !reduceMotion {
                withAnimation(.easeOut(duration: 0.22)) {
                    proxy.scrollTo("conversation-bottom", anchor: .bottom)
                }
            } else {
                proxy.scrollTo("conversation-bottom", anchor: .bottom)
            }
        }
    }
}

private struct OpenAIRecoveryNotice: View {
    @EnvironmentObject private var client: HomeClient
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var showAccounts = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if dynamicTypeSize.isAccessibilitySize {
                Text(client.openAIAccount?.isUnavailable == true ? "Связь с OpenAI" : "Вход в OpenAI")
                    .font(.callout.weight(.medium)).accessibilityIdentifier("openAIRecoveryNotice")
                Text("Чаты и черновики сохранены.").font(.caption).foregroundStyle(AppTheme.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                explanation
            }
            if client.openAIAccount?.isUnavailable == true {
                Button { Task { await client.refreshOpenAIAccount(force: true) } } label: { SetupActionLabel(title: "Проверить ещё раз") }
                    .adaptiveActionStyle(.glass).disabled(client.isLoading)
            } else if client.canManageOpenAI {
                Button { showAccounts = true } label: { SetupActionLabel(title: "Войти в OpenAI") }.adaptiveActionStyle(.glass)
                    .accessibilityIdentifier("recoverOpenAIAccount")
            } else if dynamicTypeSize.isAccessibilitySize {
                Button { showAccounts = true } label: { SetupActionLabel(title: "Как восстановить вход") }.adaptiveActionStyle(.glass)
            }
        }.frame(maxWidth: .infinity, alignment: .leading).padding(12)
            .background(.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 12))
            .fixedSize(horizontal: false, vertical: true)
            .sheet(isPresented: $showAccounts) { SettingsView(initialSection: .accounts) }
    }

    private var explanation: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(client.openAIAccount?.isUnavailable == true ? "Не удалось проверить соединение с OpenAI."
                 : "Вход в OpenAI нужно восстановить.").font(.callout.weight(.medium))
                .accessibilityIdentifier("openAIRecoveryNotice")
            Text(client.openAIRecoveryMessage).font(.caption).foregroundStyle(AppTheme.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct ConversationHeader: View {
    let openEmployee: () -> Void

    var body: some View {
        HStack {
            Spacer()
            ConversationTitle(openEmployee: openEmployee)
                .padding(.horizontal, 12)
                .padding(.vertical, 4)
                .glassEffect(.regular, in: .capsule)
            Spacer()
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 4)
    }

}

private struct ConversationTitle: View {
    @EnvironmentObject private var client: HomeClient
    let openEmployee: () -> Void
    private var chats: [TelegramChat] {
        (client.telegram?.chats ?? []).filter { !$0.isGroup && $0.profileId == client.selectedProfileID && $0.conversationId != nil }
    }
    private var importedChats: [ImportedConversation] { client.importedConversations.filter { $0.profileId == client.selectedProfileID } }
    private var chatName: String {
        if let chat = chats.first(where: { $0.conversationId == client.selectedChatID }) { return "Telegram · " + chat.title }
        if let chat = importedChats.first(where: { $0.id == client.selectedChatID }) { return "Архив · " + chat.title }
        return "В приложении"
    }
    var body: some View {
        VStack(spacing: 2) {
            if let group = client.activeTelegramGroup {
                Button(action: openEmployee) {
                    HStack(spacing: 8) {
                        Image(systemName: "person.2").foregroundStyle(AppTheme.accent)
                        VStack(spacing: 2) {
                            Text(group.title).font(.headline).lineLimit(1)
                            Text(group.enabled == false ? "Telegram · бот на паузе" : "Telegram")
                                .font(.caption).foregroundStyle(AppTheme.secondaryText)
                        }
                        Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    }.frame(minHeight: controlTarget).contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityLabel("Telegram · " + group.title)
            } else if client.activeProfile != nil {
                Button(action: openEmployee) {
                    HStack(spacing: 7) {
                        identity
                        Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    }.frame(minHeight: controlTarget).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Настройки сотрудника")
                .accessibilityValue(client.activeAgentName)
                .accessibilityIdentifier("openEmployeeDetails")
                .help("Открыть сотрудника «\(client.activeAgentName)»")
            } else {
                HStack(spacing: 7) { identity }.frame(minHeight: controlTarget)
            }
                if client.activeTelegramGroup == nil && (!chats.isEmpty || !importedChats.isEmpty) {
                    Menu {
                        Button { Task { await client.selectChat(nil) } } label: {
                            Label("В приложении", systemImage: client.selectedChatID == nil ? "checkmark" : "bubble.left")
                        }
                        ForEach(chats) { chat in
                            Button { Task { await client.selectChat(chat.conversationId) } } label: {
                                Label("Telegram · " + chat.title, systemImage: client.selectedChatID == chat.conversationId ? "checkmark" : "paperplane")
                            }
                        }
                        if !importedChats.isEmpty {
                            Section("Из экспорта") {
                                ForEach(importedChats) { chat in
                                    Button { Task { await client.selectChat(chat.id) } } label: {
                                        if client.selectedChatID == chat.id { Label(chat.title, systemImage: "checkmark") }
                                        else { Text(chat.title) }
                                    }
                                }
                            }
                        }
                    } label: { Label(chatName, systemImage: client.selectedChatID == nil ? "bubble.left" : importedChats.contains(where: { $0.id == client.selectedChatID }) ? "archivebox" : "paperplane").lineLimit(1) }
                        .font(.caption).foregroundStyle(AppTheme.secondaryText)
                        .menuStyle(.borderlessButton)
                        .frame(maxWidth: 260)
                        .accessibilityLabel("Выбрать переписку")
                        .accessibilityValue(client.activeAgentName + ", " + chatName)
                        .accessibilityIdentifier("chooseConversation")
                        .help("В приложении — разговор с вами. В Telegram — переписка с участниками группы.")
                }
        }.frame(minHeight: controlTarget).contentShape(Rectangle())
    }

    @ViewBuilder private var identity: some View {
        AgentAvatar(appearance: client.activeAppearance, size: 30)
        Text(client.activeAgentName).font(.headline).lineLimit(1)
    }
}

private struct EmptyChat: View {
    @EnvironmentObject private var library: DeviceLibrary
    @EnvironmentObject private var client: HomeClient
    @Environment(\.dynamicTypeSize) private var textSize
    var body: some View {
        VStack(spacing: 12) {
            AgentAvatar(appearance: client.activeAppearance, size: 72)
            Text(client.isEmployeeDraft ? "Создайте сотрудника" : client.activeProfile?.name ?? "Напишите, что нужно")
                .font(AppTypography.emptyTitle)
            if client.isEmployeeDraft {
                Text("Напишите, чем он должен заниматься. Например: «Редактор, который помогает писать короткие посты».")
                    .font(.subheadline)
                    .foregroundStyle(AppTheme.secondaryText)
                    .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: 360)
                if library.visibleClients.count > 1 || client.devices.count > 1 {
                    Menu {
                        ForEach(library.visibleClients) { source in
                            if source.devices.count > 1 {
                                ForEach(source.devices) { device in
                                    Button(device.name) { library.chooseEmployeeDevice(source, deviceID: device.id) }.disabled(!device.online)
                                }
                            } else {
                                Button(source.displayName) { library.chooseEmployeeDevice(source) }.disabled(source.homeUnreachable)
                            }
                        }
                    } label: {
                        Label(client.executionDeviceName, systemImage: "desktopcomputer").font(.callout)
                    }.menuStyle(.borderlessButton).fixedSize().padding(.top, 8).accessibilityLabel("Где будет работать сотрудник")
                }
            } else if client.homeUnreachable || client.connectionNeedsPairing {
                Text("История появится после подключения к устройству.")
                    .font(.subheadline).foregroundStyle(AppTheme.secondaryText).multilineTextAlignment(.center)
                    .frame(maxWidth: 360)
            } else if let profile = client.activeProfile {
                Text(profile.roleText.isEmpty ? "Напишите, что нужно." : profile.roleText)
                    .font(.subheadline).foregroundStyle(AppTheme.secondaryText).multilineTextAlignment(.center)
                    .frame(maxWidth: 360)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// Messages fade out under the header and above the composer instead of being cut.
private struct EdgeFade: View {
    var body: some View {
        VStack(spacing: 0) {
            LinearGradient(colors: [.clear, .black], startPoint: .top, endPoint: .bottom).frame(height: 18)
            Color.black
            LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom).frame(height: 18)
        }
    }
}

private struct DayDivider: View {
    let date: Date

    var body: some View {
        Text(ChatClock.day(date))
            .font(.caption.weight(.medium))
            .foregroundStyle(AppTheme.secondaryText)
            .frame(maxWidth: .infinity)
            .padding(.top, 6)
            .accessibilityAddTraits(.isHeader)
    }
}

private struct MessageBubble: View {
    @EnvironmentObject private var client: HomeClient
    @State private var previewURL: URL?
    let message: HomeMessage
    private var isUser: Bool { message.direction == "inbound" }

    var body: some View {
        if let scheduleTitle = message.scheduleTitle {
            VStack(alignment: .leading, spacing: 4) {
                Label(withTime(scheduleTitle), systemImage: "clock")
                    .font(.caption).foregroundStyle(AppTheme.secondaryText)
                if let error = message.error { Text(UserFacingError.text(error)).font(.caption).foregroundStyle(AppTheme.warning) }
            }.padding(.vertical, 4)
        } else if message.kind == "notice" {
            Label(withTime(message.text), systemImage: "checkmark")
                .font(.caption).foregroundStyle(AppTheme.secondaryText).padding(.vertical, 4)
        } else {
            HStack(alignment: .bottom) {
                if isUser { Spacer(minLength: 44) }
                VStack(alignment: isUser ? .trailing : .leading, spacing: 4) {
                    if message.imported == true, let author = message.author {
                        Text(author).font(.caption).foregroundStyle(AppTheme.secondaryText).padding(.horizontal, 6)
                    }
                    VStack(alignment: .leading, spacing: 9) {
                        if isUser && !message.text.isEmpty {
                            if message.imported == true { ImportedMessageText(source: message.text) }
                            else {
                                Text(message.text).font(ChatTypography.body)
                                    .lineSpacing(4).textSelection(.enabled)
                            }
                        }
                        else if !isUser { MessageContent(source: message.text).equatable() }
                        ForEach(message.attachments ?? []) { file in
                            if file.mimeType.hasPrefix("image/") {
                                ChatImage(name: file.name, identity: file.id) { try await client.downloadFile(file) }
                            } else {
                            Button {
                                Task { previewURL = await client.previewFile(file) }
                            } label: {
                                HStack(spacing: 10) {
                                    Image(systemName: file.icon).font(.title3).foregroundStyle(AppTheme.secondaryText)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(file.name).font(.callout.weight(.medium)).lineLimit(2)
                                        Text(file.sizeLabel).font(.caption).foregroundStyle(AppTheme.secondaryText)
                                    }
                                    Spacer(minLength: 8)
                                    Image(systemName: "arrow.down").font(.caption).foregroundStyle(.tertiary)
                                }.padding(10).background(.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 11))
                            }.buttonStyle(.plain).accessibilityLabel("Открыть " + file.name)
                            }
                        }
                    }
                    .padding(.horizontal, 16).padding(.vertical, 11)
                    .background(.primary.opacity(isUser ? 0.10 : 0.045), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    if let error = message.error { Text(UserFacingError.text(error)).font(.caption).foregroundStyle(AppTheme.warning).textSelection(.enabled) }
                    if !meta.isEmpty {
                        Text(meta).font(.caption2).foregroundStyle(AppTheme.metadataText).monospacedDigit().padding(.horizontal, 6)
                    }
                }
                if !isUser { Spacer(minLength: 12) }
            }
            .fixedSize(horizontal: false, vertical: true)
            .quickLookPreview($previewURL)
            .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
        }
    }

    private var meta: String {
        [message.status == "queued" ? "В очереди" : nil, message.time].compactMap { $0 }.joined(separator: " · ")
    }

    private func withTime(_ text: String) -> String {
        [text, message.time].compactMap { $0 }.joined(separator: " · ")
    }
}

private struct PendingMessageBubble: View {
    let text: String
    var files: [PickedFile] = []

    var body: some View {
        HStack {
            Spacer(minLength: 44)
            VStack(alignment: .leading, spacing: 8) {
                if !text.isEmpty { Text(text) }
                ForEach(files) { file in
                    if file.mimeType.hasPrefix("image/"), let image = ChatMedia.thumbnail(file.data, maxPixels: 600) {
                        Image(decorative: image, scale: 1).resizable().scaledToFit().frame(maxWidth: 280, maxHeight: 220)
                            .clipShape(RoundedRectangle(cornerRadius: 12)).accessibilityLabel(file.name)
                    } else { Label(file.name, systemImage: "doc").font(.callout).lineLimit(2) }
                }
            }
                .font(ChatTypography.body)
                .lineSpacing(4)
                .foregroundStyle(.primary)
                .padding(.horizontal, 16)
                .padding(.vertical, 11)
                .background(.primary.opacity(0.10), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        }
        .fixedSize(horizontal: false, vertical: true)
    }
}

private struct ThinkingBubble: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let name: String
    let appearance: AgentAppearance?

    var body: some View {
        HStack {
            HStack(spacing: 8) {
                AgentAvatar(appearance: appearance, size: 24)
                ProgressView().controlSize(.small).accessibilityHidden(true)
                Text(name + " работает")
                    .font(.subheadline)
                    .foregroundStyle(AppTheme.secondaryText)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .background(.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 15, style: .continuous))
            Spacer(minLength: 80)
        }
        .transition(.opacity)
    }
}

private struct Composer: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var textSize
    @Binding var draft: String
    @Binding var files: [PickedFile]
    @FocusState.Binding var focused: Bool
    let contextID: String
    let canSend: Bool
    let send: () -> Void
    @State private var showFiles = false
    @State private var showPhotos = false
    @State private var photoSelection: [PhotosPickerItem] = []
    @State private var fileError: String?
    @State private var importTask: Task<Void, Never>?
    @State private var importID = UUID()
    @State private var importing = false
    private var hasContent: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !files.isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if !files.isEmpty {
                ScrollView(.horizontal) {
                    HStack(spacing: 8) {
                        ForEach(files) { file in
                            HStack(spacing: 8) {
                                if file.mimeType.hasPrefix("image/"), let image = ChatMedia.thumbnail(file.data) {
                                    Image(decorative: image, scale: 1).resizable().scaledToFill()
                                        .frame(width: 48, height: 48).clipShape(RoundedRectangle(cornerRadius: 8))
                                } else { Image(systemName: "doc").foregroundStyle(AppTheme.secondaryText).frame(width: 28) }
                                Text(file.name).font(.caption).lineLimit(1)
                                Button { files.removeAll { $0.id == file.id } } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(AppTheme.secondaryText).frame(width: controlTarget, height: controlTarget).contentShape(Rectangle()) }
                                    .buttonStyle(.plain).accessibilityLabel("Убрать " + file.name)
                            }.padding(5).background(.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 12))
                        }
                    }.padding(.horizontal, 12).padding(.top, 9)
                }.scrollIndicators(.hidden)
            }
            HStack(alignment: .bottom, spacing: 9) {
            Menu {
                Button("Фото", systemImage: "photo") { showPhotos = true }
                Button("Прикрепить файл", systemImage: "paperclip") { showFiles = true }
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(AppTheme.secondaryText)
                    .frame(width: controlTarget, height: controlTarget).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(AppTheme.secondaryText)
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .frame(width: controlTarget, height: controlTarget)
            .accessibilityLabel("Прикрепить фото или файл")
            .help(files.count >= AttachmentImport.countLimit ? "Можно прикрепить до шести файлов" : "Прикрепить фото или файл до 25 МБ")
            .disabled(importing || files.count >= AttachmentImport.countLimit)

            TextField("Сообщение", text: $draft, axis: .vertical)
                .accessibilityLabel("Сообщение").accessibilityIdentifier("messageComposer")
                .textFieldStyle(.plain)
                .font(ChatTypography.body)
                .lineLimit(1...(textSize.isAccessibilitySize ? 2 : 6))
                .padding(.vertical, 8)
                .frame(minHeight: controlTarget)
                .focused($focused)
                #if os(macOS)
                .onKeyPress(.return, phases: .down) { press in
                    guard press.modifiers.contains(.shift),
                          let editor = NSApp.keyWindow?.firstResponder as? NSTextView else { return .ignored }
                    editor.insertNewlineIgnoringFieldEditor(nil)
                    return .handled
                }
                .help("Return отправляет сообщение. Shift+Return добавляет новую строку.")
                #endif
                .onSubmit { if canSend && hasContent && !importing { send() } }

            if importing {
                ProgressView().controlSize(.small).frame(width: controlTarget, height: controlTarget)
                    .accessibilityLabel("Добавляем файлы")
            } else {
                Button(action: send) {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(colorScheme == .dark ? Color.black : Color.white)
                        .frame(width: 30, height: 30)
                        .background(colorScheme == .dark ? Color.white : Color.black, in: Circle())
                        .frame(width: controlTarget, height: controlTarget)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(!canSend || !hasContent)
                .opacity(canSend && hasContent ? 1 : 0.4)
                .accessibilityLabel("Отправить")
                .accessibilityIdentifier("sendMessage")
                .help("Отправить сообщение (⌘Return)")
                .keyboardShortcut(.return, modifiers: .command)
            }
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 4)
        }
        .glassEffect(.regular, in: .rect(cornerRadius: 25))
        .photosPicker(isPresented: $showPhotos, selection: $photoSelection, maxSelectionCount: max(1, AttachmentImport.countLimit - files.count), matching: .images)
        .onChange(of: photoSelection) { _, selection in
            guard !selection.isEmpty else { return }
            let (id, context) = beginImport()
            importTask = Task {
                defer { if importID == id { importing = false; photoSelection = [] } }
                do {
                    var picked: [PickedFile] = []
                    for photo in selection {
                        guard let data = try await photo.loadTransferable(type: Data.self), !data.isEmpty else { throw AttachmentImport.Failure.empty }
                        guard data.count <= AttachmentImport.byteLimit else { throw AttachmentImport.Failure.tooLarge }
                        try Task.checkCancellation()
                        let type = photo.supportedContentTypes.first(where: { $0.conforms(to: .image) }) ?? .jpeg
                        picked.append(PickedFile(name: "Фото." + (type.preferredFilenameExtension ?? "jpg"), mimeType: type.preferredMIMEType ?? "image/jpeg", data: data))
                    }
                    completeImport(picked, id: id, context: context)
                } catch { reportImportError(error, id: id, context: context) }
            }
        }
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.data, .image, .pdf, .text, .audio], allowsMultipleSelection: true) { result in
            let (id, context) = beginImport()
            importTask = Task {
                defer { if importID == id { importing = false } }
                do {
                    let urls = try result.get()
                    guard files.count + urls.count <= AttachmentImport.countLimit else {
                        fileError = "Можно прикрепить до шести файлов. Уберите лишние файлы и попробуйте ещё раз."; return
                    }
                    let selection = try await AttachmentImport.files(at: urls)
                    completeImport(selection, id: id, context: context)
                } catch { reportImportError(error, id: id, context: context) }
            }
        }
        .onChange(of: contextID) { _, _ in cancelImport() }
        .onDisappear { cancelImport() }
        .alert("Не удалось добавить файл", isPresented: Binding(get: { fileError != nil }, set: { if !$0 { fileError = nil } })) { Button("Понятно", role: .cancel) {} } message: { Text(fileError ?? "") }
    }

    private func beginImport() -> (UUID, String) {
        importTask?.cancel()
        importID = UUID()
        importing = true
        fileError = nil
        return (importID, contextID)
    }

    private func completeImport(_ selection: [PickedFile], id: UUID, context: String) {
        guard importID == id, contextID == context, !Task.isCancelled else { return }
        guard files.count + selection.count <= AttachmentImport.countLimit else {
            fileError = "Можно прикрепить до шести файлов."; return
        }
        files.append(contentsOf: selection)
    }

    private func reportImportError(_ error: Error, id: UUID, context: String) {
        guard importID == id, contextID == context, !AttachmentImport.isCancellation(error), !Task.isCancelled else { return }
        fileError = (error as? AttachmentImport.Failure)?.errorDescription ?? "Не удалось открыть файл. Проверьте, что он доступен на устройстве, и выберите его ещё раз."
    }

    private func cancelImport() {
        importTask?.cancel()
        importID = UUID()
        importing = false
        photoSelection = []
        fileError = nil
        showFiles = false
        showPhotos = false
    }

}

private struct EmployeePicker: View {
    @EnvironmentObject private var library: DeviceLibrary
    @EnvironmentObject private var client: HomeClient
    @Environment(\.dismiss) private var dismiss

    @State private var query = ""
    @State private var showingSettings = false
    private var searchTerm: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var showsMain: Bool { searchTerm.isEmpty || "OpenStrudel".localizedCaseInsensitiveContains(searchTerm) }

    var body: some View {
        NavigationStack {
            List {
                if !showsMain && !library.visibleClients.contains(where: { source in source.profiles.contains { $0.name.localizedCaseInsensitiveContains(searchTerm) || $0.roleText.localizedCaseInsensitiveContains(searchTerm) } || source.telegramGroups.contains { $0.title.localizedCaseInsensitiveContains(searchTerm) } }) {
                    SearchEmptyState(query: query) { query = "" }
                }
                ForEach(library.visibleClients) { source in
                    let people = source.profiles.filter { searchTerm.isEmpty || $0.name.localizedCaseInsensitiveContains(searchTerm) || $0.roleText.localizedCaseInsensitiveContains(searchTerm) }
                    if showsMain || !people.isEmpty {
                    Section {
                        if showsMain {
                            EmployeePickerRow(name: "OpenStrudel", subtitle: source.displayName, selected: source === client && source.selectedProfileID == nil && source.selectedChatID == nil, appearance: nil) {
                                Task { await library.select(source, profile: nil); dismiss() }
                            }
                        }
                        ForEach(people) { profile in
                            EmployeePickerRow(name: profile.name, subtitle: profile.previewText.isEmpty ? profile.roleText : profile.previewText, selected: source === client && source.selectedProfileID == profile.id && source.activeTelegramGroup == nil, appearance: profile.resolvedAppearance) {
                                Task { await library.select(source, profile: profile.id); dismiss() }
                            }
                        }
                    } header: { if library.hasOtherDevices { Text(source.displayName) } }
                    }
                    let groups = source.telegramGroups.filter { searchTerm.isEmpty || $0.title.localizedCaseInsensitiveContains(searchTerm) }
                    if !groups.isEmpty {
                        Section(library.hasOtherDevices ? "Telegram · " + source.displayName : "Telegram") {
                            ForEach(groups) { group in
                                EmployeePickerRow(name: group.title, subtitle: group.enabled == false ? "Бот на паузе" : "Группа в Telegram",
                                                  selected: source === client && source.selectedChatID == group.conversationId,
                                                  appearance: nil, symbol: "person.2") {
                                    Task { await library.select(source, group: group); dismiss() }
                                }.accessibilityIdentifier("telegramConversation-" + group.chatId)
                            }
                        }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(HomeBackground())
            .navigationTitle("Чаты")
            #if os(iOS)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Найти чат")
            #else
            .searchable(text: $query, prompt: "Найти чат")
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    HStack(spacing: 16) {
                        Button { showingSettings = true } label: { Image(systemName: "gearshape") }
                            .accessibilityLabel("Настройки").accessibilityIdentifier("teamSettings")
                        Button { library.beginEmployee(); dismiss() } label: { Image(systemName: "plus") }
                            .accessibilityLabel("Новый сотрудник")
                    }
                }
                ToolbarItem(placement: .cancellationAction) { Button("Готово") { dismiss() } }
            }
        }
        .sheet(isPresented: $showingSettings) { SettingsView().environmentObject(client) }
    }
}

private struct EmployeePickerRow: View {
    @Environment(\.dynamicTypeSize) private var textSize
    let name: String
    let subtitle: String
    let selected: Bool
    let appearance: AgentAppearance?
    var symbol: String? = nil
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 11) {
                if !textSize.isAccessibilitySize {
                    if let symbol { Image(systemName: symbol).font(.title2).foregroundStyle(AppTheme.accent).frame(width: 42, height: 42) }
                    else { AgentAvatar(appearance: appearance, size: 42) }
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(name).font(.body.weight(.medium)).lineLimit(textSize.isAccessibilitySize ? nil : 2)
                    if !subtitle.isEmpty { Text(subtitle).font(.caption).foregroundStyle(AppTheme.secondaryText).lineLimit(1) }
                }
                Spacer(minLength: 0)
                if selected { Image(systemName: "checkmark").foregroundStyle(AppTheme.secondaryText) }
            }
            .padding(.vertical, 5)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(name)
        .accessibilityValue(subtitle)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

private struct SearchEmptyState: View {
    let query: String
    let clear: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Ничего не найдено").font(.headline)
            Text("Нет совпадений для «\(query)». Проверьте название или очистите поиск.")
                .font(.callout).foregroundStyle(AppTheme.secondaryText).fixedSize(horizontal: false, vertical: true)
            Button("Очистить поиск", action: clear).frame(minHeight: controlTarget)
        }.padding(.vertical, 16).accessibilityIdentifier("searchEmptyState")
    }
}

private struct BotDetailsView: View {
    @EnvironmentObject private var client: HomeClient
    @Environment(\.dismiss) private var dismiss
    let profile: EmployeeProfile
    @State private var name: String
    @State private var instructions: String
    @State private var appearance: AgentAppearance
    @State private var showConnections = false
    @State private var showTelegram = false
    @State private var isSaving = false
    @State private var confirmDiscard = false
    @State private var saveError: String?
    private var hasChanges: Bool { name != profile.name || instructions != profile.instructions || appearance != profile.resolvedAppearance }

    init(profile: EmployeeProfile) {
        self.profile = profile
        _name = State(initialValue: profile.name)
        _instructions = State(initialValue: profile.instructions)
        _appearance = State(initialValue: profile.resolvedAppearance)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                HStack(spacing: 12) {
                    AgentAvatar(appearance: appearance, size: 72)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Имя").font(.caption).foregroundStyle(AppTheme.secondaryText)
                        TextField("Имя сотрудника", text: $name).textFieldStyle(.plain).font(.title2.weight(.semibold))
                    }
                }
                Button { showConnections = true } label: {
                    HStack {
                        Label("Сервисы и навыки", systemImage: "link")
                        Spacer()
                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                    }.frame(minHeight: controlTarget).contentShape(Rectangle())
                }.buttonStyle(.plain)
                Button { showTelegram = true } label: {
                    HStack {
                        Label("Telegram", systemImage: "paperplane")
                        Spacer()
                        Text((client.telegram?.chats ?? []).filter { $0.profileId == profile.id }.map(\.title).joined(separator: ", "))
                            .font(.caption).foregroundStyle(AppTheme.secondaryText).lineLimit(1)
                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                    }.frame(minHeight: controlTarget).contentShape(Rectangle())
                }.buttonStyle(.plain)
                Divider()
                if client.health?.agentAppearanceVersion == 1 {
                    DisclosureGroup("Образ сотрудника") {
                        AgentAppearancePicker(selection: $appearance).padding(.top, 12)
                    }
                }
                VStack(alignment: .leading, spacing: 8) {
                    Text("Чем занимается сотрудник").font(.subheadline.weight(.medium))
                    Text("Опишите задачи и правила, которым он должен следовать.")
                        .font(.caption).foregroundStyle(AppTheme.secondaryText)
                    TextEditor(text: $instructions).font(.body).scrollContentBackground(.hidden)
                        .frame(height: 180).padding(10)
                        .background(.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 12))
                        .accessibilityLabel("Описание сотрудника")
                }
                if !client.schedules.isEmpty {
                    Divider()
                    Text("Расписание").font(.subheadline.weight(.medium))
                }
                if client.health?.homeProtocol == 1 { AgentAccountPreference(profile: profile) }
                ForEach(client.schedules.filter(\.enabled)) { schedule in
                    Toggle(isOn: Binding(get: { schedule.enabled }, set: { value in Task { await client.setSchedule(schedule, enabled: value) } })) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(schedule.name).font(.callout.weight(.medium))
                            Text(schedule.timing).font(.caption).foregroundStyle(AppTheme.secondaryText)
                        }
                    }
                }
                if client.schedules.contains(where: { !$0.enabled }) {
                    DisclosureGroup("Приостановленные") {
                        ForEach(client.schedules.filter { !$0.enabled }) { schedule in
                            Toggle(schedule.name, isOn: Binding(get: { schedule.enabled }, set: { value in Task { await client.setSchedule(schedule, enabled: value) } })).font(.callout)
                        }
                    }
                }
                if let failed = client.scheduleRuns.first, let error = failed.error {
                    Text(UserFacingError.text(error)).font(.caption).foregroundStyle(AppTheme.warning)
                }
                if let saveError {
                    Text(saveError).font(.callout).foregroundStyle(AppTheme.warning)
                        .accessibilityIdentifier("employeeSaveError")
                }
            }
            .padding(24)
            }
            .background(HomeBackground())
            .navigationTitle("Сотрудник")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена") { if hasChanges { confirmDiscard = true } else { dismiss() } }
                        .disabled(isSaving).keyboardShortcut(.cancelAction)
                        .accessibilityIdentifier("cancelEmployeeChanges")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "Сохраняем…" : hasChanges ? "Сохранить" : "Готово") {
                        guard hasChanges else { dismiss(); return }
                        isSaving = true
                        saveError = nil
                        Task {
                            let saved = await client.updateProfile(id: profile.id, name: name, instructions: instructions, appearance: appearance != profile.resolvedAppearance ? appearance : nil)
                            isSaving = false
                            if saved { dismiss() }
                            else { saveError = client.errorMessage ?? "Не удалось сохранить изменения. Попробуйте ещё раз."; client.errorMessage = nil }
                        }
                    }.disabled(isSaving || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .keyboardShortcut(.defaultAction).accessibilityIdentifier("saveEmployeeChanges")
                }
            }
            .interactiveDismissDisabled(hasChanges || isSaving)
            .alert("Не сохранять изменения?", isPresented: $confirmDiscard) {
                Button("Не сохранять", role: .destructive) { dismiss() }
                Button("Продолжить редактирование", role: .cancel) {}
            } message: { Text("Имя, образ и описание сотрудника останутся прежними.") }
            .navigationDestination(isPresented: $showConnections) { ConnectionsView(embedded: true) }
            .navigationDestination(isPresented: $showTelegram) { TelegramChatsView(profile: profile, embedded: true) }
            .task { await client.loadChatSettings() }
        }
        #if os(macOS)
        .frame(width: 540, height: 640)
        #endif
    }
}

struct SectionTitle: View {
    let title: String
    let subtitle: String
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.headline)
            Text(subtitle).font(.caption).foregroundStyle(AppTheme.secondaryText)
        }
        .padding(.top, 8)
    }
}

private struct OpenAISettingsCard: View {
    @EnvironmentObject private var client: HomeClient
    @Environment(\.openURL) private var openURL
    @State private var copiedCode = false
    var showIdentity = true

    var body: some View {
        if showIdentity { content.settingsCard() }
        else { content }
    }

    private var content: some View {
        let connected = client.openAIAccount?.connected == true
        return VStack(alignment: .leading, spacing: 16) {
            if showIdentity {
            HStack(spacing: 12) {
                AccountBadge(email: client.openAIAccount?.email, size: 36)
                VStack(alignment: .leading, spacing: 3) {
                    if let account = client.openAIAccount, account.connected {
                        Text(account.email ?? "OpenAI").font(.subheadline.weight(.medium))
                            .accessibilityLabel("Аккаунт OpenAI").accessibilityValue(account.email ?? "OpenAI").accessibilityIdentifier("openAIAccountIdentity")
                        Text(planTitle(account.planType)).font(.caption).foregroundStyle(AppTheme.secondaryText)
                    } else if client.openAIAccount?.isUnavailable == true {
                        Text("Нет связи с OpenAI").font(.subheadline.weight(.medium))
                        Text("Повторный вход пока не нужен").font(.caption).foregroundStyle(AppTheme.secondaryText)
                    } else {
                        Text("Аккаунт не подключён").font(.subheadline.weight(.medium))
                        Text("Войдите в свой аккаунт OpenAI").font(.caption).foregroundStyle(AppTheme.secondaryText)
                    }
                    if client.openAIAccount?.isUnavailable != true { ConnectionStatus(connected: connected) }
                }
                Spacer()
            }
            }

            if let error = client.openAIErrorMessage {
                Text(UserFacingError.text(error)).font(.callout).foregroundStyle(AppTheme.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if showIdentity && !connected && client.canManageOpenAI {
                Text(client.openAIRecoveryMessage).font(.callout).foregroundStyle(AppTheme.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if client.openAIAccount?.isUnavailable == true && client.openAILogin == nil && !client.openAILoginPending {
                Button { Task { await client.refreshOpenAIAccount(force: true) } } label: {
                    SetupActionLabel(title: "Проверить ещё раз", icon: "arrow.clockwise")
                }.adaptiveActionStyle(.glass).controlSize(.large)
                    .accessibilityIdentifier("retryOpenAIAccount")
            } else if !client.canManageOpenAI {
                if showIdentity {
                Text(connected ? "Используется аккаунт устройства, на котором работает сотрудник."
                     : client.openAIRecoveryMessage)
                    .font(.callout).foregroundStyle(AppTheme.secondaryText).fixedSize(horizontal: false, vertical: true)
                }
            } else if let login = client.openAILogin {
                VStack(alignment: .leading, spacing: 8) {
                    if login.type == "device", let code = login.userCode {
                        Text("Введите этот код на сайте OpenAI").font(.callout).foregroundStyle(AppTheme.secondaryText)
                        Text(code).font(.system(.title3, design: .monospaced).weight(.semibold)).textSelection(.enabled)
                            .accessibilityLabel("Код для входа: " + code)
                            .accessibilityIdentifier("openAIDeviceCode")
                        Button {
                            #if os(macOS)
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(code, forType: .string)
                            #else
                            UIPasteboard.general.string = code
                            #endif
                            copiedCode = true
                        } label: { SetupActionLabel(title: copiedCode ? "Код скопирован" : "Скопировать код", icon: copiedCode ? "checkmark" : "doc.on.doc") }
                            .adaptiveActionStyle(.glass).accessibilityIdentifier("copyOpenAICode")
                        DisclosureGroup("Не получается войти?") {
                            Text("В ChatGPT откройте «Настройки», затем «Безопасность» и разрешите вход по коду устройства. Для рабочего аккаунта может понадобиться помощь администратора. Если код истёк, отмените вход здесь и начните снова.")
                                .font(.callout).foregroundStyle(AppTheme.secondaryText).fixedSize(horizontal: false, vertical: true)
                        }.padding(.vertical, 4)
                    } else {
                        Text("Откройте страницу OpenAI и завершите вход.").font(.caption).foregroundStyle(AppTheme.secondaryText)
                    }
                    if let url = login.url {
                        Button { openURL(url) } label: { SetupActionLabel(title: "Открыть OpenAI", icon: "arrow.up.right") }
                            .adaptiveActionStyle(.glassProminent).accessibilityIdentifier("reopenOpenAILogin")
                    }
                    Button { Task { await client.cancelOpenAILogin() } } label: {
                        SetupActionLabel(title: "Отменить вход")
                    }.adaptiveActionStyle(.glass).controlSize(.large).accessibilityIdentifier("cancelOpenAILogin")
                }
            } else if client.openAILoginPending {
                Text("Вход открыт на другом устройстве. Завершите его на сайте OpenAI. Это окно обновится автоматически.")
                    .font(.callout).foregroundStyle(AppTheme.secondaryText).fixedSize(horizontal: false, vertical: true)
            } else if connected {
                Button { Task { await client.beginOpenAILogin() } } label: {
                    SetupActionLabel(title: client.isStartingOpenAILogin ? "Открываем OpenAI…" : "Сменить аккаунт")
                }.adaptiveActionStyle(.glass).controlSize(.large).disabled(client.isStartingOpenAILogin)
            } else if client.canManageOpenAI {
                Button { Task { await client.beginOpenAILogin() } } label: {
                    SetupActionLabel(title: client.isStartingOpenAILogin ? "Открываем OpenAI…" : "Войти в OpenAI", icon: "arrow.up.right")
                }.adaptiveActionStyle(.glassProminent).controlSize(.large)
                    .disabled(client.isStartingOpenAILogin)
                    .accessibilityIdentifier("signInOpenAI")
            }
        }
        .onChange(of: client.openAILogin?.id) { _, _ in copiedCode = false }
    }

    private func planTitle(_ raw: String?) -> String {
        let value = raw?.lowercased() ?? ""
        if value.contains("business") { return "ChatGPT Business" }
        if value.contains("enterprise") { return "ChatGPT Enterprise" }
        if value.contains("pro") { return "ChatGPT Pro" }
        if value.contains("plus") { return "ChatGPT Plus" }
        return "ChatGPT"
    }
}

private struct OpenAIWelcomeView: View {
    @EnvironmentObject private var client: HomeClient
    @Environment(\.openURL) private var openURL
    var body: some View {
        ScrollView {
        VStack(spacing: 24) {
            OpenStrudelMark(size: 76)
            VStack(spacing: 12) {
                Text(client.openAIAccount?.isUnavailable == true ? "Нет связи с OpenAI"
                     : !client.canManageOpenAI ? "Нужен вход владельца"
                     : client.openAIAccount?.needsSignInAgain == true ? "Войдите в OpenAI снова"
                     : "Подключите OpenAI")
                    .font(AppTypography.welcome).multilineTextAlignment(.center)
                Text(client.openAIAccount?.isUnavailable == true
                     ? "Проверьте подключение к интернету и попробуйте ещё раз. Ваши чаты и сотрудники сохранены."
                     : !client.canManageOpenAI ? client.openAIRecoveryMessage
                     : client.openAIAccount?.needsSignInAgain == true
                     ? "Сохранённый вход больше не действует. Войдите снова для сотрудников этого устройства."
                     : "Войдите на сайте OpenAI. Этот аккаунт будут использовать сотрудники на «\(client.displayName)».")
                    .font(.body).foregroundStyle(AppTheme.secondaryText).multilineTextAlignment(.center)
            }
            OpenAISettingsCard(showIdentity: false)
        }.padding(32).frame(maxWidth: 480).frame(maxWidth: .infinity)
        }.defaultScrollAnchor(.center, for: .alignment)
        .onChange(of: client.openAILogin) { _, login in if let url = login?.url { openURL(url) } }
        .task(id: client.openAILogin?.loginId) {
            guard client.openAILogin != nil else { return }
            while !Task.isCancelled && client.openAILogin != nil {
                try? await Task.sleep(for: .seconds(1))
                await client.pollOpenAILogin()
            }
        }
    }
}

private struct TelegramChatsView: View {
    @EnvironmentObject private var client: HomeClient
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var textSize
    var profile: EmployeeProfile? = nil
    var embedded = false
    @State private var busyGroup: String?
    @State private var error: String?
    @State private var showAccounts = false
    @State private var showConnections = false
    private var groups: [TelegramChat] { (client.telegram?.chats ?? []).filter(\.isGroup) }

    var body: some View {
        Group {
            if embedded { content }
            else { NavigationStack { content } }
        }
        #if os(macOS)
        .frame(minWidth: embedded ? nil : 520, minHeight: embedded ? nil : 520)
        #endif
    }

    private var content: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                if let group = client.activeTelegramGroup {
                    VStack(alignment: .leading, spacing: 16) {
                        Label("Группа в Telegram", systemImage: "person.2").foregroundStyle(AppTheme.secondaryText)
                        Text(groupDescription(group)).font(.headline)
                        if group.enabled != false {
                            Text(group.replies == "mentions" ? "Отвечает на @упоминание и ответы боту" : "Отвечает по правилам сотрудника")
                                .font(.callout).foregroundStyle(AppTheme.secondaryText)
                        }
                        Divider()
                        Button { showConnections = true } label: { Label("Сервисы и навыки", systemImage: "link") }
                            .accessibilityIdentifier("telegramGroupServices")
                        groupAction(group)
                    }
                } else { TelegramSetupView() }
                if client.telegram?.configured == true && client.openAIAccount?.connected == false {
                    VStack(alignment: .leading, spacing: 10) {
                        Text(client.openAIAccount?.isUnavailable == true
                             ? "Не удалось проверить OpenAI. Подключение Telegram сохранено."
                             : "Войдите в OpenAI, чтобы помощник мог отвечать.")
                            .font(.callout)
                        Button("Аккаунты OpenAI") { showAccounts = true }
                            .accessibilityIdentifier("telegramOpenAIAccounts")
                    }.settingsCard()
                }
                if client.activeTelegramGroup == nil && !groups.isEmpty {
                    Divider()
                    VStack(alignment: .leading, spacing: 16) {
                        Text("Группы").font(.headline)
                        ForEach(groups) { chat in
                            VStack(alignment: .leading, spacing: 10) {
                              HStack(alignment: .top, spacing: 12) {
                                Image(systemName: "person.2").foregroundStyle(AppTheme.accent).padding(.top, 3)
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(chat.title).font(.body.weight(.medium))
                                    Text(groupDescription(chat)).font(.callout).foregroundStyle(AppTheme.secondaryText)
                                    if chat.enabled != false {
                                        Text(chat.replies == "mentions" ? "Отвечает на @упоминание и ответы боту" : "Отвечает по правилам сотрудника")
                                            .font(.caption).foregroundStyle(AppTheme.secondaryText)
                                    }
                                }
                                Spacer(minLength: 8)
                                if !textSize.isAccessibilitySize { groupAction(chat) }
                              }
                              if textSize.isAccessibilitySize { groupAction(chat) }
                            }
                        }
                    }
                }
                if let error { Text(error).foregroundStyle(AppTheme.destructive).font(.callout) }
            }.padding(24)
        }
        .background(HomeBackground()).navigationTitle(client.activeTelegramGroup?.title ?? "Telegram")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                if !embedded { Button("Готово") { dismiss() } }
            }
        }
        .navigationDestination(isPresented: $showAccounts) {
            ScrollView { DeviceAccountsView().padding(24) }.navigationTitle("Аккаунты OpenAI")
        }
        .navigationDestination(isPresented: $showConnections) { ConnectionsView(embedded: true) }
    }

    @ViewBuilder private func groupAction(_ chat: TelegramChat) -> some View {
        if busyGroup == chat.chatId { ProgressView().controlSize(.small) }
        else {
            Button(chat.enabled == false ? "Продолжить" : "Приостановить") { toggle(chat) }
                .disabled(busyGroup != nil)
                .accessibilityLabel((chat.enabled == false ? "Продолжить в группе «" : "Приостановить в группе «") + chat.title + "»")
                .accessibilityIdentifier("toggleTelegramGroup-" + chat.chatId)
        }
    }

    private func groupDescription(_ chat: TelegramChat) -> String {
        if chat.enabled == false { return "На паузе · переписка сохранена" }
        if let name = client.profiles.first(where: { $0.id == chat.profileId })?.name { return "Отвечает «\(name)»" }
        return "Помощник сам подбирает сотрудника по задаче"
    }

    private func toggle(_ chat: TelegramChat) {
        busyGroup = chat.chatId; error = nil
        Task {
            defer { busyGroup = nil }
            do { try await client.setTelegramGroupEnabled(chat.chatId, enabled: chat.enabled == false) }
            catch { self.error = UserFacingError.text(error.localizedDescription) }
        }
    }
}

private struct TelegramSettingsCard: View {
    @EnvironmentObject private var client: HomeClient
    @Environment(\.dynamicTypeSize) private var textSize
    @State private var showChats = false
    @State private var confirmDisconnect = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Image(systemName: "paperplane.fill").foregroundStyle(AppTheme.secondaryText)
                VStack(alignment: .leading, spacing: 4) {
                    Text(client.telegram?.botUsername.map { "@" + $0 } ?? "Telegram")
                        .font(.subheadline.weight(.medium))
                    if client.telegram?.configured == true { ConnectionStatus(connected: client.telegram?.running == true) }
                }
                Spacer()
            }
            if let telegram = client.telegram, telegram.configured {
                if let url = client.telegramLink?.url {
                    Link(destination: url) { AdaptiveActionLabel(title: "Открыть Telegram") }
                        .adaptiveActionStyle(.borderedProminent)
                    Text("В Telegram нажмите «Начать», чтобы продолжить разговор.")
                        .font(.callout).foregroundStyle(AppTheme.secondaryText)
                }
                if textSize.isAccessibilitySize {
                    VStack(alignment: .leading, spacing: 8) { telegramActions }
                } else {
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 8) { telegramActions.fixedSize(horizontal: true, vertical: false) }
                        VStack(alignment: .leading, spacing: 8) { telegramActions }
                    }
                }
            } else {
                TelegramSetupView()
            }
        }
        .settingsCard()
        .sheet(isPresented: $showChats) { TelegramChatsView() }
        .confirmationDialog("Отключить Telegram?", isPresented: $confirmDisconnect, titleVisibility: .visible) {
            Button("Отключить Telegram", role: .destructive) { Task { await client.disconnectTelegram() } }
            Button("Отмена", role: .cancel) {}
        } message: { Text("Сотрудники перестанут отвечать в Telegram. Переписка в OpenStrudel сохранится.") }
    }

    @ViewBuilder private var telegramActions: some View {
        Button { Task { await client.createTelegramLink() } } label: {
            AdaptiveActionLabel(title: client.telegramLink == nil ? "Продолжить в Telegram" : "Обновить приглашение")
        }
            .font(.body).adaptiveActionStyle(.bordered).controlSize(.large)
        if !(client.telegram?.chats ?? []).isEmpty {
            Button { showChats = true } label: { AdaptiveActionLabel(title: "Чаты") }
                .font(.body).adaptiveActionStyle(.bordered).controlSize(.large)
        }
        Button(role: .destructive) { confirmDisconnect = true } label: { AdaptiveActionLabel(title: "Отключить") }
            .font(.body).adaptiveActionStyle(.bordered).controlSize(.large)
            .tint(AppTheme.destructive)
    }
}

/// The same quiet status on every connection card.
struct ConnectionStatus: View {
    let connected: Bool

    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(connected ? Color.green : Color.secondary.opacity(0.4)).frame(width: 7, height: 7)
                .accessibilityHidden(true)
            Text(connected ? "Подключён" : "Не подключён")
        }
        .font(.caption)
        .foregroundStyle(AppTheme.secondaryText)
    }
}

private struct AccountBadge: View {
    let email: String?
    let size: CGFloat

    var body: some View {
        Circle()
            .fill(.primary.opacity(0.14))
            .frame(width: size, height: size)
            .overlay {
                Text(String((email ?? "O").prefix(1)).uppercased())
                    .font(.system(size: size * 0.42, weight: .semibold))
                    .foregroundStyle(AppTheme.secondaryText)
            }
            .accessibilityHidden(true)
    }
}

extension View {
    func settingsCard() -> some View {
        padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.primary.opacity(0.07), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}

struct OpenStrudelMark: View {
    @Environment(\.colorScheme) private var appearance
    let size: CGFloat

    var body: some View {
        Image(appearance == .dark ? "DockGraphite" : "DockCream")
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

struct HomeBackground: View {
    var body: some View { AppTheme.canvas.ignoresSafeArea() }
}

private struct InteractionCard: View {
    @EnvironmentObject private var client: HomeClient
    @Environment(\.openURL) private var openURL
    let interaction: ChatInteraction
    @State private var answers: [String: String] = [:]
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(interaction.title).font(.headline)
            if let detail = interaction.detail, !detail.isEmpty {
                Text(detail).font(.subheadline).foregroundStyle(AppTheme.secondaryText).textSelection(.enabled)
            }
            if let raw = interaction.url, let url = URL(string: raw) {
                Button("Открыть подключение", systemImage: "arrow.up.right") { openURL(url) }
                    .buttonStyle(.bordered)
            }
            ForEach(interaction.questions) { question in
                if !question.question.isEmpty { Text(question.question).font(.subheadline) }
                if question.options.isEmpty {
                    TextField("Ваш ответ", text: Binding(get: { answers[question.id] ?? "" }, set: { answers[question.id] = $0 }))
                        .textFieldStyle(.roundedBorder)
                        .accessibilityLabel(question.question.isEmpty ? "Ваш ответ" : question.question)
                        .frame(minHeight: controlTarget)
                } else {
                    // Short choices sit side by side; long ones stack.
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 8) { options(for: question) }
                        VStack(alignment: .leading, spacing: 6) { options(for: question) }
                    }
                }
            }
            if interaction.questions.count > 1 || interaction.questions.first?.options.isEmpty == true {
                Button("Продолжить") { submit() }
                    .disabled(busy || interaction.questions.contains { (answers[$0.id] ?? "").isEmpty })
            }
            if busy { ProgressView().controlSize(.small) }
            if let error { Text(UserFacingError.text(error)).font(.caption).foregroundStyle(AppTheme.warning) }
        }
        .padding(18).frame(maxWidth: 480, alignment: .leading)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 20))
        .overlay { RoundedRectangle(cornerRadius: 20).stroke(.primary.opacity(0.08)) }
        .padding(.vertical, 8)
    }
    private func options(for question: ChatQuestion) -> some View {
        ForEach(question.options, id: \.self) { option in
            Button {
                answers[question.id] = option
                if interaction.questions.count == 1 { submit() }
            } label: {
                HStack {
                    Text(option).fixedSize(horizontal: false, vertical: true)
                    if interaction.questions.count > 1 && answers[question.id] == option { Image(systemName: "checkmark") }
                }.frame(minHeight: controlTarget)
            }.buttonStyle(.bordered).disabled(busy)
        }
    }

    private func submit() {
        busy = true; error = nil
        Task {
            do { try await client.answer(interaction, answers: answers) }
            catch { self.error = error.localizedDescription }
            busy = false
        }
    }
}

private struct ConnectionsView: View {
    @EnvironmentObject private var client: HomeClient
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var textSize
    var embedded = false
    @State private var query = ""
    @State private var loading = true
    @State private var error: String?
    @State private var connecting: String?
    @State private var waiting: ServiceConnection?
    @State private var authorizationURL: URL?
    @State private var notice: String?
    @State private var availableConnections: [ServiceConnection] = []
    @State private var extensions: [EmployeeExtension] = []
    @State private var contexts: [ExtensionContext] = []
    @State private var scopeID = ""
    @State private var showAdd = false
    @State private var extensionNotice: String?
    @State private var changing = false
    @State private var pendingRemoval: EmployeeExtension?
    @State private var pendingMCPRemoval: ServiceConnection?
    @State private var refreshID = UUID()
    private var scope: ExtensionContext? { contexts.first { $0.id == scopeID } }
    private var results: [ServiceConnection] {
        availableConnections.filter { !$0.isAvailableToAdd && (query.isEmpty || $0.name.localizedCaseInsensitiveContains(query)) }
            .sorted { $0.connected != $1.connected ? $0.connected : $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }
    var body: some View {
        Group {
            if embedded { content }
            else { NavigationStack { content } }
        }
        #if os(macOS)
        .frame(minWidth: embedded ? nil : 560, minHeight: embedded ? nil : 570)
        #endif
    }

    private var servicesList: some View {
            List {
                connectionHeader
                if availableConnections.filter({ !$0.isAvailableToAdd }).count > 6 {
                    TextField("Найти подключение", text: $query)
                        .textFieldStyle(.roundedBorder).accessibilityLabel("Найти подключение")
                }
                extensionRows
                connectionRows

            }
            .scrollContentBackground(.hidden)
            .background(HomeBackground()).navigationTitle("Сервисы и навыки")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if !embedded { Button("Готово") { dismiss() } }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button { Task { await refresh() } } label: { Image(systemName: "arrow.clockwise") }
                        .accessibilityLabel("Обновить сервисы").disabled(loading)
                }
            }

    }

    private var content: some View {
        servicesList
        .navigationDestination(isPresented: $showAdd) {
            if let scope { ConnectionCatalogView(scope: scope, isPresented: $showAdd) }
        }
        .onChange(of: showAdd) { wasPresented, isPresented in
            if wasPresented && !isPresented { Task { await refresh() } }
        }
        .confirmationDialog("Удалить расширение?", isPresented: Binding(get: { pendingRemoval != nil || pendingMCPRemoval != nil }, set: { if !$0 { pendingRemoval = nil; pendingMCPRemoval = nil } }), titleVisibility: .visible) {
            if let item = pendingRemoval { Button("Удалить «\(item.name)»", role: .destructive) { updateExtension(item); pendingRemoval = nil } }
            if let item = pendingMCPRemoval { Button("Удалить «\(item.name)»", role: .destructive) { removeMCP(item); pendingMCPRemoval = nil } }
            Button("Отмена", role: .cancel) { pendingRemoval = nil; pendingMCPRemoval = nil }
        } message: { Text("Переписка и файлы сотрудника сохранятся.") }
        .task { await loadContexts() }
        .task(id: scopeID) { await loadScope() }
        .task(id: waiting?.id) { await pollAuthorization() }
        .onChange(of: scenePhase) { old, phase in
            if old != .active && phase == .active && !loading { Task { await refresh() } }
        }
    }

    private func loadContexts() async {
        do { contexts = try await client.extensionContexts(); scopeID = client.conversationID ?? "" }
        catch { self.error = "Не удалось определить чат. Вернитесь к переписке и откройте сервисы снова."; loading = false }
    }

    private func loadScope() async {
        guard !scopeID.isEmpty else { return }
        availableConnections = []; extensions = []; waiting = nil; authorizationURL = nil; notice = nil
        await refresh(force: false)
    }

    private func pollAuthorization() async {
        guard waiting != nil else { return }
        for _ in 0..<30 {
            do { try await Task.sleep(for: .seconds(2)) } catch { return }
            if !loading { await refresh() }
            if waiting == nil { return }
        }
    }

    @ViewBuilder private var extensionRows: some View {
                if !extensions.isEmpty {
                    Section("Навыки и плагины") {
                        ForEach(extensions.filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) }) { item in
                            VStack(alignment: .leading, spacing: 8) {
                                if item.removable && (client.canManageConnections || client.canManageOpenAI) {
                                    Toggle(item.name, isOn: Binding(get: { item.enabled }, set: { enabled in
                                        updateExtension(item, enabled: enabled)
                                    })).disabled(changing || loading)
                                } else { Label(item.name, systemImage: item.enabled ? "checkmark.circle" : "pause.circle") }
                                Text(item.description).font(.caption).foregroundStyle(AppTheme.secondaryText).lineLimit(3)
                                if item.removable && (client.canManageConnections || client.canManageOpenAI) {
                                    Button("Удалить…", role: .destructive) { pendingRemoval = item }.buttonStyle(.borderless).font(.caption).disabled(changing)
                                }
                            }.padding(.vertical, 6)
                        }
                    }
                }

    }

    @ViewBuilder private var connectionRows: some View {
                ForEach(results) { connection in
                    serviceRow(connection)
                    .contextMenu {
                        if connection.removable == true && (client.canManageConnections || client.canManageOpenAI) {
                            Button("Удалить подключение…", role: .destructive) { pendingMCPRemoval = connection }
                        }
                    }
                }
                if results.isEmpty && !query.isEmpty { SearchEmptyState(query: query) { query = "" } }
                else if results.isEmpty && !loading && error == nil {
                    Text(extensions.isEmpty ? "Пока без подключений. Нажмите «Добавить», чтобы сотрудник мог работать с вашими сервисами." : "Другие сервисы можно подключить через «Добавить».")
                        .foregroundStyle(AppTheme.secondaryText)
                }

    }

    private var connectionHeader: some View {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Для «\(client.activeAgentName)» · \(client.executionDeviceName)")
                        .font(.callout).foregroundStyle(AppTheme.secondaryText)
                    Label(scope?.isGroup == true ? "Telegram · " + (scope?.title ?? "Группа") : "В приложении", systemImage: scope?.isGroup == true ? "paperplane" : "bubble.left")
                        .font(.headline)
                    if scope?.isGroup == true { Text("Подключения для этой группы.").font(.caption).foregroundStyle(AppTheme.secondaryText) }
                    if let shared = scope?.sharedNotice { Text(shared).font(.callout).foregroundStyle(AppTheme.secondaryText) }
                    if loading { HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Проверяем доступ к сервисам…").font(.callout) } }
                    if let waiting {
                        Text("Завершите подключение \(waiting.name) в браузере. Здесь появится подтверждение.")
                            .font(.callout).fixedSize(horizontal: false, vertical: true)
                        ViewThatFits(in: .horizontal) {
                            HStack { authorizationActions }.fixedSize(horizontal: true, vertical: false)
                            VStack(alignment: .leading, spacing: 12) { authorizationActions }
                        }
                    }
                    if let notice { Label(notice, systemImage: "checkmark.circle").font(.callout) }
                    if let error {
                        Text(UserFacingError.text(error)).font(.callout).foregroundStyle(AppTheme.warning)
                        Button("Повторить") { Task { await refresh() } }.disabled(loading)
                    }
                    if let extensionNotice, !extensionNotice.hasPrefix("Каталог OpenAI") { Text(extensionNotice).font(.caption).foregroundStyle(AppTheme.secondaryText) }
                    if client.canManageConnections || client.canManageOpenAI {
                        Button { query = ""; showAdd = true } label: { Label("Добавить…", systemImage: "plus") }
                            .buttonStyle(.bordered).disabled(scope == nil || changing).padding(.top, 8).accessibilityIdentifier("addEmployeeExtension")
                    }
                }
                .padding(.vertical, 8)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
    }

    @ViewBuilder private var authorizationActions: some View {
        if let authorizationURL { Link("Открыть ещё раз", destination: authorizationURL) }
        Button("Проверить подключение") { Task { await refresh() } }.disabled(loading)
    }

    private func serviceRow(_ connection: ServiceConnection) -> some View {
        Group {
            if textSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 12) {
                    connectionDetails(connection)
                    connectionAction(connection).adaptiveActionStyle(.bordered)
                }
            } else {
                HStack(spacing: 12) {
                    Image(systemName: connection.icon).foregroundStyle(AppTheme.secondaryText).frame(width: 26)
                    connectionDetails(connection)
                    connectionAction(connection).fixedSize()
                }
            }
        }.padding(.vertical, 8)
    }

    private func connectionDetails(_ connection: ServiceConnection) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(connection.name)
            if let detail = connection.detail { Text(detail).font(.caption).foregroundStyle(AppTheme.secondaryText) }
            if let count = connection.toolCount, connection.connected { Text("Инструментов: \(count)").font(.caption).foregroundStyle(AppTheme.secondaryText) }
            if connection.status == "unavailable" { Text("Нет связи с сервисом").font(.caption).foregroundStyle(AppTheme.secondaryText) }
            if connection.status == "unknown" { Text("Не удалось проверить подключение").font(.caption).foregroundStyle(AppTheme.secondaryText) }
            if connection.removable == true && (client.canManageConnections || client.canManageOpenAI) {
                Button("Удалить…", role: .destructive) { pendingMCPRemoval = connection }.buttonStyle(.borderless).font(.caption).disabled(changing)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private func connectionAction(_ connection: ServiceConnection) -> some View {
        if connection.connected {
            Label("Подключён", systemImage: "checkmark").font(.caption).foregroundStyle(AppTheme.secondaryText)
        } else {
            Button(connecting == connection.id ? "Проверяем…" : waiting?.id == connection.id ? "Ожидаем входа" : connection.actionTitle) {
                Task { await connect(connection) }
            }.buttonStyle(.bordered).disabled(connecting != nil || waiting?.id == connection.id)
                .accessibilityLabel("\(connection.actionTitle) \(connection.name)")
                .accessibilityIdentifier("connect-service-" + connection.id)
        }
    }

    private func connect(_ connection: ServiceConnection) async {
        connecting = connection.id; error = nil; notice = nil
        defer { connecting = nil }
        do {
            if let url = try await client.connectService(connection.id, for: scopeID) {
                waiting = connection; authorizationURL = url
                openURL(url) { accepted in if !accepted { error = "Не удалось открыть браузер. Используйте ссылку «Открыть ещё раз»." } }
            } else {
                await refresh()
                if availableConnections.contains(where: { $0.id == connection.id && $0.connected }) { notice = "Подключено: " + connection.name }
                else { error = "Сервис ещё не подтвердил подключение. Нажмите «Обновить сервисы»." }
            }
        } catch is CancellationError { }
        catch { self.error = error.localizedDescription }
    }
    private func refresh(force: Bool = true) async {
        guard !scopeID.isEmpty else { return }
        let requestID = UUID(), scope = scopeID
        refreshID = requestID
        loading = true; error = nil
        defer { if refreshID == requestID { loading = false } }
        do {
            async let services = client.serviceConnections(for: scope, refresh: force)
            async let installed = try? client.loadExtensions(for: scope)
            let (result, packages) = try await (services, installed)
            guard refreshID == requestID, scope == scopeID else { return }
            availableConnections = result.connections; extensions = packages?.items ?? []
            extensionNotice = packages?.notice ?? result.notice ?? (packages == nil ? "Не удалось загрузить навыки. Проверьте, что OpenStrudel на устройстве сотрудника обновлён." : nil)
            if let waiting, availableConnections.contains(where: { $0.id == waiting.id && $0.connected }) {
                notice = "Подключено: " + waiting.name; self.waiting = nil; authorizationURL = nil
            }
        } catch is CancellationError { }
        catch { if refreshID == requestID { self.error = error.localizedDescription } }
    }
    private func updateExtension(_ item: EmployeeExtension, enabled: Bool? = nil) {
        changing = true; error = nil
        Task {
            defer { changing = false }
            do { try await client.changeExtension(item.id, enabled: enabled, for: scopeID); await refresh() }
            catch { self.error = error.localizedDescription }
        }
    }
    private func removeMCP(_ item: ServiceConnection) {
        changing = true; error = nil
        Task {
            defer { changing = false }
            do { try await client.removeMCP(item.id, for: scopeID); await refresh() }
            catch { self.error = error.localizedDescription }
        }
    }
}

/// One reading column for messages and the composer.
private let chatColumn: CGFloat = 680

private var controlTarget: CGFloat {
    #if os(iOS)
    44
    #else
    34
    #endif
}
