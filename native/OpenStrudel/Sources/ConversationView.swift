import SwiftUI

/// The details sheet's subject, fixed when it opens: a move can remove the employee from this
/// device's list while its progress sheet is still open on top.
private struct EmployeeDetailsPresentation: Identifiable {
    let profile: EmployeeProfile?
    var id: String { profile?.id ?? "main" }
}

struct ConversationView: View {
    @EnvironmentObject private var library: DeviceLibrary
    @EnvironmentObject private var client: HomeClient
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    #if os(macOS)
    @Environment(\.openSettings) private var openSettings
    #else
    @Binding var showSettings: Bool
    @State private var showEmployees = false
    #endif
    @State private var draft = ""
    @State private var pickedFiles: [PickedFile] = []
    @State private var details: EmployeeDetailsPresentation?
    @State private var followsLatest = true
    @State private var userIsScrolling = false
    @State private var hasNewMessages = false
    @State private var newsPlace = NewsPlace()
    @FocusState private var focused: Bool
    private var draftKey: String { HomeDrafts.key(home: client.baseURLString, profile: client.selectedProfileID, chat: client.selectedChatID) }

    var body: some View {
        ScrollViewReader { proxy in
            #if os(macOS)
            // The transcript runs under the toolbar and the composer; the system draws the scroll edges.
            if showsNewsDesk {
                NewsDeskView(place: $newsPlace)
                    .safeAreaBar(edge: .top, spacing: 0) { topBar }
            } else {
                transcript(proxy)
                    .safeAreaBar(edge: .top, spacing: 0) { topBar }
                    .safeAreaBar(edge: .bottom, spacing: 0) { bottomBar(proxy) }
            }
            #else
            VStack(spacing: 0) {
                EmployeeMoveStatusButton()
                if showsSourcePicker {
                    ConversationSources()
                        .padding(.horizontal, Layout.edge).padding(.vertical, 8)
                }
                if showsConnectionBanner {
                    connectionBanner.padding(.horizontal, Layout.edge).padding(.vertical, 8)
                }
                if showsRecoveryNotice {
                    OpenAIRecoveryNotice()
                        .padding(.horizontal, Layout.edge).padding(.vertical, 8)
                }
                if showsNews {
                    NewsSwitcher(mode: $newsPlace.mode).padding(.horizontal, Layout.edge)
                        .overlay(alignment: .bottom) { Hairline() }
                }
                if showsNewsDesk {
                    NewsDeskView(place: $newsPlace)
                } else {
                    // Animate scrolling, not pending-row replacement: an implicit
                    // layout animation can loop while the iPad keyboard is visible.
                    transcript(proxy)
                        .safeAreaBar(edge: .bottom, spacing: 0) { bottomBar(proxy) }
                }
            }
            #endif
        }
        .task { draft = library.draft(for: draftKey); pickedFiles = library.fileDrafts[draftKey] ?? [] }
        // Another employee opens on its own first screen.
        .onChange(of: client.selectedProfileID) { _, _ in newsPlace = NewsPlace() }
        .onChange(of: client.openAIAccount?.connected) { _, connected in
            if connected == false { focused = false }
        }
        .onChange(of: pickedFiles) { _, value in
            guard library.active === client else { return }
            library.fileDrafts[draftKey] = value
        }
        .onChange(of: draft) { _, value in
            guard library.active === client else { return }
            library.saveDraft(value, for: draftKey)
        }
        .onChange(of: draftKey) { old, new in
            guard library.active === client else { return }
            library.saveDraft(draft, for: old)
            draft = library.draft(for: new)
            library.fileDrafts[old] = pickedFiles
            pickedFiles = library.fileDrafts[new] ?? []
            #if os(macOS)
            focused = client.isEmployeeDraft
            #else
            focused = false
            #endif
        }
        #if os(macOS)
        .navigationTitle(client.activeAgentName)
        .toolbar {
            ToolbarItem(placement: .navigation) {
                ConversationTitle { openDetails() }
            }
            if showsSourcePicker {
                ToolbarItem(placement: .primaryAction) { ConversationSourceMenu() }
            }
        }
        .focusedSceneValue(\.showEmployeeDetails, client.isEmployeeDraft ? nil : { openDetails() })
        #else
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button { focused = false; showEmployees = true } label: { Image(systemName: "line.3.horizontal") }
                    .foregroundStyle(.primary)
                    .accessibilityLabel(L("Чаты"))
                    .accessibilityIdentifier("openChats")
            }
            ToolbarItem(placement: .principal) {
                ConversationTitle { focused = false; openDetails() }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { focused = false; showSettings = true } label: { Image(systemName: "gearshape") }
                    .foregroundStyle(.primary).accessibilityLabel(L("Настройки"))
            }
        }
        .sheet(isPresented: $showEmployees) {
            EmployeePicker(isPresented: $showEmployees).environmentObject(client)
        }
        #endif
        .sheet(item: $details) { presentation in
            if let profile = presentation.profile {
                BotDetailsView(profile: profile).environmentObject(client)
            } else {
                MainAssistantDetailsView().environmentObject(client)
            }
        }
    }

    private func openDetails() {
        details = EmployeeDetailsPresentation(profile: client.activeProfile)
    }

    private func transcript(_ proxy: ScrollViewProxy) -> some View {
        ScrollView {
            if client.feedMessages.isEmpty && client.visiblePendingMessages.isEmpty {
                // While a chosen conversation loads, the canvas stays empty rather than flash the empty state.
                if showsEmptyChat {
                    EmptyChat()
                        #if os(macOS)
                        .containerRelativeFrame(.vertical)
                        #else
                        .frame(maxWidth: .infinity, minHeight: 430)
                        #endif
                }
            } else {
                TranscriptRows(proxy: proxy, followsLatest: $followsLatest)
                    .frame(maxWidth: Layout.column, alignment: .leading)
                    .frame(maxWidth: .infinity, alignment: .center)
                    // The room above the composer is the transcript's own last row, so
                    // following the latest message and scrolling to the end both leave 24.
                    .padding(.horizontal, Layout.edge)
                    .padding(.top, Layout.belowToolbar)
            }
        }
        .scrollIndicators(.hidden)
        #if os(macOS)
        // Under a Mac toolbar the soft style draws nothing visible; the hard one blurs and edges it like Settings.
        .scrollEdgeEffectStyle(.hard, for: .top)
        #endif
        .defaultScrollAnchor(.bottom, for: .initialOffset)
        #if os(iOS)
        // Attachments settle after the initial scroll. Keep the end
        // anchored only while the reader follows new replies.
        .defaultScrollAnchor(followsLatest ? .bottom : nil, for: .sizeChanges)
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
        .onChange(of: client.feedMessages.last?.id) { _, _ in
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
        .task {
            await Task.yield()
            await Task.yield()
            scrollToBottom(proxy, animated: false)
        }
    }

    /// A draft, a loaded conversation, or one that cannot load right now.
    private var showsEmptyChat: Bool {
        client.isEmployeeDraft || client.conversationID != nil || client.health == nil || client.homeUnreachable || client.syncError != nil
    }

    /// Separate Telegram transcripts exist only on a Home known to lack the employee feed,
    /// so an app opened before its Home answers never flashes the old screen.
    private var showsSourcePicker: Bool {
        client.health != nil && !client.usesEmployeeTimeline && !client.isEmployeeDraft && !client.employeeTelegramChats.isEmpty
    }

    /// An employee with News stories reads them as an edition and a radar; the chat stays one tab away.
    private var showsNews: Bool { client.newsStamp != nil && !client.isEmployeeDraft }
    private var showsNewsDesk: Bool { showsNews && newsPlace.mode != .chat }

    private var showsConnectionBanner: Bool { client.connectionNeedsPairing || client.homeUnreachable || client.health == nil }
    private var showsRecoveryNotice: Bool { client.openAIAccount?.connected == false && !client.homeUnreachable && client.health != nil }

    /// The new-messages button, the Telegram hint and the composer, on the transcript column's edges.
    private func bottomBar(_ proxy: ScrollViewProxy) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if hasNewMessages && !followsLatest {
                newMessagesButton(proxy).frame(maxWidth: .infinity)
            }
            telegramHint
            if client.usesEmployeeTimeline, !previousDrafts.isEmpty {
                Menu(L("Черновики прежних переписок")) {
                    ForEach(previousDrafts, id: \.key) { saved in
                        Button(L("Вставить в сообщение: \(saved.title)")) {
                            let oldFiles = library.fileDrafts[saved.key] ?? []
                            draft = [draft, library.draft(for: saved.key)].filter { !$0.isEmpty }.joined(separator: "\n\n")
                            pickedFiles += oldFiles
                            library.saveDraft("", for: saved.key); library.fileDrafts[saved.key] = nil
                        }
                    }
                }.font(AppTypography.meta)
            }
            composer
        }
        .frame(maxWidth: Layout.column)
        .padding(.horizontal, Layout.edge)
        .padding(.bottom, Layout.belowComposer)
        .frame(maxWidth: .infinity)
        // A growing composer keeps the latest message and its 24 of room above the glass.
        // A size-change scroll anchor would loop the lazy rows (see TranscriptStack).
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { _ in
            if followsLatest { scrollToBottom(proxy, animated: false) }
        }
    }

    private var previousDrafts: [(key: String, title: String)] {
        let chats = client.employeeTelegramChats.compactMap { chat in chat.conversationId.map { ($0, chat.title) } }
            + client.importedConversations.filter { $0.profileId == client.selectedProfileID }.map { ($0.id, $0.title) }
        return chats.compactMap { id, title in
            let key = HomeDrafts.key(home: client.baseURLString, profile: client.selectedProfileID, chat: id)
            return !library.draft(for: key).isEmpty || !(library.fileDrafts[key] ?? []).isEmpty ? (key, title) : nil
        }
    }

    #if os(macOS)
    /// Connection state, the OpenAI notice and the archive name sit above the transcript in the column.
    @ViewBuilder private var topBar: some View {
        let archive = client.importedConversations.first { $0.id == client.selectedChatID }
        if showsConnectionBanner || showsRecoveryNotice || archive != nil || showsNews {
            VStack(alignment: .leading, spacing: 8) {
                if showsNews { NewsSwitcher(mode: $newsPlace.mode) }
                if showsConnectionBanner { connectionBanner }
                if showsRecoveryNotice { OpenAIRecoveryNotice() }
                if let archive {
                    Label(L("Archive · \(archive.title)"), systemImage: "archivebox")
                        .font(AppTypography.meta).foregroundStyle(AppTheme.secondaryText).lineLimit(1)
                }
            }
            .frame(maxWidth: showsNewsDesk ? NewsLayout.column : Layout.column, alignment: .leading)
            .padding(.horizontal, Layout.edge)
            .padding(.top, 16)
            .frame(maxWidth: .infinity)
        }
    }
    #endif

    private var connectionBanner: some View {
        HStack(spacing: 8) {
            if client.isConnecting { ProgressView().controlSize(.small) }
            else { Image(systemName: client.connectionNeedsUnlock ? "lock" : "wifi.slash") }
            Text(client.connectionNeedsUnlock ? L("Unlock the saved connection to continue. Your chats and drafts are safe.") : client.connectionNeedsPairing ? L("Подключите «\(client.displayName)» снова. Переписка сохранена на устройстве.") : client.isConnecting ? L("Подключаемся к «\(client.displayName)»…") : L("«\(client.displayName)» не на связи. Переписка и черновики сохранены. Подключимся автоматически."))
            Spacer(minLength: 0)
            if client.connectionNeedsUnlock {
                SavedConnectionUnlockButton(client: client)
            } else if client.connectionNeedsPairing {
                Button(L("Подключить")) {
                    #if os(macOS)
                    UserDefaults.standard.set(SettingsView.Section.devices.rawValue, forKey: "openstrudel.settingsTab")
                    openSettings()
                    #else
                    showSettings = true
                    #endif
                }
            }
        }
        #if os(iOS)
        .font(.callout)
        #endif
        .foregroundStyle(AppTheme.secondaryText)
    }

    @ViewBuilder private var telegramHint: some View {
        if client.health != nil, client.activeTelegramChat != nil {
            // No fixed size here: the window measures its minimum with a zero width,
            // and a fixed-height wrapped line would then grow taller than the window.
            Text(L("Здесь можно обсудить переписку с помощником. Ответ останется в OpenStrudel."))
                .font(AppTypography.meta).foregroundStyle(AppTheme.secondaryText)
                .accessibilityIdentifier("telegramReplyDestination")
        }
    }

    private func newMessagesButton(_ proxy: ScrollViewProxy) -> some View {
        Button(L("Новые сообщения"), systemImage: "arrow.down") {
            followsLatest = true
            hasNewMessages = false
            scrollToBottom(proxy, animated: true)
        }
        #if os(iOS)
        .font(.subheadline)
        #endif
        .buttonStyle(.glass)
    }

    private var composer: some View {
        Composer(draft: $draft, files: $pickedFiles, focused: $focused, contextID: draftKey, canSend: client.isConfigured && !client.connectionNeedsPairing && client.openAIAccount?.connected != false) { mode in
            guard client.openAIAccount?.connected != false else { return }
            let value = draft.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !value.isEmpty || !pickedFiles.isEmpty else { return }
            let files = pickedFiles
            pickedFiles = []
            draft = ""
            focused = true
            Task { await client.sendMessage(value, files: files, mode: mode) }
        }
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy, animated: Bool) {
        let conversation = draftKey
        Task { @MainActor in
            await Task.yield()
            guard conversation == draftKey, followsLatest else { return }
            if animated && !reduceMotion {
                withAnimation(.easeOut(duration: 0.22)) {
                    proxy.scrollTo("conversation-bottom", anchor: .bottom)
                } completion: {
                    // A new pending row measures its real height only after the scroll starts.
                    guard conversation == draftKey, followsLatest else { return }
                    proxy.scrollTo("conversation-bottom", anchor: .bottom)
                }
            } else {
                proxy.scrollTo("conversation-bottom", anchor: .bottom)
            }
        }
    }
}

