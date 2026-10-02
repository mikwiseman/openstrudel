import SwiftUI
import PhotosUI
import UniformTypeIdentifiers
import QuickLook

/// The native surface is intentionally small: chats on the left, one calm
/// composer, and settings only for the two connections a person can act on.
struct OpenStrudelRootView: View {
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
            if client.health == nil {
                #if os(iOS)
                MobileWelcomeView()
                #else
                HomeUnavailableView()
                #endif
            } else if !aiConsent {
                AIDataConsentView { aiConsent = true }
            } else if client.openAIAccount?.connected == false {
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
                NavigationStack { ConversationView(showSettings: $showSettings) }
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
            if client.isConfigured && !client.isPairing { await client.load(quiet: true) }
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(client.health == nil ? 5 : 1)) } catch { break }
                if client.health != nil { await client.refreshConversation() }
                else if client.isConfigured && !client.isPairing && !client.connectionNeedsPairing {
                    await client.load(quiet: true)
                }
            }
        }
        .sheet(isPresented: $showSettings) {
            SettingsView().environmentObject(client)
        }
        .sheet(item: $client.pendingPairing) { pairing in
            ConfirmMacPairingView(pairing: pairing).environmentObject(client)
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
            Text(client.errorMessage ?? "")
        }
        #if os(macOS)
        .frame(minWidth: 940, minHeight: 620)
        #endif
    }
}

#if os(macOS)
/// Home runs beside the app. It is found again automatically once it starts.
private struct HomeUnavailableView: View {
    @EnvironmentObject private var client: HomeClient
    @State private var showingInvitation = false
    @State private var invitation: MacPairing?
    @State private var starting = false
    @State private var showingServer = false

    var body: some View {
        ScrollView {
        VStack(spacing: 28) {
            OpenStrudelMark(size: 76)
            VStack(spacing: 12) {
                Text(client.isConfigured && !client.isLocalConnection ? "Скоро на связи." : "Ваша команда.\nНа вашей стороне.")
                    .font(.system(.largeTitle, design: .serif, weight: .medium))
                    .multilineTextAlignment(.center)
                Text(client.isConfigured && !client.isLocalConnection
                     ? "«\(client.connectionName)» пока не на связи. Ваши чаты сохранены. Подключимся автоматически."
                     : "Выберите, где будут работать ваши сотрудники.")
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
                        SetupChoiceLabel(title: starting ? "Готовим ваш Mac…" : "На этом Mac", subtitle: "Всё включено. Mac должен оставаться включённым.", icon: "desktopcomputer")
                    }.buttonStyle(.glassProminent).controlSize(.large)
                        .buttonBorderShape(.roundedRectangle(radius: 22))
                        .disabled(starting).accessibilityIdentifier("setupThisMac")
                }
                if !client.isConfigured || client.isLocalConnection {
                    Button { showingServer = true } label: {
                        SetupChoiceLabel(title: "В облаке", subtitle: "Команда на связи, даже когда Mac выключен.", icon: "cloud")
                    }.buttonStyle(.glass).controlSize(.large)
                        .buttonBorderShape(.roundedRectangle(radius: 22))
                        .disabled(starting).accessibilityIdentifier("setupCloud")
                }
                Button { showingInvitation = true } label: {
                    SetupActionLabel(title: "Уже настроено", icon: "link")
                }.buttonStyle(.plain).foregroundStyle(AppTheme.secondaryText)
                    .disabled(starting).accessibilityIdentifier("setupExisting")
            }
            Link("Конфиденциальность", destination: URL(string: "https://waiwai.is/openstrudel/privacy")!)
                .font(.caption).buttonStyle(.plain).foregroundStyle(AppTheme.secondaryText)
        }
        .padding(40).frame(maxWidth: 520).frame(maxWidth: .infinity)
        }.defaultScrollAnchor(.center, for: .alignment)
        .sheet(isPresented: $showingInvitation, onDismiss: {
            if let invitation { client.pendingPairing = invitation; client.pairingError = nil; self.invitation = nil }
        }) { ConnectionInvitationView { invitation = $0 } }
        .sheet(isPresented: $showingServer) { ServerSetupView() }
    }
}

