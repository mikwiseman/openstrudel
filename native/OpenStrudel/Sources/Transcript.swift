import SwiftUI
import QuickLook
import UniformTypeIdentifiers

/// An empty conversation: the character, its name and its role, optically centred at 40 %.
/// The focused composer is the action.
struct EmptyChat: View {
    @EnvironmentObject private var library: DeviceLibrary
    @EnvironmentObject private var client: HomeClient

    var body: some View {
        OpticalCentre {
            VStack(spacing: 0) {
                AgentAvatar(appearance: client.activeAppearance, size: AvatarSize.hero)
                Text(client.isEmployeeDraft ? L("Создайте сотрудника") : client.activeProfile?.name ?? L("Напишите, что нужно"))
                    .font(AppTypography.display)
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
                    .padding(.top, 16)
                detail
            }
            .frame(maxWidth: 360)
            .padding(.horizontal, 24)
        }
        .containerRelativeFrame(.vertical)
        .frame(maxWidth: .infinity)
    }

    @ViewBuilder private var detail: some View {
        if client.isEmployeeDraft {
            // The composer's placeholder asks for the role; this line only shows what an answer looks like.
            BalancedLines { line(L("Например: «Редактор, который помогает писать короткие посты»."), limit: nil) }
            if library.employeeDestinations.count > 1 {
                // The composer is the action; choosing the device is a quiet text menu in the line's place.
                Menu {
                    EmployeeDestinationChoices { destination in
                        library.chooseEmployeeDevice(destination.client, deviceID: destination.deviceID)
                    }
                } label: {
                    Text(L("Create on \(client.executionDeviceName)"))
                        .font(AppTypography.interface.weight(.medium))
                        .foregroundStyle(AppTheme.accentText)
                }
                .menuStyle(.button)
                .buttonStyle(.borderless)
                .menuIndicator(.visible)
                .tint(AppTheme.accentText)
                .fixedSize()
                .frame(minHeight: controlTarget)
                .padding(.top, 8)
                .accessibilityLabel(L("Где будет работать сотрудник"))
                .accessibilityValue(client.executionDeviceName)
                .accessibilityIdentifier("employeeCreationDevice")
            }
        } else if client.homeUnreachable || client.connectionNeedsPairing {
            line(L("История появится после подключения к устройству."), limit: 2)
        } else if let profile = client.activeProfile {
            line(profile.roleText.isEmpty ? L("Напишите, что нужно.") : profile.roleText, limit: 2)
        }
    }

    private func line(_ text: String, limit: Int?) -> some View {
        Text(text)
            .font(AppTypography.interface)
            .foregroundStyle(AppTheme.secondaryText)
            .multilineTextAlignment(.center)
            .lineLimit(limit)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, 8)
    }
}

/// A centred time heading where a new day starts or after half an hour of quiet.
struct ClusterHeader: View {
    let date: Date
    let hasTime: Bool

    var body: some View {
        Text(ChatClock.cluster(date, hasTime: hasTime))
            .font(AppTypography.meta)
            .foregroundStyle(AppTheme.secondaryText)
            .monospacedDigit()
            .frame(maxWidth: .infinity)
            .accessibilityAddTraits(.isHeader)
    }
}

/// One message. The person writes in a trailing bubble; the employee answers in open text
/// on the canvas; other people in imported history or a Telegram group write on the surface.
struct MessageBubble: View {
    @EnvironmentObject private var client: HomeClient
    @State private var previewURL: URL?
    @State private var telegramReply: TelegramReplyTarget?
    let message: HomeMessage
    /// Other people write here too (a Telegram group or history from several people),
    /// so inbound messages sit on the surface under their author.
    let shared: Bool
    let bubbleWidth: CGFloat
    /// The row shown above, so the source and the quoted request follow what is on screen.
    var previous: HomeMessage?
    /// A time heading above already shows this message's time.
    var headed = false
    /// The direction of the employee's text. The person's bubbles sit on the opposite edge,
    /// so the two sides never start on the same edge in either interface direction.
    var replySide: LayoutDirection?