struct OpenAIRecoveryNotice: View {
    @EnvironmentObject private var client: HomeClient
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    #if os(macOS)
    @Environment(\.openSettings) private var openSettings
    #endif
    @State private var showAccounts = false
    /// An employee on an API-key provider needs that key on its device, and one on Grok its sign-in, not an OpenAI sign-in.
    private var provider: String? { client.openAIAccount?.keyProviderName }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if dynamicTypeSize.isAccessibilitySize {
                Text(client.openAIAccount?.providerNeed ?? (client.openAIAccount?.isUnavailable == true ? L("Связь с OpenAI") : L("Вход в OpenAI")))
                    .font(titleFont).accessibilityIdentifier("openAIRecoveryNotice")
                Text(L("Чаты и черновики сохранены.")).font(detailFont).foregroundStyle(AppTheme.secondaryText)
                    .wrapsInFull()
            } else {
                explanation
            }
            if client.openAIAccount?.isUnavailable == true {
                action(L("Проверить ещё раз")) { Task { await client.refreshOpenAIAccount(force: true) } }
                    .disabled(client.isLoading)
            } else if client.canManageOpenAI {
                action(provider.map { L("Подключить \($0)") } ?? L("Войти в OpenAI"), perform: openAccounts)
                    .accessibilityIdentifier("recoverOpenAIAccount")
            } else if dynamicTypeSize.isAccessibilitySize && provider == nil {
                action(L("Как восстановить вход"), perform: openAccounts)
            }
        }.frame(maxWidth: .infinity, alignment: .leading).padding(12)
            .background(AppTheme.surface, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
            .wrapsInFull()
            #if os(iOS)
            .sheet(isPresented: $showAccounts) { SettingsView(initialSection: .accounts) }
            #endif
    }

    // The Mac notice uses the interface size; iOS keeps its compact notice.
    private var titleFont: Font {
        #if os(macOS)
        .body.weight(.medium)
        #else
        .callout.weight(.medium)
        #endif
    }
    private var detailFont: Font {
        #if os(macOS)
        .body
        #else
        .caption
        #endif
    }

    private func action(_ title: String, perform: @escaping () -> Void) -> some View {
        Button(action: perform) {
            #if os(macOS)
            Text(title)
            #else
            AdaptiveActionLabel(title: title)
            #endif
        }
        .adaptiveActionStyle(.glass)
    }

    private func openAccounts() {
        #if os(macOS)
        UserDefaults.standard.set(SettingsView.Section.accounts.rawValue, forKey: "openstrudel.settingsTab")
        openSettings()
        #else
        showAccounts = true
        #endif
    }

    private var explanation: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(client.openAIAccount?.providerNeed ?? (client.openAIAccount?.isUnavailable == true ? L("Не удалось проверить соединение с OpenAI.")
                 : L("Вход в OpenAI нужно восстановить."))).font(titleFont)
                .accessibilityIdentifier("openAIRecoveryNotice")
            Text(client.openAIRecoveryMessage).font(detailFont).foregroundStyle(AppTheme.secondaryText)
                .wrapsInFull()
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

