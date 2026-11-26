import SwiftUI

/// The details sheet's subject, fixed when it opens.
private struct EmployeeDetailsPresentation: Identifiable {
    let profile: EmployeeProfile?
    var id: String { profile?.id ?? "main" }
}

/// A chat: the main assistant of the chosen Home, or one employee of any Home, with its composer. The page owns its
/// Home's selection while it is in front: it chooses its own subject when it appears and gives the main assistant back
/// when it leaves. Its draft, files and attached context stay under its own key whatever is read or set up meanwhile.
struct ConversationView: View {
    @EnvironmentObject private var library: DeviceLibrary
    @EnvironmentObject private var client: HomeClient
    @EnvironmentObject private var marks: TeamReadMarks
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    #if os(macOS)
    @Environment(\.openSettings) private var openSettings
    #else
    @Binding var showSettings: Bool
    #endif
    /// The employee this page writes to; nil is the Home's main assistant.
    var subject: String? = nil
    /// Counts the times the chat was opened to write; the composer takes the keyboard on each.
    var writes = 0
    /// The chat was opened from the composer capsule: the keyboard comes up with it.
    var startsWriting = false
    /// A sheet of the app is over the chat.
    var covered = false
    /// Opens the conversations this chat can read.
    let openHistory: () -> Void
    @State private var startedWriting = false
    /// The count of `writes` this chat has already answered; nil until it has seen the one it was opened with.
    @State private var opened: Int?
    /// The composer was asked to take the keyboard, and has not yet.
    @State private var wantsKeyboard = false
    /// The page stands still on screen. On a phone UIKit says when; a Mac window has no transition to wait for.
    #if os(iOS)
    @State private var arrived = false
    #else
    @State private var arrived = true
    #endif
    @State private var draft = ""
    @State private var pickedFiles: [PickedFile] = []
    @State private var context: ChatContext?
    @State private var details: EmployeeDetailsPresentation?
    @State private var followsLatest = true
    @State private var userIsScrolling = false
    @State private var hasNewMessages = false
    @State private var onScreen = false
    @FocusState private var focused: Bool
    #if os(macOS)
    @Environment(\.appearsActive) private var windowIsActive
    #else
    @Environment(\.scenePhase) private var scenePhase
    private var windowIsActive: Bool { scenePhase == .active }
    #endif
    /// Each page keeps its own words: the main chat's, or one employee's.
    private var draftKey: String { HomeDrafts.key(home: client.baseURLString, profile: subject, chat: nil) }
    /// The Home's selection is this page's: what the client holds is this page's conversation.
    private var isShown: Bool { client.selectedProfileID == subject && (subject != nil || client.selectedChatID == nil) }
    private var subjectProfile: EmployeeProfile? { subject.flatMap { id in client.profiles.first { $0.id == id } } }
    /// When the employee's newest answer on this page was written.
    private var newestAnswer: String? { isShown ? client.messages.last { $0.direction == "outbound" }?.createdAt : nil }
    /// Whose chat this is, also in the moment before the Home's selection has followed the page.
    private var title: String { subject == nil ? (isShown ? client.activeAgentName : "OpenStrudel") : subjectProfile?.name ?? client.activeAgentName }
    private var appearance: AgentAppearance? { subject == nil ? (isShown ? client.activeAppearance : nil) : subjectProfile?.resolvedAppearance }