private struct SetupChoiceLabel: View {
    let title: String
    let subtitle: String
    let icon: String
    var body: some View {
        HStack(spacing: 16) {
            Image(systemName: icon).font(.title3).frame(width: 28)
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
    @EnvironmentObject private var client: HomeClient
    @Binding var showSettings: Bool
    @State private var searching = false
    @State private var query = ""
    @FocusState private var searchFocused: Bool

    private var results: [EmployeeProfile] {
        query.isEmpty ? client.profiles : client.profiles.filter {
            $0.name.localizedCaseInsensitiveContains(query) || $0.roleText.localizedCaseInsensitiveContains(query)
        }
    }

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

                    Spacer()
                }

                Button {
                    closeSearch()
                    client.beginEmployee()
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
            }
            .padding(.horizontal, 15)
            .padding(.top, 12)
            .padding(.bottom, 10)

            ScrollView {
                VStack(spacing: 3) {
                    if query.isEmpty || "OpenStrudel".localizedCaseInsensitiveContains(query) {
                        SidebarRow(
                            name: "OpenStrudel",
                            subtitle: "Главный собеседник",
                            selected: client.selectedProfileID == nil,
                            hue: .zero
                        ) { select(nil) }
                    }

                    if client.isEmployeeDraft {
                        SidebarRow(name: "Новый сотрудник", subtitle: "Роль появится в разговоре", selected: true, hue: .zero) {}
                    }
                    ForEach([false, true], id: \.self) { work in
                        let people = results.filter { $0.isWork == work }
                        if !people.isEmpty {
                            Text(work ? "Работа" : "Личное")
                                .font(.system(size: 11, weight: .medium))
                                .foregroundStyle(.tertiary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 12).padding(.top, 17).padding(.bottom, 5)
                            ForEach(people) { profile in
                                SidebarRow(name: profile.name, subtitle: profile.previewText.isEmpty ? profile.roleText : profile.previewText,
                                           selected: client.selectedProfileID == profile.id, hue: profile.markHue) { select(profile.id) }
                            }
                        }
                    }
                }
                .padding(.horizontal, 9)
            }
            .scrollIndicators(.hidden)

            Spacer(minLength: 12)

            HStack(spacing: 10) {
                AccountBadge(email: client.openAIAccount?.email, size: 30)
                Text(client.openAIAccount?.email ?? "Аккаунт")
                    .font(.subheadline)
                    .foregroundStyle(AppTheme.secondaryText)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer()
                Button { showSettings = true } label: {
                    Image(systemName: "gearshape")
                        .font(.system(size: 15, weight: .medium))
                        .frame(width: 32, height: 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(AppTheme.secondaryText)
                .accessibilityLabel("Настройки")
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 13)
        }
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
    let hue: Angle
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 11) {
                OpenStrudelMark(size: 36, hue: hue)
                VStack(alignment: .leading, spacing: 2) {
                    Text(name).font(.system(size: 15, weight: .medium)).lineLimit(1)
                    if !subtitle.isEmpty { Text(subtitle).font(.system(size: 12)).foregroundStyle(AppTheme.secondaryText).lineLimit(1) }
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
    }
}
#endif

private struct ConversationView: View {
    @EnvironmentObject private var client: HomeClient
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Binding var showSettings: Bool
    @State private var draft = ""
    @State private var pickedFiles: [PickedFile] = []
    @State private var fileDrafts: [String: [PickedFile]] = [:]
    @State private var drafts = UserDefaults.standard.dictionary(forKey: "openstrudel.drafts") as? [String: String] ?? [:]
    @State private var showEmployees = false
    @State private var showBotDetails = false
    @State private var followsLatest = true
    @State private var userIsScrolling = false
    @State private var hasNewMessages = false
    @FocusState private var focused: Bool
    private var draftKey: String { (client.selectedProfileID ?? "main") + ":" + (client.selectedChatID ?? "personal") }

    var body: some View {
        VStack(spacing: 0) {
            #if os(macOS)
            ConversationHeader(showSettings: $showSettings, showEmployees: $showEmployees, showBotDetails: $showBotDetails)
            #endif

            ScrollViewReader { proxy in
                ScrollView {
                    if client.messages.isEmpty && client.visiblePendingMessages.isEmpty {
                        EmptyChat()
                            .frame(maxWidth: .infinity, minHeight: 430)
                    } else {
                        // The transcript is paged. Eager layout avoids a SwiftUI
                        // lazy-layout loop when queued rows replace each other
                        // above the iPad keyboard.
                        VStack(alignment: .leading, spacing: 16) {
                            if client.messages.count >= client.historyLimit {
                                Button("Ранее") { Task { await client.loadEarlierMessages() } }
                                    .font(.caption).buttonStyle(.plain).foregroundStyle(AppTheme.secondaryText)
                                    .frame(maxWidth: .infinity)
                            }
                            ForEach(Array(client.messages.enumerated()), id: \.element.id) { index, message in
                                // Keep one stable layout node per message,
                                // including its optional day heading.
                                VStack(alignment: .leading, spacing: 16) {
                                    if let day = newDay(at: index) { DayDivider(date: day) }
                                    MessageBubble(message: message)
                                }.id(message.id)
                            }
                            ForEach(client.visiblePendingMessages) { pending in
                                VStack(alignment: .trailing, spacing: 4) {
                                    PendingMessageBubble(text: pending.text, files: pending.files)
                                    if let error = pending.error {
                                        Text(error).font(.caption).foregroundStyle(AppTheme.secondaryText)
                                        Button("Повторить") { Task { await client.retry(pending) } }.buttonStyle(.plain)
                                    }
                                }
                                    .id(pending.id)
                            }
                            ForEach(client.interactions) { interaction in
                                InteractionCard(interaction: interaction).id(interaction.id)
                            }
                            if client.isSending && client.interactions.isEmpty {
                                ThinkingBubble(name: client.activeAgentName, hue: client.activeProfile?.markHue ?? .zero).id("thinking-message")
                            }
                            if let error = client.syncError {
                                Text(error).font(.caption).foregroundStyle(AppTheme.secondaryText)
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
                .defaultScrollAnchor(.bottom, for: .initialOffset)
                .defaultScrollAnchor(followsLatest ? .bottom : nil, for: .sizeChanges)
                #if os(macOS)
                .mask(EdgeFade())
                #endif
                .scrollDismissesKeyboard(.interactively)
                .onScrollPhaseChange { oldPhase, phase, context in
                    if phase == .tracking || phase == .interacting {
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
                .onChange(of: client.isLoading) { _, loading in
                    if !loading { scrollToBottom(proxy, animated: false) }
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

            Composer(draft: $draft, files: $pickedFiles, focused: $focused) {
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
        .task { draft = drafts[draftKey] ?? "" }
        .onChange(of: draft) { _, value in
            drafts[draftKey] = value.isEmpty ? nil : value
            UserDefaults.standard.set(drafts, forKey: "openstrudel.drafts")
        }
        .onChange(of: draftKey) { old, new in
            drafts[old] = draft
            draft = drafts[new] ?? ""
            fileDrafts[old] = pickedFiles
            pickedFiles = fileDrafts[new] ?? []
            #if os(macOS)
            focused = true
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
                HStack(spacing: 7) {
                    OpenStrudelMark(size: 26, hue: client.activeProfile?.markHue ?? .zero)
                    Text(client.activeAgentName).font(.headline).lineLimit(1)
                }
                .contextMenu {
                    Button("Личный чат") { Task { await client.selectChat(nil) } }
                    ForEach((client.telegram?.chats ?? []).filter { $0.profileId == client.selectedProfileID && $0.conversationId != nil }) { chat in
                        Button(chat.title) { Task { await client.selectChat(chat.conversationId) } }
                    }
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    focused = false
                    if client.activeProfile == nil { showSettings = true } else { showBotDetails = true }
                } label: { Image(systemName: "ellipsis") }
                    .foregroundStyle(.primary)
                    .accessibilityLabel(client.activeProfile == nil ? "Настройки" : "Настройки бота")
            }
        }
        #endif
        .sheet(isPresented: $showEmployees) {
            EmployeePicker().environmentObject(client)
        }
        .sheet(isPresented: $showBotDetails) {
            if let profile = client.activeProfile {
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

    /// The day to announce above a message that starts one.
    private func newDay(at index: Int) -> Date? {
        guard let day = client.messages[index].sentAt else { return nil }
        guard index > 0, let previous = client.messages[index - 1].sentAt else { return day }
        return Calendar.current.isDate(day, inSameDayAs: previous) ? nil : day
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

private struct ConversationHeader: View {
    @EnvironmentObject private var client: HomeClient
    @Binding var showSettings: Bool
    @Binding var showEmployees: Bool
    @Binding var showBotDetails: Bool

    var body: some View {
        HStack {
            #if os(iOS)
            Button { showEmployees = true } label: {
                Image(systemName: "line.3.horizontal")
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(AppTheme.secondaryText)
            .accessibilityLabel("Чаты")
            #else
            Spacer().frame(width: controlTarget)
            #endif

            Spacer()
            HStack(spacing: 8) {
                OpenStrudelMark(size: 26, hue: client.activeProfile?.markHue ?? .zero)
                Text(client.activeAgentName).font(.headline).lineLimit(1)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .glassEffect(.regular, in: .capsule)
            .contextMenu {
                Button("Личный чат") { Task { await client.selectChat(nil) } }
                ForEach((client.telegram?.chats ?? []).filter { $0.profileId == client.selectedProfileID && $0.conversationId != nil }) { chat in
                    Button(chat.title) { Task { await client.selectChat(chat.conversationId) } }
                }
            }
            Spacer()
            if showsSettingsButton {
                Button {
                    if client.activeProfile == nil {
                        showSettings = true
                    } else {
                        showBotDetails = true
                    }
                } label: {
                    Image(systemName: "gearshape")
                        .font(.system(size: 15, weight: .medium))
                        .frame(width: controlTarget, height: controlTarget)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(AppTheme.secondaryText)
                .accessibilityLabel(client.activeProfile == nil ? "Настройки" : "Настройки бота")
            } else {
                Spacer().frame(width: controlTarget)
            }
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 4)
    }

    /// On the Mac the sidebar already opens app settings; the header keeps only a bot's own.
    private var showsSettingsButton: Bool {
        #if os(macOS)
        client.activeProfile != nil
        #else
        true
        #endif
    }
}

private struct EmptyChat: View {
    @EnvironmentObject private var client: HomeClient
    var body: some View {
        VStack(spacing: 12) {
            OpenStrudelMark(size: 56, hue: client.activeProfile?.markHue ?? .zero)
            Text(client.isEmployeeDraft ? "Кем я буду?" : client.activeProfile?.name ?? "Напишите, что нужно")
                .font(.system(.title2, design: .serif, weight: .semibold))
            if client.isEmployeeDraft {
                Text("Расскажите прямо здесь. Остальное сложится в разговоре.")
                    .font(.subheadline)
                    .foregroundStyle(AppTheme.secondaryText)
                Picker("Область", selection: $client.draftEmployeeDomain) {
                    Text("Личное").tag("personal")
                    Text("Работа").tag("work")
                }
                .pickerStyle(.segmented).frame(width: 210).padding(.top, 8)
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
                if let error = message.error { Text(error).font(.caption).foregroundStyle(AppTheme.warning) }
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
                            Text(message.text)
                                .font(ChatTypography.body)
                                .lineSpacing(4).textSelection(.enabled)
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
                    if let error = message.error { Text(error).font(.caption).foregroundStyle(AppTheme.warning).textSelection(.enabled) }
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
    let hue: Angle

    var body: some View {
        HStack {
            HStack(spacing: 8) {
                // The employee's own mark turns while it works.
                TimelineView(.animation(paused: reduceMotion)) { context in
                    OpenStrudelMark(size: 18, hue: hue)
                        .rotationEffect(.degrees(reduceMotion ? 0 : context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 2.4) * 150))
                }
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
    @Binding var draft: String
    @Binding var files: [PickedFile]
    @FocusState.Binding var focused: Bool
    let send: () -> Void
    @State private var showFiles = false
    @State private var showPhotos = false
    @State private var photoSelection: [PhotosPickerItem] = []
    @State private var fileError: String?

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
            }
            .buttonStyle(.plain)
            .foregroundStyle(AppTheme.secondaryText)
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .frame(width: controlTarget, height: controlTarget)
            .accessibilityLabel("Добавить")

            TextField("Сообщение", text: $draft, axis: .vertical)
                .textFieldStyle(.plain)
                .font(ChatTypography.body)
                .lineLimit(1...6)
                .padding(.vertical, 8)
                .frame(minHeight: controlTarget)
                .focused($focused)
                .onSubmit { if !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !files.isEmpty { send() } }

            if !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !files.isEmpty {
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
                .accessibilityLabel("Отправить")
            }
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 4)
        }
        .glassEffect(.regular, in: .rect(cornerRadius: 25))
        .photosPicker(isPresented: $showPhotos, selection: $photoSelection, maxSelectionCount: max(1, 6 - files.count), matching: .images)
        .onChange(of: photoSelection) { _, selection in
            Task {
                do {
                    var picked: [PickedFile] = []
                    for photo in selection {
                        guard let data = try await photo.loadTransferable(type: Data.self), !data.isEmpty, data.count <= 25 * 1024 * 1024 else {
                            fileError = "Выберите фото до 25 МБ."; return
                        }
                        let type = photo.supportedContentTypes.first(where: { $0.conforms(to: .image) }) ?? .jpeg
                        picked.append(PickedFile(name: "Фото." + (type.preferredFilenameExtension ?? "jpg"), mimeType: type.preferredMIMEType ?? "image/jpeg", data: data))
                    }
                    guard files.count + picked.count <= 6 else { fileError = "Можно прикрепить до шести файлов."; return }
                    files.append(contentsOf: picked); photoSelection = []
                } catch { fileError = "Не удалось открыть фото. Выберите его ещё раз." }
            }
        }
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.data, .image, .pdf, .text, .audio], allowsMultipleSelection: true) { result in
            do {
                let urls = try result.get()
                guard files.count + urls.count <= 6 else { fileError = "Можно прикрепить до шести файлов."; return }
                var selection: [PickedFile] = []
                for url in urls {
                    let scoped = url.startAccessingSecurityScopedResource()
                    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                    let data = try Data(contentsOf: url)
                    guard !data.isEmpty && data.count <= 25 * 1024 * 1024 else { fileError = "Выберите файл до 25 МБ."; return }
                    let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
                    selection.append(PickedFile(name: url.lastPathComponent, mimeType: mime, data: data))
                }
                files.append(contentsOf: selection)
            } catch { fileError = "Не удалось открыть файл. Выберите его ещё раз." }
        }
        .alert("Файл", isPresented: Binding(get: { fileError != nil }, set: { if !$0 { fileError = nil } })) { Button("Понятно", role: .cancel) {} } message: { Text(fileError ?? "") }
    }

}

private struct EmployeePicker: View {
    @EnvironmentObject private var client: HomeClient
    @Environment(\.dismiss) private var dismiss

    @State private var query = ""

    var body: some View {
        NavigationStack {
            List {
                EmployeePickerRow(name: "OpenStrudel", subtitle: "Главный собеседник", selected: client.selectedProfileID == nil, hue: .zero) {
                    Task { await client.selectProfile(nil); dismiss() }
                }
                ForEach([false, true], id: \.self) { work in
                    let people = client.profiles.filter { $0.isWork == work && (query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) || $0.roleText.localizedCaseInsensitiveContains(query)) }
                    if !people.isEmpty {
                        Section(work ? "Работа" : "Личное") {
                            ForEach(people) { profile in
                                EmployeePickerRow(name: profile.name, subtitle: profile.previewText.isEmpty ? profile.roleText : profile.previewText, selected: client.selectedProfileID == profile.id, hue: profile.markHue) {
                                    Task { await client.selectProfile(profile.id); dismiss() }
                                }
                            }
                        }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(HomeBackground())
            .navigationTitle("Чаты")
            .searchable(text: $query, prompt: "Найти сотрудника")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button { client.beginEmployee(); dismiss() } label: { Image(systemName: "plus") }
                        .accessibilityLabel("Новый сотрудник")
                }
                ToolbarItem(placement: .cancellationAction) { Button("Готово") { dismiss() } }
            }
        }
    }
}

private struct EmployeePickerRow: View {
    let name: String
    let subtitle: String
    let selected: Bool
    let hue: Angle
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 11) {
                OpenStrudelMark(size: 42, hue: hue)
                VStack(alignment: .leading, spacing: 2) {
                    Text(name).font(.body.weight(.medium)).lineLimit(2)
                    if !subtitle.isEmpty { Text(subtitle).font(.caption).foregroundStyle(AppTheme.secondaryText).lineLimit(1) }
                }
                Spacer()
                if selected { Image(systemName: "checkmark").foregroundStyle(AppTheme.secondaryText) }
            }
            .padding(.vertical, 5)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(name)
        .accessibilityValue(subtitle)
    }
}

private struct BotDetailsView: View {
    @EnvironmentObject private var client: HomeClient
    @Environment(\.dismiss) private var dismiss
    let profile: EmployeeProfile
    @State private var name: String
    @State private var instructions: String
    @State private var showConnections = false
    @State private var showTelegram = false
    @State private var isSaving = false

    init(profile: EmployeeProfile) {
        self.profile = profile
        _name = State(initialValue: profile.name)
        _instructions = State(initialValue: profile.instructions)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                HStack(spacing: 12) {
                    OpenStrudelMark(size: 56, hue: profile.markHue)
                    VStack(alignment: .leading, spacing: 3) {
                        TextField("Имя сотрудника", text: $name).textFieldStyle(.plain).font(.title2.weight(.semibold))
                        Text(profile.isWork ? "Рабочий сотрудник" : "Личный сотрудник").font(.caption).foregroundStyle(AppTheme.secondaryText)
                    }
                }
                VStack(alignment: .leading, spacing: 8) {
                    Text("Описание").font(.subheadline.weight(.medium))
                    TextEditor(text: $instructions).font(.body).scrollContentBackground(.hidden)
                        .frame(height: 180).padding(10)
                        .background(.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 12))
                        .accessibilityLabel("Описание сотрудника")
                }
                Divider()
                Button { showConnections = true } label: {
                    HStack {
                        Label("Сервисы", systemImage: "link")
                        Spacer()
                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                    }.contentShape(Rectangle())
                }.buttonStyle(.plain)
                Button { showTelegram = true } label: {
                    HStack {
                        Label("Telegram", systemImage: "paperplane")
                        Spacer()
                        Text((client.telegram?.chats ?? []).filter { $0.profileId == profile.id }.map(\.title).joined(separator: ", "))
                            .font(.caption).foregroundStyle(AppTheme.secondaryText).lineLimit(1)
                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                    }.contentShape(Rectangle())
                }.buttonStyle(.plain)
                if !client.schedules.isEmpty {
                    Divider()
                    Text("Расписание").font(.subheadline.weight(.medium))
                }
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
                    Text(error).font(.caption).foregroundStyle(AppTheme.warning)
                }
            }
            .padding(24)
            }
            .background(HomeBackground())
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "Сохраняем…" : "Готово") {
                        guard name != profile.name || instructions != profile.instructions else { dismiss(); return }
                        isSaving = true
                        Task {
                            let saved = await client.updateProfile(id: profile.id, name: name, instructions: instructions)
                            isSaving = false
                            if saved { dismiss() }
                        }
                    }.disabled(isSaving || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .sheet(isPresented: $showConnections) { ConnectionsView() }
            .sheet(isPresented: $showTelegram) { TelegramChatsView(profile: profile) }
            .task { await client.loadChatSettings() }
        }
        #if os(macOS)
        .frame(width: 470, height: 590)
        #endif
    }
}

struct SettingsView: View {
    @EnvironmentObject private var client: HomeClient
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    SectionTitle(title: "OpenAI", subtitle: "Аккаунт, на котором работает Codex")
                    OpenAISettingsCard()
                    SectionTitle(title: "Telegram", subtitle: "Пишите OpenStrudel из Telegram")
                    TelegramSettingsCard()
                    MobilePairingSettings()
                    #if os(macOS)
                    SectionTitle(title: "Обновления", subtitle: "Новые версии OpenStrudel")
                    UpdateSettings()
                    #endif
                    #if os(iOS)
                    Text("Чаты и сотрудники — с \(client.connectionName). Продолжайте с любого устройства.")
                        .font(.footnote).foregroundStyle(AppTheme.secondaryText).padding(.top, 12)
                    #endif
                    if let url = DigitalOceanCloud.managementURL(for: client.normalizedBaseURL) {
                        Link(destination: url) { Label("Управлять облаком", systemImage: "arrow.up.right") }
                            .buttonStyle(.plain).foregroundStyle(AppTheme.accent)
                            .font(.callout).padding(.top, 12)
                        Text("Оплатой и размещением управляет DigitalOcean. Закрытие приложения не прекращает оплату.")
                            .font(.caption).foregroundStyle(AppTheme.secondaryText)
                    }
                    HStack(spacing: 20) {
                        Link("Помощь", destination: URL(string: "https://waiwai.is/openstrudel#help")!)
                        Link("Конфиденциальность", destination: URL(string: "https://waiwai.is/openstrudel/privacy")!)
                    }.font(.caption).buttonStyle(.plain).foregroundStyle(AppTheme.secondaryText).padding(.top, 16)
                }
                .padding(22)
                .frame(maxWidth: 620, alignment: .leading)
            }
            .background(HomeBackground())
            .navigationTitle("Настройки")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Готово") { dismiss() } } }
        }
        .onChange(of: client.openAILogin) { _, login in
            guard let url = login?.url else { return }
            openURL(url)
        }
        .task(id: client.openAILogin?.loginId) {
            guard client.openAILogin != nil else { return }
            while !Task.isCancelled && client.openAILogin != nil {
                try? await Task.sleep(for: .seconds(1))
                await client.pollOpenAILogin()
            }
        }
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
                        Text(planTitle(account.planType)).font(.caption).foregroundStyle(AppTheme.secondaryText)
                    } else {
                        Text("Аккаунт не подключён").font(.subheadline.weight(.medium))
                        Text("Войдите через OpenAI").font(.caption).foregroundStyle(AppTheme.secondaryText)
                    }
                    ConnectionStatus(connected: connected)
                }
                Spacer()
            }
            }

            if let login = client.openAILogin {
                VStack(alignment: .leading, spacing: 8) {
                    if login.type == "device", let code = login.userCode {
                        Text("Введите код в открывшемся окне").font(.caption).foregroundStyle(AppTheme.secondaryText)
                        Text(code).font(.system(.title3, design: .monospaced).weight(.semibold)).textSelection(.enabled)
                    } else {
                        Text("Откройте страницу OpenAI и завершите вход.").font(.caption).foregroundStyle(AppTheme.secondaryText)
                    }
                    Button { Task { await client.cancelOpenAILogin() } } label: {
                        SetupActionLabel(title: "Отменить")
                    }.buttonStyle(.glass).controlSize(.large)
                }
            } else if connected {
                Button { Task { await client.beginOpenAILogin() } } label: {
                    SetupActionLabel(title: client.isStartingOpenAILogin ? "Открываем OpenAI…" : "Сменить аккаунт")
                }.buttonStyle(.glass).controlSize(.large).disabled(client.isStartingOpenAILogin)
            } else {
                Button { Task { await client.beginOpenAILogin() } } label: {
                    SetupActionLabel(title: client.isStartingOpenAILogin ? "Открываем OpenAI…" : "Войти с OpenAI", icon: "arrow.up.right")
                }.buttonStyle(.glassProminent).controlSize(.large)
                    .disabled(client.isStartingOpenAILogin)
                    .accessibilityIdentifier("signInOpenAI")
            }
        }
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
                Text("Начнём с вашего аккаунта.")
                    .font(.system(.largeTitle, design: .serif, weight: .medium)).multilineTextAlignment(.center)
                Text("Войдите в ChatGPT. OpenStrudel использует вашу подписку и Codex.")
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
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    var profile: EmployeeProfile? = nil
    @State private var replacement: TelegramChat?
    private var chats: [TelegramChat] { client.telegram?.chats ?? [] }
    private var paired: Bool { chats.contains { !$0.chatId.hasPrefix("-") && $0.allowedSenders.contains($0.chatId) } }

    var body: some View {
        NavigationStack {
            ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if client.telegram?.configured != true {
                    Text("Telegram пока не подключён. Настройка доступна в настройках приложения.")
                        .foregroundStyle(AppTheme.secondaryText)
                } else {
                    Section {
                        if paired, let name = client.telegram?.botUsername, let url = URL(string: "https://t.me/" + name + "?startgroup=choose&admin=manage_chat") {
                            Link(destination: url) { Label("Добавить бота в группу", systemImage: "plus.bubble") }
                                .buttonStyle(.plain).foregroundStyle(AppTheme.accent)
                        } else {
                            Button("Подключить Telegram") {
                                Task { await client.createTelegramLink(); if let url = client.telegramLink?.url { openURL(url) } }
                            }
                        }
                    } footer: {
                        Text(paired ? "Telegram предложит сделать бота администратором, чтобы он видел сообщения группы. Затем выберите сотрудника здесь." : "Сначала свяжите свой Telegram-аккаунт.")
                            .font(.caption).fontWeight(.regular).foregroundStyle(AppTheme.secondaryText)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if !chats.isEmpty {
                        Section {
                            ForEach(chats) { chat in
                                HStack {
                                    Image(systemName: chat.chatId.hasPrefix("-") ? "person.2" : "person.crop.circle").foregroundStyle(AppTheme.secondaryText)
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(chat.title)
                                        Text(client.profiles.first(where: { $0.id == chat.profileId })?.name ?? (chat.chatId.hasPrefix("-") ? "Выберите сотрудника" : "Главный собеседник"))
                                            .font(.caption).foregroundStyle(AppTheme.secondaryText)
                                    }
                                    Spacer()
                                    if let profile {
                                        if chat.profileId == profile.id {
                                            Menu { Button("Отвязать", role: .destructive) { Task { await client.bindTelegram(chatID: chat.chatId, profileID: nil) } } } label: {
                                                Image(systemName: "checkmark").foregroundStyle(AppTheme.secondaryText)
                                            }.menuIndicator(.hidden).accessibilityLabel("Чат связан")
                                        } else {
                                            Button("Связать") {
                                                if chat.profileId != nil { replacement = chat }
                                                else { Task { await client.bindTelegram(chatID: chat.chatId, profileID: profile.id) } }
                                            }.controlSize(.small)
                                        }
                                    } else {
                                        Menu("Сотрудник") {
                                            ForEach(client.profiles) { employee in
                                                Button(employee.name) { Task { await client.bindTelegram(chatID: chat.chatId, profileID: employee.id) } }
                                            }
                                        }.controlSize(.small)
                                    }
                                }.padding(.vertical, 5)
                            }
                        } footer: {
                            Text("В группе — отдельная переписка. Личная история туда не передаётся. Пока бот отвечает только тому, кто его подключил.")
                                .font(.caption).fontWeight(.regular).foregroundStyle(AppTheme.secondaryText)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }.padding(24)
            }
            .background(HomeBackground())
            .navigationTitle("Telegram")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Готово") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button { Task { await client.loadChatSettings() } } label: { Image(systemName: "arrow.clockwise") }.accessibilityLabel("Обновить чаты")
                }
            }
            .task { await client.loadChatSettings() }
            .onChange(of: scenePhase) { _, phase in if phase == .active { Task { await client.loadChatSettings() } } }
            .confirmationDialog("Заменить сотрудника в этом чате?", isPresented: Binding(get: { replacement != nil }, set: { if !$0 { replacement = nil } })) {
                if let chat = replacement, let profile {
                    Button("Связать с «\(profile.name)»") { Task { await client.bindTelegram(chatID: chat.chatId, profileID: profile.id) }; replacement = nil }
                }
                Button("Отмена", role: .cancel) { replacement = nil }
            }
        }
        #if os(macOS)
        .frame(width: 470, height: 440)
        #endif
    }
}

private struct TelegramSettingsCard: View {
    @EnvironmentObject private var client: HomeClient
    @State private var showChats = false

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
                    Link("Открыть Telegram", destination: url).buttonStyle(.borderedProminent)
                    Text("В Telegram нажмите «Начать», чтобы продолжить разговор.")
                        .font(.callout).foregroundStyle(AppTheme.secondaryText)
                }
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) { telegramActions }
                    VStack(alignment: .leading, spacing: 8) { telegramActions }
                }
            } else {
                Text("Telegram пока недоступен для новых подключений в этой сборке. Ваши сотрудники уже работают в приложении.")
                    .font(.callout).foregroundStyle(AppTheme.secondaryText)
            }
        }
        .settingsCard()
        .sheet(isPresented: $showChats) { TelegramChatsView() }
    }

    @ViewBuilder private var telegramActions: some View {
        Button(client.telegramLink == nil ? "Продолжить в Telegram" : "Обновить приглашение") { Task { await client.createTelegramLink() } }
            .buttonStyle(.bordered)
        if !(client.telegram?.chats ?? []).isEmpty {
            Button("Чаты") { showChats = true }.buttonStyle(.bordered)
        }
        Button("Отключить", role: .destructive) { Task { await client.disconnectTelegram() } }
            .buttonStyle(.bordered)
            .tint(.red)
    }
}