private extension View {
    /// iOS stacks the notice above the transcript, where it must not be squeezed. The Mac window
    /// measures its minimum with a zero width, so a fixed height there would outgrow the window.
    @ViewBuilder func wrapsInFull() -> some View {
        #if os(iOS)
        fixedSize(horizontal: false, vertical: true)
        #else
        self
        #endif
    }
}

/// The employee's character and name. On Mac it is the detail toolbar's navigation item.
struct ConversationTitle: View {
    @EnvironmentObject private var client: HomeClient
    let openEmployee: () -> Void
    var body: some View {
        #if os(macOS)
        if client.isEmployeeDraft {
            // The same inset a toolbar button gives its label, so both capsules match.
            identity.padding(.horizontal, 6)
        } else {
            Button(action: openEmployee) { identity }
                .accessibilityLabel(L("Настройки сотрудника"))
                .accessibilityValue(client.activeAgentName)
                .accessibilityIdentifier("openEmployeeDetails")
                .help(L("Открыть сотрудника «\(client.activeAgentName)»"))
        }
        #else
        VStack(spacing: 2) {
            if !client.isEmployeeDraft {
                Button(action: openEmployee) {
                    identity.frame(minHeight: controlTarget).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(L("Настройки сотрудника"))
                .accessibilityValue(client.activeAgentName)
                .accessibilityIdentifier("openEmployeeDetails")
            } else {
                identity.frame(minHeight: controlTarget)
            }
            if let archive = client.importedConversations.first(where: { $0.id == client.selectedChatID }) {
                Label(L("Archive · \(archive.title)"), systemImage: "archivebox")
                    .labelStyle(.titleAndIcon)
                    .font(AppTypography.meta).foregroundStyle(AppTheme.secondaryText).lineLimit(1)
            }
        }.frame(minHeight: controlTarget).contentShape(Rectangle())
        #endif
    }

    private var identity: some View {
        HStack(spacing: 8) {
            AgentAvatar(appearance: client.activeAppearance, size: AvatarSize.toolbar)
                .offlineCharacter(client.isOffline(client.activeProfile))
            Text(client.activeAgentName).font(.body.weight(.semibold)).lineLimit(1)
        }
        .frame(maxWidth: 240)
    }
}

#if os(macOS)
/// The app conversation and each Telegram chat of this employee. Choosing one only changes
/// which existing transcript is shown; it never rebinds the employee.
struct ConversationSourceMenu: View {
    @EnvironmentObject private var client: HomeClient