    var body: some View {
        ScrollViewReader { proxy in
            #if os(macOS)
            // The transcript runs under the toolbar and the composer; the system draws the scroll edges.
            transcript(proxy)
                .safeAreaBar(edge: .top, spacing: 0) { VStack(spacing: 0) { topBar }.frame(maxWidth: .infinity).topFade() }
                .safeAreaBar(edge: .bottom, spacing: 0) { bottomBar(proxy) }
            #else
            // The transcript runs under the title capsule and the composer, as on the Mac; what must be said about
            // the connection sits above it.
            // Animate scrolling, not pending-row replacement: an implicit
            // layout animation can loop while the iPad keyboard is visible.
            transcript(proxy)
                .safeAreaBar(edge: .top, spacing: 0) {
                    VStack(spacing: 0) {
                        EmployeeMoveStatusButton()
                        if let profile = subjectProfile, isShown {
                            EmployeeHeader(profile: profile, conversationID: client.conversationID) { focused = false; openDetails() }
                        }
                        if showsConnectionBanner {
                            connectionBanner.padding(.horizontal, Layout.edge).padding(.vertical, 8)
                        }
                        if showsRecoveryNotice {
                            OpenAIRecoveryNotice()
                                .padding(.horizontal, Layout.edge).padding(.vertical, 8)
                        }
                    }
                    .frame(maxWidth: .infinity).topFade()
                }
                .safeAreaBar(edge: .bottom, spacing: 0) { bottomBar(proxy) }
            #endif
        }
        .task { draft = library.draft(for: draftKey); pickedFiles = library.fileDrafts[draftKey] ?? []; context = library.draftContext(for: draftKey) }
        // The page in front chooses its own conversation; an employee's page gives the main assistant back when it leaves.
        .task { await takeSelection() }
        .onAppear { onScreen = true }
        .onDisappear {
            onScreen = false
            guard let subject else { return }
            Task { if client.selectedProfileID == subject { await client.selectProfile(nil) } }
        }
        // The chat's own Home is kept current by the app; an employee of another Home is followed while its page is open.
        .task(id: subject) {
            guard subject != nil, library.primary !== client else { return }
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(client.health == nil ? 5 : 1)) } catch { break }
                if client.health != nil, isShown { await client.refreshConversation() }
            }
        }
        // What is on screen in the active window has been read, up to the newest answer it shows.
        .onChange(of: [subjectProfile?.previewAt ?? "", newestAnswer ?? "", String(onScreen && windowIsActive && isShown)], initial: true) { _, _ in
            if onScreen, windowIsActive, isShown, let profile = subjectProfile { marks.see(profile, on: client, through: newestAnswer) }
        }
        .task {
            // Once: coming back from a page the chat led to does not raise the keyboard again.
            guard startsWriting, !startedWriting else { return }
            startedWriting = true
            wantsKeyboard = true
        }
        // «Спросить про…» from a page over the chat asks for the keyboard as well.
        .task(id: writes) {
            guard let answered = opened, writes > answered else { opened = writes; return }
            opened = writes
            wantsKeyboard = true
        }
        // The keyboard comes up only once the page has really arrived: raised while the chat is still growing out of
        // a capsule, or still coming back from under another page, it left the composer underneath it.
        #if os(iOS)
        .background { Arrival { arrived = true }.frame(width: 0, height: 0).accessibilityHidden(true) }
        #endif
        .onChange(of: arrived) { _, _ in raiseKeyboard() }
        .onChange(of: wantsKeyboard) { _, _ in raiseKeyboard() }
        // A page over the chat, or the way back home, takes the keyboard down with it.
        .onDisappear {
            focused = false
            #if os(iOS)
            arrived = false
            #endif
        }
        // A menu hands the keyboard back to the field it took it from, even when its item opened a sheet over the chat.
        .onChange(of: focused) { _, now in if now && (covered || details != nil) { focused = false } }
        .onChange(of: client.openAIAccount?.connected) { _, connected in
            if connected == false { focused = false }
        }
        .onChange(of: pickedFiles) { _, value in
            guard library.active === client || subject != nil else { return }
            library.fileDrafts[draftKey] = value
        }
        .onChange(of: draft) { _, value in
            guard library.active === client || subject != nil else { return }
            library.saveDraft(value, for: draftKey)
        }
        .onChange(of: context) { _, value in
            guard library.active === client || subject != nil else { return }
            library.saveDraftContext(value, for: draftKey)
        }
        // "Обсудить" in a reader or a client attaches to this draft; it shows at once.
        .onChange(of: library.draftContext(for: draftKey)) { _, value in
            if value != context { context = value }
        }
        .onChange(of: draftKey) { old, new in
            guard library.active === client || subject != nil else { return }
            library.saveDraft(draft, for: old)
            draft = library.draft(for: new)
            library.fileDrafts[old] = pickedFiles
            pickedFiles = library.fileDrafts[new] ?? []
            library.saveDraftContext(context, for: old)
            context = library.draftContext(for: new)
            focused = false
        }
        .navigationTitle(title)
        #if os(macOS)
        .focusedSceneValue(\.showEmployeeDetails, { openDetails() })
        #else
        .navigationBarTitleDisplayMode(.inline)
        .containerBackground(AppTheme.canvas, for: .navigation)
        #endif
        .toolbar {
            // Whose chat this is, in a capsule; it opens the assistant's details.
            ToolbarItem(placement: .principal) {
                TitleCapsule(appearance: appearance, name: title, offline: client.isOffline(subjectProfile)) { focused = false; openDetails() }
                    .accessibilityLabel(L("Настройки сотрудника"))
                    .accessibilityValue(title)
                    .accessibilityIdentifier("openEmployeeDetails")
                    .help(L("Открыть сотрудника «\(title)»"))
            }
            ToolbarItem(placement: .primaryAction) { more }
        }
        .sheet(item: $details) { presentation in
            if let profile = presentation.profile {
                BotDetailsView(profile: profile).environmentObject(client)
            } else {
                MainAssistantDetailsView().environmentObject(client)
            }
        }
    }

    /// What the chat's bar offers, behind one quiet button: every other conversation of every Home, the assistant's
    /// details and, on a phone, the settings.
    private var more: some View {
        Menu {
            Button(L("Переписки"), systemImage: "clock.arrow.circlepath") { focused = false; openHistory() }
                .accessibilityIdentifier("chatHistory")
            Button(L("Настройки сотрудника"), systemImage: "slider.horizontal.3") { focused = false; openDetails() }
            #if os(iOS)
            Button(L("Настройки"), systemImage: "gearshape") { focused = false; showSettings = true }
                .accessibilityIdentifier("chatSettings")
            #endif
        } label: { Image(systemName: "ellipsis") }
        .menuIndicator(.hidden)
        .accessibilityLabel(L("Ещё"))
        .accessibilityIdentifier("chatMore")
    }

    private func openDetails() {
        details = EmployeeDetailsPresentation(profile: subject == nil ? nil : subjectProfile)
    }

    /// Makes the Home's selection this page's. A page that is not in front yet shows nothing of another conversation.
    private func takeSelection() async {
        if let subject {
            if client.selectedProfileID != subject { await client.selectProfile(subject) }
        } else if client.selectedProfileID != nil || client.selectedChatID != nil {
            await client.selectProfile(nil)
        }
    }

    private func raiseKeyboard() {
        guard wantsKeyboard, arrived, !covered, details == nil else { return }
        wantsKeyboard = false
        focused = true
    }

    private func transcript(_ proxy: ScrollViewProxy) -> some View {
        ScrollView {
            if !isShown {
                // The moment before the Home's selection follows the page: an empty canvas, never another conversation.
                Color.clear.frame(maxWidth: .infinity, minHeight: 430)
            } else if client.feedMessages.isEmpty && client.visiblePendingMessages.isEmpty {
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
        // The paper closes over the transcript at the top (`topFade`); the system adds only its soft edge, never a rule.
        .scrollEdgeEffectStyle(.soft, for: .top)
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
        .dockFade()
        // A growing composer keeps the latest message and its 24 of room above the glass.
        // A size-change scroll anchor would loop the lazy rows (see TranscriptStack).
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { _ in
            if followsLatest { scrollToBottom(proxy, animated: false) }
        }
    }

    /// Words, files and contexts saved for this Home's conversations that no page writes to any more, such as a
    /// Telegram chat an earlier version replied in. An employee's words wait on its own page. Only the main chat offers them.
    private var previousDrafts: [(key: String, title: String)] {
        guard subject == nil else { return [] }
        return library.savedDrafts(on: client).filter { saved in
            !(saved.chat == nil && saved.profile.map { id in client.profiles.contains { $0.id == id } } == true)
        }.map { saved in
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
        let profile = isShown ? subjectProfile : nil
        if showsConnectionBanner || showsRecoveryNotice || profile != nil {
            VStack(alignment: .leading, spacing: 8) {
                if let profile { EmployeeHeader(profile: profile, conversationID: client.conversationID) { openDetails() } }
                if showsConnectionBanner { connectionBanner }
                if showsRecoveryNotice { OpenAIRecoveryNotice() }
            }
            .frame(maxWidth: Layout.column, alignment: .leading)
            .padding(.horizontal, Layout.edge)
            .padding(.top, profile == nil ? 16 : 0)
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
        Composer(draft: $draft, files: $pickedFiles, context: $context, focused: $focused, contextID: draftKey, canSend: isShown && client.isConfigured && !client.connectionNeedsPairing && client.openAIAccount?.connected != false) { mode in
            guard client.openAIAccount?.connected != false, isShown else { return }
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
        }.frame(maxWidth: .infinity, alignment: .leading).padding(16)
            .cardTile(radius: 22)
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

/// The conversation's edges: 32 from the detail edges and under the Mac toolbar, the 16 margin on iOS;
/// the composer 24 above the Mac window edge and 20 above the iOS safe area.
extension Layout {
    #if os(macOS)
    static let edge: CGFloat = 32
    static let belowToolbar: CGFloat = 32
    static let belowComposer: CGFloat = 24
    #else
    static let edge: CGFloat = 22
    static let belowToolbar: CGFloat = 24
    static let belowComposer: CGFloat = 8
    #endif
}

#if os(iOS)
/// Tells when a page has really arrived: UIKit's own word that the transition is over. SwiftUI's `onAppear` comes at
/// its start.
private struct Arrival: UIViewControllerRepresentable {
    let arrived: () -> Void
    func makeUIViewController(context: Context) -> Controller { Controller() }
    func updateUIViewController(_ controller: Controller, context: Context) { controller.arrived = arrived }
    final class Controller: UIViewController {
        var arrived: () -> Void = {}
        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            arrived()
        }
    }
}
#endif