/// The same quiet status on every connection card.
struct ConnectionStatus: View {
    let connected: Bool

    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(connected ? Color.green : Color.secondary.opacity(0.4)).frame(width: 7, height: 7)
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
    let size: CGFloat
    var hue: Angle = .zero

    var body: some View {
        Image("OpenStrudelMark")
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            .hueRotation(hue)
            .accessibilityHidden(true)
    }
}

extension EmployeeProfile {
    /// One color of the mark per employee, the same on every screen.
    var markHue: Angle {
        let hues: [Double] = [110, 70, -110, 140, 40, 170, -70, -30]
        return .degrees(hues[id.unicodeScalars.reduce(0) { ($0 + Int($1.value)) % hues.count }])
    }
}

private struct HomeBackground: View {
    var body: some View {
        ZStack {
            #if os(macOS)
            Color(nsColor: .windowBackgroundColor)
            #else
            Color(uiColor: .systemBackground)
            #endif
        }
        .ignoresSafeArea()
    }
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
            if let error { Text(error).font(.caption).foregroundStyle(AppTheme.warning) }
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
                    Text(option)
                    if interaction.questions.count > 1 && answers[question.id] == option { Image(systemName: "checkmark") }
                }
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
    @State private var query = ""
    @State private var loading = true
    @State private var error: String?
    @State private var connecting: String?
    private var results: [ServiceConnection] {
        client.connections.filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) }
            .sorted {
                if $0.connected != $1.connected { return $0.connected }
                return $0.name.localizedStandardCompare($1.name) == .orderedAscending
            }
    }
    var body: some View {
        NavigationStack {
            Group {
                if loading && client.connections.isEmpty {
                    ProgressView("Загружаем подключения…")
                        .controlSize(.small)
                        .foregroundStyle(AppTheme.secondaryText)
                }
                else {
                    List {
                        if let error { Text(error).font(.caption).foregroundStyle(AppTheme.warning) }
                        ForEach(results) { connection in
                            HStack(spacing: 12) {
                                Image(systemName: connection.icon)
                                    .foregroundStyle(AppTheme.secondaryText).frame(width: 26)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(connection.name)
                                    if let detail = connection.detail { Text(detail).font(.caption).foregroundStyle(AppTheme.secondaryText) }
                                }
                                Spacer()
                                if connection.connected {
                                    Image(systemName: "checkmark")
                                        .foregroundStyle(AppTheme.secondaryText)
                                        .accessibilityLabel("Подключено")
                                }
                                else {
                                    Button(connecting == connection.id ? "Открываем…" : "Подключить") {
                                        connecting = connection.id
                                        Task {
                                            do { if let url = try await client.connectService(connection.id) { openURL(url) } }
                                            catch { self.error = error.localizedDescription }
                                            connecting = nil
                                        }
                                    }
                                    .controlSize(.small)
                                    .disabled(connecting != nil)
                                }
                            }.padding(.vertical, 5)
                        }
                        if let notice = client.connectionNotice { Text(notice).font(.caption).foregroundStyle(AppTheme.secondaryText) }
                        if results.isEmpty { Text("Сервисы не найдены").foregroundStyle(AppTheme.secondaryText) }
                    }
                    .scrollContentBackground(.hidden)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(HomeBackground())
            .navigationTitle("Сервисы")
            .searchable(text: $query, prompt: "Найти сервис")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Закрыть") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Обновить") { Task { await refresh() } }.disabled(loading) }
            }
        }
        #if os(macOS)
        .frame(width: 520, height: 570)
        #endif
        .task { await refresh(force: false) }
    }
    private func refresh(force: Bool = true) async {
        loading = true; error = nil
        do { try await client.loadConnections(refresh: force) } catch { self.error = error.localizedDescription }
        loading = false
    }
}

/// One reading column for messages and the composer.
private let chatColumn: CGFloat = 720

private var controlTarget: CGFloat {
    #if os(iOS)
    44
    #else
    34
    #endif
}