    var body: some View {
        let chat = client.employeeTelegramChats.first { $0.conversationId == client.selectedChatID }
        Menu {
            source(title: L("В приложении"), conversation: nil)
            Divider()
            // A Section header here would drop the items' accessibility identifiers.
            ForEach(client.employeeTelegramChats) { chat in
                source(title: chat.title, conversation: chat.conversationId,
                       detail: chat.enabled == false ? L("Telegram · бот на паузе") : "Telegram")
            }
        } label: {
            Label(chat?.title ?? L("В приложении"), systemImage: chat == nil ? "bubble.left" : "paperplane")
                .labelStyle(.titleAndIcon)
        }
        .frame(maxWidth: 240)
        .accessibilityIdentifier("conversationSources")
    }

    private func source(title: String, conversation: String?, detail: String? = nil) -> some View {
        Toggle(isOn: Binding {
            client.selectedChatID == conversation
        } set: { _ in
            guard client.selectedChatID != conversation else { return }
            Task { await client.selectChat(conversation) }
        }) {
            Text(title)
            if let detail { Text(detail) }
        }
        .accessibilityIdentifier(conversation.map { "conversationSource-" + $0 } ?? "conversationSource-app")
    }
}
#else
/// These are views of existing conversations, not new employee bindings.
/// Keep each audience's transcript, tools and draft in its original scope.
struct ConversationSources: View {
    @EnvironmentObject private var client: HomeClient
    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal) {
                HStack(spacing: 8) {
                    source(title: L("В приложении"), symbol: "bubble.left", conversation: nil)
                    ForEach(client.employeeTelegramChats) { chat in
                        source(title: chat.title, symbol: "paperplane", conversation: chat.conversationId,
                               detail: chat.enabled == false ? L("Telegram · бот на паузе") : "Telegram")
                    }
                }.padding(.horizontal, 2)
            }
            .onChange(of: client.selectedChatID, initial: true) {
                proxy.scrollTo(client.selectedChatID ?? "app", anchor: .center)
            }
            .onChange(of: client.employeeTelegramChats.map(\.conversationId)) {
                proxy.scrollTo(client.selectedChatID ?? "app", anchor: .center)
            }
        }
        .scrollIndicators(.hidden)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("conversationSources")
    }

    private func source(title: String, symbol: String, conversation: String?, detail: String? = nil) -> some View {
        let selected = client.selectedChatID == conversation
        return Button { Task { await client.selectChat(conversation) } } label: {
            Label(title, systemImage: symbol)
                .font(.subheadline.weight(selected ? .semibold : .regular))
                .padding(.horizontal, 12)
                .frame(minHeight: controlTarget)
                .contentShape(Capsule())
                .background(selected ? Color.primary.opacity(0.10) : Color.clear, in: Capsule())
        }
        .buttonStyle(.plain)
        .foregroundStyle(selected ? Color.primary : AppTheme.secondaryText)
        .accessibilityLabel(detail.map { title + ", " + $0 } ?? title)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier(conversation.map { "conversationSource-" + $0 } ?? "conversationSource-app")
        .help(detail.map { title + " · " + $0 } ?? title)
        .id(conversation ?? "app")
    }
}
#endif

/// The conversation's edges: 32 from the detail edges and under the Mac toolbar, the 16 margin on iOS;
/// the composer 24 above the Mac window edge and 20 above the iOS safe area.
private extension Layout {
    #if os(macOS)
    static let edge: CGFloat = 32
    static let belowToolbar: CGFloat = 32
    static let belowComposer: CGFloat = 24
    #else
    static let edge: CGFloat = 16
    static let belowToolbar: CGFloat = 24
    static let belowComposer: CGFloat = 20
    #endif
}