    private var isInbound: Bool { message.direction == "inbound" }
    private var fromSomeoneElse: Bool { isInbound && shared }
    /// The owner wrote it through the explicit Telegram reply, so it sits on the person's side.
    private var ownerReply: Bool { MessagePages.isOwnerReply(message) }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let origin = message.origin, let line = MessagePages.sourceLine(message), isInbound || ownerReply || previous?.conversationId != message.conversationId {
                // A request's line sits over its bubble text, where its author used to be.
                sourceCaption(line, origin: origin).lineLimit(1).padding(.leading, fromSomeoneElse ? 16 : 0)
                    .frame(maxWidth: .infinity, alignment: ownerReply ? .trailing : .leading)
            } else if message.direction == "inbound", client.messages.contains(where: { $0.origin?.channel == "telegram" }) {
                Text(L("В приложении")).modifier(MetaLine()).frame(maxWidth: .infinity, alignment: .trailing)
            }
            if let parentID = message.replyToId, message.channel == "telegram", previous?.id != parentID,
               let parent = client.messages.first(where: { $0.id == parentID }) {
                Text(L("В ответ на: \(String(parent.text.prefix(140)))"))
                    .modifier(MetaLine()).lineLimit(2).multilineTextAlignment(ownerReply ? .trailing : .leading)
                    .frame(maxWidth: .infinity, alignment: ownerReply ? .trailing : .leading)
            }
            if let scheduleTitle = message.scheduleTitle {
                VStack(alignment: .leading, spacing: 4) {
                    Label(withTime(scheduleTitle), systemImage: "clock").modifier(MetaLine())
                    if let error = message.error { warning(error) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            } else if message.kind == "notice" {
                Label(withTime(L10n.text(message.text)), systemImage: "checkmark").modifier(MetaLine())
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else if fromSomeoneElse {
                someoneElse
            } else if isInbound || ownerReply {
                person
            } else {
                employee
            }
            if message.direction == "inbound", message.channel == "telegram", message.status == "queued" || message.status == "running" {
                Label(L("Готовим ответ…"), systemImage: "ellipsis").modifier(MetaLine())
            }
            if let delivery = message.delivery, let notice = MessagePages.deliveryNotice(delivery) {
                VStack(alignment: ownerReply ? .trailing : .leading, spacing: 0) {
                    Text(notice).modifier(MetaLine())
                        .foregroundStyle(delivery.state == "unknown" || delivery.state == "not_sent" ? AppTheme.warning : AppTheme.secondaryText)
                        .padding(.trailing, ownerReply ? 16 : 0)
                    deliveryRecovery
                }
                .frame(maxWidth: .infinity, alignment: ownerReply ? .trailing : .leading)
            }
        }
        .quickLookPreview($previewURL)
        .sheet(item: $telegramReply) { target in
            TelegramReplySheet(message: target.request, prepared: target.prepared).environmentObject(client).modifier(InterfaceLanguage())
        }
    }

    /// The one action next to a reply Telegram did not take or did not confirm. Never a silent resend.
    @ViewBuilder private var deliveryRecovery: some View {
        switch MessagePages.deliveryAction(for: message, in: client.messages, canReply: client.canManageOpenAI) {
        case .open(let url)?:
            Link(L("Открыть в Telegram"), destination: url).modifier(StatusAction())
        case .resend(let request)?:
            Button(L("Отправить ещё раз…")) { telegramReply = TelegramReplyTarget(request: request, prepared: message.text) }
                .modifier(StatusAction()).accessibilityIdentifier("resendTelegramReply-" + message.id)
        case nil:
            EmptyView()
        }
    }

    @ViewBuilder private func sourceCaption(_ line: String, origin: MessageOrigin) -> some View {
        if let raw = origin.url, let url = URL(string: raw), url.scheme == "https", url.host == "t.me" {
            Link(line, destination: url).modifier(MetaLine()).accessibilityLabel(L("Открыть в Telegram: \(origin.title)"))
        } else { Text(line).modifier(MetaLine()) }
    }

    /// A Telegram request the owner can answer here.
    private var canReply: Bool { message.origin?.canReply == true && client.canManageOpenAI }

    /// A request's Reply, in its context menu and its accessibility actions. Selectable text would take the
    /// right-click and the long press from this menu, so such a request is plain text and Copy lives here.
    /// Without Reply there is no menu, and the text keeps its selection and the system Copy.
    @ViewBuilder private var requestActions: some View {
        if canReply {
            Button(L("Ответить в Telegram"), systemImage: "arrowshape.turn.up.left") { telegramReply = TelegramReplyTarget(request: message) }
                .accessibilityIdentifier("telegramReply-" + message.id)
            if !message.text.isEmpty {
                Button(L("Скопировать"), systemImage: "doc.on.doc") {
                    #if os(macOS)
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(message.text, forType: .string)
                    #else
                    UIPasteboard.general.string = message.text
                    #endif
                }
            }
        }
    }

    private var person: some View {
        VStack(alignment: .trailing, spacing: 4) {
            VStack(alignment: .trailing, spacing: 8) {
                if message.text.isEmpty { EmptyView() }
                else if message.imported == true { ImportedMessageText(source: message.text, fill: AppTheme.userBubble, alignment: .trailing) }
                else { ChatBubble(text: message.text) }
                attachments
            }
            if message.status == "queued" { Text(L("В очереди")).modifier(MetaLine()).padding(.trailing, 16) }
            // A reply's Telegram delivery speaks for itself below.
            if let error = message.error, message.delivery == nil { warning(error).multilineTextAlignment(.trailing).padding(.trailing, 16) }
        }
        .frame(maxWidth: bubbleWidth, alignment: .trailing)
        .frame(maxWidth: .infinity, alignment: .trailing)
        .paragraphDirection(replySide)
    }

    private var someoneElse: some View {
        // A Telegram request names its author in its one source line.
        let author = message.origin?.channel == "telegram" ? "" : [message.author, headed ? nil : message.time].compactMap { $0 }.joined(separator: " · ")
        return VStack(alignment: .leading, spacing: 4) {
            if !author.isEmpty { Text(author).modifier(MetaLine()).padding(.leading, 16) }
            VStack(alignment: .leading, spacing: 8) {
                if message.text.isEmpty { EmptyView() }
                else if message.imported == true { ImportedMessageText(source: message.text) }
                else { ChatBubble(text: message.text, fill: AppTheme.surface, selectable: !canReply) }
                attachments
            }
            if let error = message.error { warning(error, selectable: !canReply).padding(.leading, 16) }
        }
        // The whole request answers, so one whose file never arrived still offers Reply on its error.
        .contextMenu { requestActions }
        .accessibilityActions { requestActions }
        .frame(maxWidth: bubbleWidth, alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var employee: some View {
        VStack(alignment: .leading, spacing: 12) {
            if !message.text.isEmpty { MessageContent(source: message.text).equatable() }
            attachments
            if let error = message.error { warning(error) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // Pictures and files keep to the reply's own text edge, never the person's side.
        .paragraphDirection(of: message.text)
    }

    @ViewBuilder private var attachments: some View {
        ForEach(message.attachments ?? []) { file in
            if file.mimeType.hasPrefix("image/") {
                ChatImage(name: file.name, identity: file.id) { try await client.downloadFile(file) }
            } else {
                Button {
                    Task { previewURL = await client.previewFile(file) }
                } label: {
                    FileChip(icon: file.icon, name: file.name, detail: file.sizeLabel)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(L("Open \(file.name)"))
            }
        }
    }

    @ViewBuilder private func warning(_ error: String, selectable: Bool = true) -> some View {
        let text = Text(UserFacingError.text(error))
            .font(AppTypography.meta)
            .foregroundStyle(AppTheme.warning)
            .fixedSize(horizontal: false, vertical: true)
        if selectable { text.textSelection(.enabled) } else { text }
    }

    private func withTime(_ text: String) -> String {
        [text, message.time].compactMap { $0 }.joined(separator: " · ")
    }
}

/// The Telegram request a reply answers, and the text prepared for it, if any.
private struct TelegramReplyTarget: Identifiable {
    let request: HomeMessage
    var prepared = ""
    var id: String { request.id }
}

/// An explicit destination, separate from the private app composer. Drafts are
/// scoped to the original request; sending uses the client's durable queue.
private struct TelegramReplySheet: View {
    @EnvironmentObject private var client: HomeClient
    @EnvironmentObject private var library: DeviceLibrary
    @Environment(\.dismiss) private var dismiss
    let message: HomeMessage
    /// A reply Telegram did not take: its text, offered again until the owner sends or edits it.
    var prepared = ""
    @State private var text = ""
    @State private var files: [PickedFile] = []
    @State private var choosingFiles = false
    @State private var importing = false
    @State private var error: String?
    private var title: String { message.origin?.title ?? "Telegram" }
    private var key: String { HomeDrafts.key(home: client.baseURLString, profile: client.selectedProfileID, chat: "telegram-reply:" + message.id) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Label(title, systemImage: "paperplane")
                    Text(message.text).lineLimit(4).foregroundStyle(AppTheme.secondaryText)
                }
                Section {
                    TextField(L("Ваш ответ"), text: $text, axis: .vertical).lineLimit(4...10)
                        .accessibilityIdentifier("telegramReplyText")
                    ForEach(files) { file in
                        HStack {
                            Text(file.name).lineLimit(1)
                            Spacer()
                            Button { files.removeAll { $0.id == file.id } } label: { Image(systemName: "xmark.circle") }
                                .accessibilityLabel(L("Remove \(file.name)"))
                        }
                    }
                    Button(L("Прикрепить файл…"), systemImage: "paperclip") { choosingFiles = true }
                        .disabled(importing)
                } footer: { Text(L("Ответ будет опубликован в этой группе от имени бота.")) }
                if let error { Text(error).foregroundStyle(AppTheme.warning) }
            }
            .formStyle(.grouped)
            .navigationTitle(L("Ответить в Telegram"))
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(L("Отмена")) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    // The sheet names the group; a long title would hide the action in the overflow menu.
                    Button(L("Отправить")) { send() }
                        .disabled(importing || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .accessibilityIdentifier("sendTelegramReply")
                }
            }
        }
        #if os(macOS)
        .frame(width: 560, height: 460)
        #endif
        .task { text = library.draft(for: key); if text.isEmpty { text = prepared }; files = library.fileDrafts[key] ?? [] }
        .onChange(of: text) { _, value in library.saveDraft(value, for: key) }
        .onChange(of: files) { _, value in library.fileDrafts[key] = value }
        .fileImporter(isPresented: $choosingFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            Task {
                importing = true; defer { importing = false }
                do {
                    let urls = try result.get()
                    files += try await AttachmentImport.files(at: urls)
                    error = nil
                } catch { if !AttachmentImport.isCancellation(error) { self.error = error.localizedDescription } }
            }
        }
    }

    private func send() {
        do {
            try client.sendTelegramReply(to: message, text: text, files: files)
            text = ""; files = []
            library.saveDraft("", for: key); library.fileDrafts[key] = nil
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
}

/// Status, captions and times: the meta size in the secondary colour with tabular figures.
private struct MetaLine: ViewModifier {
    func body(content: Content) -> some View {
        content
            .font(AppTypography.meta)
            .foregroundStyle(AppTheme.secondaryText)
            .monospacedDigit()
    }
}

/// A message on its way: the same bubble as a sent one, so delivery changes nothing on screen.
struct PendingMessageBubble: View {
    let text: String
    var files: [PickedFile] = []
    let bubbleWidth: CGFloat

    var body: some View {
        VStack(alignment: .trailing, spacing: 8) {
            if !text.isEmpty { ChatBubble(text: text) }
            ForEach(files) { file in
                if file.mimeType.hasPrefix("image/"), let image = ChatMedia.thumbnail(file.data, maxPixels: 640) {
                    ChatPicture(image: image).accessibilityLabel(file.name)
                } else {
                    FileChip(icon: "doc", name: file.name, detail: ByteCountFormatter.string(fromByteCount: Int64(file.data.count), countStyle: .file))
                }
            }
        }
        .frame(maxWidth: bubbleWidth, alignment: .trailing)
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
}

/// The helper: one character at the "now" edge of the conversation. Still while idle,
/// it proofs like rising dough while the employee works and plops once when a reply lands.
struct ConversationHelper: View {
    @EnvironmentObject private var client: HomeClient
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var textSize
    #if os(macOS)
    @Environment(\.appearsActive) private var appearsActive
    #else
    @Environment(\.scenePhase) private var scenePhase
    #endif
    @State private var awaitingReply = false
    @State private var landings = 0

    private var working: Bool { client.isWorking && client.interactions.isEmpty }
    private var windowIsActive: Bool {
        #if os(macOS)
        appearsActive
        #else
        scenePhase == .active
        #endif
    }
    private var reply: ReplyMark {
        ReplyMark(conversation: HomeDrafts.key(home: client.baseURLString, profile: client.selectedProfileID, chat: client.selectedChatID),
                  id: client.messages.last { $0.direction == "outbound" && !MessagePages.isOwnerReply($0) }?.id)
    }

    var body: some View {
        let name = client.activeAgentName
        HStack(spacing: 12) {
            character
            if working {
                Text(textSize.isAccessibilitySize ? L("Готовим ответ…") : L("\(name) is working…"))
                    .modifier(MetaLine())
                    .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // The helper sits at the edge where the employee's replies start, so Russian or English
        // replies in the Hebrew interface keep it under their first letters.
        .paragraphDirection(of: client.latestReplyText)
        .animation(.easeInOut(duration: 0.15), value: working)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(L("\(name) is working…"))
        .accessibilityHidden(!working)
        .onAppear { awaitingReply = working }
        .onChange(of: working) { _, now in if now { awaitingReply = true } }
        .onChange(of: reply) { old, new in
            defer { awaitingReply = working }
            guard old.conversation == new.conversation, new.id != old.id, new.id != nil, awaitingReply else { return }
            landings += 1
        }
        #if os(iOS)
        .sensoryFeedback(.impact(flexibility: .soft, intensity: 0.5), trigger: landings)
        #endif
    }

    private var character: some View {
        let avatar = AgentAvatar(appearance: client.activeAppearance, size: AvatarSize.toolbar)
        let still = reduceMotion
        return Group {
            if working && windowIsActive && !still {
                avatar.phaseAnimator([false, true]) { view, risen in
                    view.scaleEffect(x: risen ? 1.03 : 1, y: risen ? 0.95 : 1, anchor: .bottom)
                } animation: { _ in .easeInOut(duration: 0.9) }
            } else {
                avatar
            }
        }
        .keyframeAnimator(initialValue: 1.0, trigger: landings) { view, height in
            view.scaleEffect(x: 1, y: still ? 1 : height, anchor: .bottom)
        } keyframes: { _ in
            LinearKeyframe(0.86, duration: 0.09)
            SpringKeyframe(1, spring: Spring(response: 0.35, dampingRatio: 0.55))
        }
        .offlineCharacter(client.isOffline(client.activeProfile))
    }
}

private struct ReplyMark: Equatable {
    let conversation: String
    let id: String?
}

/// An approval or question from the employee: a surface card with one prominent action.
struct InteractionCard: View {
    @EnvironmentObject private var client: HomeClient
    @Environment(\.openURL) private var openURL
    let interaction: ChatInteraction
    @State private var answers: [String: String] = [:]
    @State private var busy = false
    @State private var error: String?

    private var needsContinue: Bool {
        interaction.questions.count > 1 || interaction.questions.first?.options.isEmpty == true
    }

    var body: some View {
        // Groups 16 apart; a question sits 8 above its answer; the card's padding is 16.
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                if let source = interaction.sourceTitle { Text("Telegram · " + source).modifier(MetaLine()) }
                Text(L10n.text(interaction.title)).font(AppTypography.interface.weight(.semibold))
                if let detail = interaction.detail, !detail.isEmpty {
                    Text(detail).font(AppTypography.interface).foregroundStyle(AppTheme.secondaryText).textSelection(.enabled)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            if let raw = interaction.url, let url = URL(string: raw) {
                Button(L("Открыть подключение"), systemImage: "arrow.up.forward") { openURL(url) }
                    .buttonStyle(CardButtonStyle(prominent: interaction.questions.isEmpty))
            }
            ForEach(interaction.questions) { question in
                VStack(alignment: .leading, spacing: 8) {
                    if !question.question.isEmpty { Text(L10n.text(question.question)).font(AppTypography.interface) }
                    if question.options.isEmpty {
                        TextField(L("Ваш ответ"), text: Binding(get: { answers[question.id] ?? "" }, set: { answers[question.id] = $0 }))
                            .textFieldStyle(.roundedBorder)
                            .accessibilityLabel(question.question.isEmpty ? L("Ваш ответ") : L10n.text(question.question))
                            .frame(minHeight: controlTarget)
                    } else {
                        // Short choices sit side by side; long ones stack.
                        ViewThatFits(in: .horizontal) {
                            HStack(spacing: 8) { options(for: question) }
                            VStack(alignment: .leading, spacing: 8) { options(for: question) }
                        }
                    }
                }
            }
            if needsContinue || busy || error != nil {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 12) {
                        if needsContinue {
                            Button(L("Продолжить")) { submit() }
                                .buttonStyle(CardButtonStyle(prominent: true))
                                .disabled(busy || interaction.questions.contains { (answers[$0.id] ?? "").isEmpty })
                        }
                        if busy { ProgressView().controlSize(.small) }
                    }
                    if let error { Text(UserFacingError.text(error)).font(AppTypography.meta).foregroundStyle(AppTheme.warning) }
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .chatSurface(AppTheme.surface, radius: Radius.card)
    }

    private func options(for question: ChatQuestion) -> some View {
        ForEach(question.options, id: \.self) { option in
            let chosen = interaction.questions.count > 1 && answers[question.id] == option
            Button {
                answers[question.id] = option
                if interaction.questions.count == 1 { submit() }
            } label: {
                HStack(spacing: 8) {
                    if chosen { Image(systemName: "checkmark").font(AppTypography.meta.weight(.semibold)) }
                    Text(L10n.text(option)).fixedSize(horizontal: false, vertical: true)
                }
            }
            .buttonStyle(CardButtonStyle(prominent: false))
            .accessibilityAddTraits(chosen ? .isSelected : [])
            .disabled(busy)
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

/// The transcript rows: earlier history, messages, pending sends, approvals, status and the helper.
/// Rhythm: 32 between turns, 12 between messages from the same side, 48 above a time heading
/// and 16 below it (none above the first), 12 above the helper.
struct TranscriptRows: View {
    @EnvironmentObject private var client: HomeClient
    let proxy: ScrollViewProxy
    @Binding var followsLatest: Bool
    @State private var columnWidth = Layout.column
    // Read live from the client so a history load notices a conversation switch.
    private var draftKey: String { HomeDrafts.key(home: client.baseURLString, profile: client.selectedProfileID, chat: client.selectedChatID) }

    private static let turn: CGFloat = 32
    private static let sameSide: CGFloat = 12
    private static let cluster: CGFloat = 48

    var body: some View {
        let rows = MessagePages.rows(client.feedMessages)
        let pending = client.visiblePendingMessages
        let shared = !client.usesEmployeeTimeline && (client.activeTelegramGroup != nil || MessagePages.isMultiAuthor(client.messages))
        let bubbleWidth = (columnWidth * 0.75).rounded()
        let start: CGFloat = client.hasEarlierMessages ? Self.sameSide : 0
        // The side of the last item so far: person (inbound) or employee.
        let lastIsPerson = pending.isEmpty ? rows.last?.message.direction == "inbound" : true
        let replySide = ParagraphDirection.of(client.latestReplyText)
        TranscriptStack {
            if client.hasEarlierMessages { loadEarlier }
            ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                // Keep one stable layout node per message, including its optional time heading.
                VStack(alignment: .leading, spacing: 16) {
                    if let header = row.header { ClusterHeader(date: header, hasTime: row.message.hasTime) }
                    MessageBubble(message: row.message, shared: shared || row.message.origin?.channel == "telegram" || row.message.origin?.channel == "archive", bubbleWidth: bubbleWidth, previous: row.previous, headed: row.header != nil, replySide: replySide)
                        #if os(macOS)
                        .help(exactTime(row.message))
                        #endif
                }
                .padding(.top, index == 0 ? start : row.header != nil ? Self.cluster : row.startsTurn ? Self.turn : Self.sameSide)
                .id(row.id)
                .accessibilityElement(children: .contain)
                // No avatars or author labels, so VoiceOver names the speaker here.
                .accessibilityLabel(speaker(row.message, shared: shared || row.message.origin?.channel == "telegram" || row.message.origin?.channel == "archive"))
                .accessibilityValue(exactTime(row.message))
            }
            ForEach(Array(pending.enumerated()), id: \.element.id) { index, message in
                let afterPerson = index > 0 || rows.last?.message.direction == "inbound"
                let opens = index == 0 && MessagePages.opensCluster(.now, after: rows.last?.message.sentAt)
                VStack(alignment: .trailing, spacing: 4) {
                    if opens { ClusterHeader(date: .now, hasTime: true).padding(.bottom, 12) }
                    if let title = message.telegramChatTitle { Text("Telegram · " + title).modifier(MetaLine()) }
                    PendingMessageBubble(text: message.text, files: message.files, bubbleWidth: bubbleWidth)
                    if let error = message.error {
                        let notSent = message.deliveryState == "not_sent"
                        Text((notSent ? L("Не отправлено в Telegram") + ". " : "") + UserFacingError.text(error)).modifier(MetaLine()).foregroundStyle(AppTheme.warning)
                            .multilineTextAlignment(.trailing).padding(.trailing, 16)
                        if notSent {
                            // The Home refused it, so nothing reached Telegram: open the group there, or drop the text.
                            if let raw = client.messages.first(where: { $0.id == message.telegramReplyToID })?.origin?.url, let url = URL(string: raw), url.scheme == "https", url.host == "t.me" {
                                Link(L("Открыть в Telegram"), destination: url).modifier(StatusAction())
                            }
                            Button(L("Удалить")) { client.discardPending(message) }
                                .modifier(StatusAction()).accessibilityIdentifier("discardTelegramReply-" + message.id.uuidString)
                        } else if message.operationID == nil {
                            Button(L("Проверить доставку и повторить")) { Task { await client.retry(message) } }
                                .modifier(StatusAction())
                        }
                    } else if let delivery = message.deliveryState {
                        Text(delivery == "waiting_for_device" ? L("Сообщение сохранено. Ждём подключения устройства.") : L("Сообщение сохранено. Передаём сотруднику."))
                            .modifier(MetaLine()).multilineTextAlignment(.trailing).padding(.trailing, 16)
                        if client.canManageOpenAI {
                            Button(L("Отменить доставку")) { Task { await client.cancelPending(message) } }
                                .modifier(StatusAction())
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .trailing)
                .paragraphDirection(replySide)
                .padding(.top, rows.isEmpty && index == 0 ? start : opens ? Self.cluster : afterPerson ? Self.sameSide : Self.turn)
                .id(message.id)
                .accessibilityElement(children: .contain)
                .accessibilityLabel(L("Вы"))
            }
            ForEach(Array(client.interactions.enumerated()), id: \.element.id) { index, interaction in
                InteractionCard(interaction: interaction)
                    .padding(.top, index == 0 && lastIsPerson ? Self.turn : Self.sameSide)
                    .id(interaction.id)
            }
            if let error = client.syncError {
                Text(UserFacingError.text(error)).modifier(MetaLine()).foregroundStyle(AppTheme.warning)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, Self.sameSide)
            }
            ConversationHelper()
                .padding(.top, 12)
                .id("conversation-helper")
            // Scrolling to the latest message keeps a turn's worth of room under the helper.
            Color.clear.frame(height: 24).id("conversation-bottom")
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { columnWidth = $0 }
    }

    private var loadEarlier: some View {
        Button {
            let anchor = client.messages.first?.id
            let conversation = draftKey
            followsLatest = false
            Task {
                await client.loadEarlierMessages()
                await Task.yield()
                guard conversation == draftKey, let anchor else { return }
                proxy.scrollTo(anchor, anchor: .top)
            }
        } label: {
            HStack(spacing: 8) {
                if client.isLoadingEarlier { ProgressView().controlSize(.mini) }
                Text(client.isLoadingEarlier ? L("Загружаем историю…") : L("Показать более ранние сообщения"))
            }
            .modifier(MetaLine())
            .frame(minHeight: controlTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(client.isLoadingEarlier)
        .frame(maxWidth: .infinity)
    }

    private func exactTime(_ message: HomeMessage) -> String {
        message.sentAt.map { ChatClock.exact($0, hasTime: message.hasTime) } ?? ""
    }

    private func speaker(_ message: HomeMessage, shared: Bool) -> String {
        if MessagePages.isOwnerReply(message) { return L("Вы") }
        guard message.direction == "inbound" else { return client.activeAgentName }
        return shared ? message.author ?? "" : L("Вы")
    }
}

extension HomeClient {
    /// The messages the feed shows. In a group where the employee decides by its rules, a message waits
    /// for that decision; a mention group sends the employee only real requests.
    /// News stories live in the reader; the chat keeps the conversation with the employee.
    var feedMessages: [HomeMessage] {
        MessagePages.feed(messages.filter { $0.story == nil }, decidingChats: Set((telegram?.chats ?? []).filter { $0.isGroup && $0.replies != "mentions" }.map(\.chatId)),
                          awaiting: Set(interactions.map(\.messageId)))
    }

    /// The employee's latest words, without service notices. Their direction is the conversation's text edge.
    var latestReplyText: String { messages.last { $0.direction == "outbound" && $0.kind != "notice" && !MessagePages.isOwnerReply($0) }?.text ?? "" }
}

/// Card actions at one height and radius. The one prominent action is ink with a canvas-coloured
/// label; the others are a quiet tint of the text colour. Neither changes with window focus.
private struct CardButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    let prominent: Bool

    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
        configuration.label
            .font(AppTypography.interface.weight(.medium))
            .labelStyle(CardButtonLabel())
            .foregroundStyle(label)
            .padding(.horizontal, 12)
            .padding(.vertical, 4)
            .frame(minHeight: controlTarget)
            .background(fill(pressed: configuration.isPressed), in: shape)
            .contentShape(shape)
    }

    private var label: AnyShapeStyle {
        guard isEnabled else { return AnyShapeStyle(.tertiary) }
        return prominent ? AnyShapeStyle(AppTheme.canvas) : AnyShapeStyle(.primary)
    }

    private func fill(pressed: Bool) -> AnyShapeStyle {
        guard isEnabled else { return AnyShapeStyle(.primary.opacity(0.06)) }
        if prominent { return AnyShapeStyle(pressed ? AppTheme.accentText.mix(with: AppTheme.canvas, by: 0.25) : AppTheme.accentText) }
        return AnyShapeStyle(.primary.opacity(pressed ? 0.14 : 0.08))
    }
}

/// An icon and its label: 8 apart.
private struct CardButtonLabel: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 8) { configuration.icon; configuration.title }
    }
}

/// A quiet action under a pending message: retry or cancel delivery.
private struct StatusAction: ViewModifier {
    func body(content: Content) -> some View {
        content
            .font(AppTypography.meta.weight(.medium))
            .foregroundStyle(AppTheme.accentText)
            .buttonStyle(.plain)
            .frame(minHeight: controlTarget)
            .padding(.trailing, 16)
    }
}
