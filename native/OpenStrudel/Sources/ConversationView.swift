import SwiftUI

/// The details sheet's subject, fixed when it opens.
private struct EmployeeDetailsPresentation: Identifiable {
    let profile: EmployeeProfile?
    var id: String { profile?.id ?? "main" }
}

/// The one chat: the main assistant of the chosen Home, with the only composer in the app. Its draft, files and attached
/// context stay with this Home's canonical draft key whatever is read or set up meanwhile.
struct ConversationView: View {
    @EnvironmentObject private var library: DeviceLibrary
    @EnvironmentObject private var client: HomeClient
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    #if os(macOS)
    @Environment(\.openSettings) private var openSettings
    #else
    @Binding var showSettings: Bool
    #endif
    /// Opens the conversations this chat can read.
    let openHistory: () -> Void
    @State private var draft = ""
    @State private var pickedFiles: [PickedFile] = []
    @State private var context: ChatContext?
    @State private var details: EmployeeDetailsPresentation?
    @State private var followsLatest = true
    @State private var userIsScrolling = false
    @State private var hasNewMessages = false
    @FocusState private var focused: Bool
    private var draftKey: String { HomeDrafts.key(home: client.baseURLString, profile: client.selectedProfileID, chat: client.selectedChatID) }

    var body: some View {
        ScrollViewReader { proxy in
            #if os(macOS)
            // The transcript runs under the toolbar and the composer; the system draws the scroll edges.
            transcript(proxy)
                .safeAreaBar(edge: .top, spacing: 0) { topBar }
                .safeAreaBar(edge: .bottom, spacing: 0) { bottomBar(proxy) }
            #else
            VStack(spacing: 0) {
                EmployeeMoveStatusButton()
                if showsConnectionBanner {
                    connectionBanner.padding(.horizontal, Layout.edge).padding(.vertical, 8)
                }
                if showsRecoveryNotice {
                    OpenAIRecoveryNotice()
                        .padding(.horizontal, Layout.edge).padding(.vertical, 8)
                }
                // Animate scrolling, not pending-row replacement: an implicit
                // layout animation can loop while the iPad keyboard is visible.
                transcript(proxy)
                    .safeAreaBar(edge: .bottom, spacing: 0) { bottomBar(proxy) }
            }
            #endif
        }
        .task { draft = library.draft(for: draftKey); pickedFiles = library.fileDrafts[draftKey] ?? []; context = library.draftContext(for: draftKey) }
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
        .onChange(of: context) { _, value in
            guard library.active === client else { return }
            library.saveDraftContext(value, for: draftKey)
        }
        // "Обсудить" in a reader or a client attaches to this draft; it shows at once.
        .onChange(of: library.draftContext(for: draftKey)) { _, value in
            if value != context { context = value }
        }
        .onChange(of: draftKey) { old, new in
            guard library.active === client else { return }
            library.saveDraft(draft, for: old)
            draft = library.draft(for: new)
            library.fileDrafts[old] = pickedFiles
            pickedFiles = library.fileDrafts[new] ?? []
            library.saveDraftContext(context, for: old)
            context = library.draftContext(for: new)
            focused = false
        }
        #if os(macOS)
        .navigationTitle(client.activeAgentName)
        .toolbar {
            ToolbarItem(placement: .navigation) {
                ConversationTitle { openDetails() }
            }
            ToolbarItem(placement: .primaryAction) { historyButton }
        }
        .focusedSceneValue(\.showEmployeeDetails, { openDetails() })
        #else
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { historyButton }
            ToolbarItem(placement: .principal) {
                ConversationTitle { focused = false; openDetails() }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { focused = false; showSettings = true } label: { Image(systemName: "gearshape") }
                    .foregroundStyle(.primary).accessibilityLabel(L("Настройки"))
            }
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

    /// Every other conversation of every Home, read from here.
    private var historyButton: some View {
        Button { focused = false; openHistory() } label: { Image(systemName: "clock.arrow.circlepath") }
            .foregroundStyle(.primary)
            .accessibilityLabel(L("Переписки"))
            .accessibilityIdentifier("openChats")
            .help(L("Переписки и ленты (⌘F)"))
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

    /// A loaded conversation, or one that cannot load right now.
    private var showsEmptyChat: Bool {
        client.conversationID != nil || client.health == nil || client.homeUnreachable || client.syncError != nil
    }

    private var showsConnectionBanner: Bool { client.connectionNeedsPairing || client.homeUnreachable || client.health == nil }
    private var showsRecoveryNotice: Bool { client.openAIAccount?.connected == false && !client.homeUnreachable && client.health != nil }

    /// The new-messages button, the drafts of other conversations and the composer, on the transcript column's edges.
    private func bottomBar(_ proxy: ScrollViewProxy) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if hasNewMessages && !followsLatest {
                newMessagesButton(proxy).frame(maxWidth: .infinity)
            }
            if !previousDrafts.isEmpty {
                Menu(L("Черновики прежних переписок")) {
                    ForEach(previousDrafts, id: \.key) { saved in
                        Button(L("Вставить в сообщение: \(saved.title)")) {
                            let oldFiles = library.fileDrafts[saved.key] ?? []
                            draft = [draft, library.draft(for: saved.key)].filter { !$0.isEmpty }.joined(separator: "\n\n")
                            pickedFiles += oldFiles
                            if context == nil, let attached = library.draftContext(for: saved.key) { context = attached }
                            library.saveDraft("", for: saved.key); library.fileDrafts[saved.key] = nil; library.saveDraftContext(nil, for: saved.key)
                        }
                    }
                }
                .font(AppTypography.meta)
                .accessibilityIdentifier("previousDrafts")
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

    /// Words, files and contexts saved for this Home's other conversations, including an employee an earlier version
    /// was writing to: nothing typed is lost when the chat becomes the one place to write.
    private var previousDrafts: [(key: String, title: String)] {
        library.savedDrafts(on: client).map { saved in
            let who = saved.profile.map { id in id.hasPrefix("draft:") ? L("Новый сотрудник") : client.profiles.first { $0.id == id }?.name ?? L("Сотрудник") }
            let chat = saved.chat.map { id in
                (client.telegram?.chats ?? []).first { $0.conversationId == id }?.title ?? client.importedConversations.first { $0.id == id }?.title ?? (id.hasPrefix("telegram-reply:") ? "Telegram" : L("Переписка"))
            }
            let title = [who, chat].compactMap { $0 }.joined(separator: " · ")
            return (saved.key, title.isEmpty ? L("Черновик") : title)
        }
    }

    #if os(macOS)
    /// Connection state and the OpenAI notice sit above the transcript in the column.
    @ViewBuilder private var topBar: some View {
        if showsConnectionBanner || showsRecoveryNotice {
            VStack(alignment: .leading, spacing: 8) {
                if showsConnectionBanner { connectionBanner }
                if showsRecoveryNotice { OpenAIRecoveryNotice() }
            }
            .frame(maxWidth: Layout.column, alignment: .leading)
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
        Composer(draft: $draft, files: $pickedFiles, context: $context, focused: $focused, contextID: draftKey, canSend: client.isConfigured && !client.connectionNeedsPairing && client.openAIAccount?.connected != false) { mode in
            guard client.openAIAccount?.connected != false else { return }
            let value = draft.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !value.isEmpty || !pickedFiles.isEmpty else { return }
            let files = pickedFiles, attached = context
            pickedFiles = []
            draft = ""
            context = nil
            focused = true
            Task { await client.sendMessage(value, files: files, mode: mode, context: attached) }
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
        Button(action: openEmployee) { identity }
            .accessibilityLabel(L("Настройки сотрудника"))
            .accessibilityValue(client.activeAgentName)
            .accessibilityIdentifier("openEmployeeDetails")
            .help(L("Открыть сотрудника «\(client.activeAgentName)»"))
        #else
        Button(action: openEmployee) {
            identity.frame(minHeight: controlTarget).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(L("Настройки сотрудника"))
        .accessibilityValue(client.activeAgentName)
        .accessibilityIdentifier("openEmployeeDetails")
        .frame(minHeight: controlTarget).contentShape(Rectangle())
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

/// The conversation's edges: 32 from the detail edges and under the Mac toolbar, the 16 margin on iOS;
/// the composer 24 above the Mac window edge and 20 above the iOS safe area.
extension Layout {
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
