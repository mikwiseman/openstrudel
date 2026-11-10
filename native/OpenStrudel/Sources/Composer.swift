import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

/// The composer's grid. Controls hang in gutters on both sides, so all text inside the glass
/// starts on one edge, and every shape inside is concentric with the glass. One line of text makes a capsule.
private enum ComposerMetrics {
    #if os(macOS)
    /// 9 + 32 + 9 = 50.
    static let padding: CGFloat = 9
    static let spacing: CGFloat = 6
    static let glyph = Font.system(size: 16, weight: .regular)
    static let rowGlyph = Font.system(size: 13, weight: .medium)
    /// 25 − (9 + (32 − 28) / 2) = 14: the send circle is concentric with the glass.
    static let send: CGFloat = 28
    #else
    /// 5 + 44 + 5 = 54 with full-size touch targets.
    static let padding: CGFloat = 5
    static let spacing: CGFloat = 2
    static let glyph = Font.system(size: 20, weight: .regular)
    static let rowGlyph = Font.system(size: 15, weight: .medium)
    /// 27 − (5 + (44 − 32) / 2) = 16.
    static let send: CGFloat = 32
    #endif
    /// Where typed, queued and placeholder text starts.
    static var textEdge: CGFloat { padding + controlTarget + spacing }
    static let tile: CGFloat = 48
    /// 24 − 12 = 12, so attachment tiles are concentric with the glass.
    static let tileInset: CGFloat = Radius.composer - Radius.card
    static let trayHeight: CGFloat = 168
    static let lines = 8
}

/// What the next message carries, inside the glass above the text: one line, one way to take it off.
struct ContextChip: View {
    let context: ChatContext
    let remove: () -> Void
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: context.symbol).imageScale(.small).foregroundStyle(AppTheme.secondaryText)
            Text(context.label).font(AppTypography.interface.weight(.medium)).lineLimit(1)
            Button(action: remove) {
                Image(systemName: "xmark").font(.caption.weight(.semibold)).frame(minWidth: 28, minHeight: 28).contentShape(Rectangle())
            }
            .buttonStyle(.plain).foregroundStyle(AppTheme.secondaryText)
            .accessibilityLabel(L("Убрать контекст")).accessibilityIdentifier("removeDraftContext")
        }
        .padding(.leading, 12).padding(.trailing, 4).padding(.vertical, 4)
        .background(AppTheme.surface, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(context.label)
        .accessibilityIdentifier("draftContext")
    }
}

struct Composer: View {
    @EnvironmentObject private var client: HomeClient
    @Environment(\.dynamicTypeSize) private var textSize
    @Environment(\.layoutDirection) private var layoutDirection
    #if os(macOS)
    @Environment(\.fontResolutionContext) private var fontContext
    #endif
    @Binding var draft: String
    @Binding var files: [PickedFile]
    /// The client, message or story the next message carries, removable until it is sent.
    @Binding var context: ChatContext?
    @FocusState.Binding var focused: Bool
    let contextID: String
    let canSend: Bool
    let send: (ComposerSendMode) -> Void
    @State private var sendMode: ComposerSendMode = .steer
    @State private var showFiles = false
    @State private var showPhotos = false
    @State private var photoSelection: [PhotosPickerItem] = []
    @State private var fileError: String?
    @State private var dictationError: String?
    @State private var importTask: Task<Void, Never>?
    @State private var importID = UUID()
    @State private var importing = false
    @StateObject private var voice = VoiceCapture()
    @Environment(\.scenePhase) private var recordingScenePhase
    @ObservedObject private var dictationAssets = DictationAssets.shared
    @State private var showDictation = false
    @State private var editingMessage: HomeMessage?
    @State private var queuedContentHeight: CGFloat = 44
    @State private var dropTargeted = false
    private var hasContent: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !files.isEmpty }

    var body: some View {
        composerContents
        .glassEffect(.regular, in: .rect(cornerRadius: Radius.composer, style: .continuous))
        .overlay {
            if dropTargeted {
                RoundedRectangle(cornerRadius: Radius.composer, style: .continuous)
                    .strokeBorder(AppTheme.accentText, lineWidth: 2).allowsHitTesting(false)
            }
        }
        .onDrop(of: [.fileURL, .image], isTargeted: $dropTargeted) { providers in
            guard voice.phase == .idle else { return false }
            importProviders(providers); return true
        }
        // Sheets start from the system's direction, so they take the interface language again.
        .sheet(isPresented: $showDictation) { DictationSetupView(speechQuery: client.speechQuery) { Task { await startDictation() } }.modifier(InterfaceLanguage()) }
        .sheet(item: $editingMessage) { message in QueuedMessageEditor(message: message).environmentObject(client).modifier(InterfaceLanguage()) }
        .photosPicker(isPresented: $showPhotos, selection: $photoSelection, maxSelectionCount: nil, matching: .images)
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
                        picked.append(PickedFile(name: L("Фото") + "." + (type.preferredFilenameExtension ?? "jpg"), mimeType: type.preferredMIMEType ?? "image/jpeg", data: data))
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
                    let selection = try await AttachmentImport.files(at: urls)
                    completeImport(selection, id: id, context: context)
                } catch { reportImportError(error, id: id, context: context) }
            }
        }
        .onAppear { attachVoice() }
        .onChange(of: contextID) { _, _ in editingMessage = nil; cancelImport(); attachVoice() }
        .onDisappear { cancelImport(); voice.detach() }
        .onChange(of: recordingScenePhase) { _, phase in
            #if os(iOS)
            if phase == .background && voice.phase == .recording { voice.finish(send: false) }
            #endif
        }
        .alert(L("Не удалось добавить файл"), isPresented: Binding(get: { fileError != nil }, set: { if !$0 { fileError = nil } })) { Button(L("Понятно"), role: .cancel) {} } message: { Text(fileError ?? "") }
        .alert(L("Не удалось начать диктовку"), isPresented: Binding(get: { dictationError != nil }, set: { if !$0 { dictationError = nil } })) { Button(L("Понятно"), role: .cancel) {} } message: { Text(dictationError ?? "") }
    }

    private var composerContents: some View {
        VStack(alignment: .leading, spacing: 0) {
            if client.health?.turnControlVersion == 1 && !client.visibleQueuedMessages.isEmpty { queueTray }
            if let context {
                ContextChip(context: context) { self.context = nil }
                    .padding(.horizontal, ComposerMetrics.tileInset).padding(.top, ComposerMetrics.tileInset)
            }
            if !files.isEmpty { attachmentTiles }
            if voice.phase != .idle {
                VoiceRecordingRow(voice: voice, canSend: canSend)
            } else {
                if !voice.detail.isEmpty {
                    Text(L10n.serviceText(voice.detail)).font(AppTypography.meta).foregroundStyle(AppTheme.secondaryText)
                        .padding(.leading, ComposerMetrics.textEdge).padding(.trailing, ComposerMetrics.padding).padding(.top, 12)
                }
                inputRow.padding(ComposerMetrics.padding)
                // The model's line appears with the keyboard or the first words; at rest the composer is one capsule.
                if focused || hasContent, client.health?.conversationModelsVersion == 1, !client.isEmployeeDraft, let conversationID = client.conversationID {
                    HStack {
                        Spacer(minLength: 0)
                        ConversationModelControl(conversationID: conversationID)
                            .id(conversationID)
                    }
                    .padding(.horizontal, ComposerMetrics.textEdge)
                    .padding(.bottom, ComposerMetrics.padding)
                    .transition(.opacity)
                }
            }
        }
        .animation(.smooth(duration: 0.2), value: focused || hasContent)
    }

    // MARK: Queue and attachments, inside the glass above the text

    /// Messages that wait for the current reply. Their text shares the draft's edge, and their
    /// actions share the microphone and send columns.
    private var queueTray: some View {
        VStack(alignment: .leading, spacing: 0) {
            // A control-sized row, so the clock sits on the corner's centre exactly like the plus below.
            HStack(spacing: ComposerMetrics.spacing) {
                Image(systemName: "clock").frame(width: controlTarget)
                Text(L("После ответа"))
            }
            .font(AppTypography.meta).foregroundStyle(AppTheme.secondaryText)
            .frame(height: controlTarget).padding(.top, ComposerMetrics.padding)
            .accessibilityElement(children: .combine).accessibilityAddTraits(.isHeader)
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(client.visibleQueuedMessages) { queued in queuedRow(queued) }
                }
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { queuedContentHeight = $0 }
            }
            .frame(height: min(ComposerMetrics.trayHeight, queuedContentHeight))
            .scrollBounceBehavior(.basedOnSize)
        }
        .padding(.horizontal, ComposerMetrics.padding)
    }

    private func queuedRow(_ queued: HomeMessage) -> some View {
        HStack(spacing: ComposerMetrics.spacing) {
            Button { editingMessage = queued } label: {
                VStack(alignment: .leading, spacing: 0) {
                    Text(queued.text.isEmpty ? L("Вложение") : queued.text).font(AppTypography.interface).lineLimit(2)
                    if let files = queued.attachments, !files.isEmpty {
                        Text(files.map(\.name).joined(separator: ", ")).font(AppTypography.meta).foregroundStyle(AppTheme.secondaryText).lineLimit(1)
                    }
                }
                .padding(.vertical, 4)
                .frame(maxWidth: .infinity, minHeight: controlTarget, alignment: .leading).contentShape(Rectangle())
                // A queued message keeps the side it was typed on in the field below.
                .environment(\.layoutDirection, ReadingDirection.of(queued.text) ?? layoutDirection)
            }.buttonStyle(.plain).disabled(client.health?.queueControlVersion != 1)
                .accessibilityLabel(L("Edit message: \(queued.text.isEmpty ? L("Вложение") : queued.text)"))
                .accessibilityIdentifier("editQueuedMessage-" + queued.id)
            HStack(spacing: 0) {
                if client.health?.queueControlVersion == 1 && client.visibleQueuedMessages.count > 1 {
                    Button { Task { await client.moveQueuedMessageFirst(queued) } } label: { rowGlyph("arrow.up.to.line") }
                        .buttonStyle(.borderless).disabled(client.visibleQueuedMessages.first?.id == queued.id)
                        .accessibilityLabel(L("В начало очереди")).help(L("Отправить первым после текущего ответа"))
                }
                Button { Task { await client.cancelMessage(queued) } } label: { rowGlyph("xmark") }
                    .buttonStyle(.borderless).accessibilityLabel(L("Убрать сообщение из очереди"))
            }
        }
        .padding(.leading, controlTarget + ComposerMetrics.spacing)
    }

    private var attachmentTiles: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 12) {
                ForEach(files) { file in
                    AttachmentTile(file: file) { files.removeAll { $0.id == file.id } }
                }
            }
            .padding(.horizontal, ComposerMetrics.tileInset).padding(.top, ComposerMetrics.tileInset)
        }
        .scrollIndicators(.hidden)
    }

    // MARK: The control row

    @ViewBuilder private var inputRow: some View {
        if textSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: 0) {
                draftField.padding(.horizontal, ComposerMetrics.tileInset - ComposerMetrics.padding)
                HStack(spacing: ComposerMetrics.spacing) { attachmentMenu; Spacer(minLength: 0); inputActions }
            }
        } else {
            HStack(alignment: .bottom, spacing: ComposerMetrics.spacing) { attachmentMenu; draftField; inputActions }
        }
    }

    private func controlGlyph(_ name: String) -> some View { ControlGlyph(name: name, font: ComposerMetrics.glyph) }
    private func rowGlyph(_ name: String) -> some View { ControlGlyph(name: name, font: ComposerMetrics.rowGlyph) }

    /// A menu draws its own label only with the plain style; borderless hands it to AppKit,
    /// which drops the 32-pt target and the secondary colour.
    private var attachmentMenu: some View {
        Menu {
            Button(L("Выбрать фото…"), systemImage: "photo") { showPhotos = true }
            Button(L("Прикрепить файл…"), systemImage: "paperclip") { showFiles = true }
        } label: { ControlGlyph(name: "plus", font: ComposerMetrics.glyph, ink: true) }
            .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden)
            .accessibilityLabel(L("Прикрепить фото или файл"))
            .help(L("Прикрепить фото или файл до 25 МБ"))
            .disabled(importing)
    }

    /// In a draft the composer is the screen's only action, so it asks for the role like the sidebar row.
    private var placeholder: String {
        client.isEmployeeDraft ? L("Опишите его задачу") : L("Message \(client.activeAgentName)")
    }

    @ViewBuilder private var draftField: some View {
        #if os(macOS)
        let font = ComposerTextField.readingFont(in: fontContext)
        let insets = ComposerTextField.insets(for: font, controlHeight: controlTarget)
        ComposerTextField(text: $draft, focused: Binding(get: { focused }, set: { focused = $0 }), placeholder: placeholder, paste: { providers in
            guard voice.phase == .idle else { return }
            importProviders(providers)
        }, submit: { if canSend && hasContent && !importing { send(sendMode) } })
            .padding(.top, insets.top).padding(.bottom, insets.bottom)
        #else
        TextField(L("Сообщение"), text: $draft, prompt: Text(placeholder).foregroundStyle(AppTheme.secondaryText), axis: .vertical)
                .accessibilityLabel(L("Сообщение")).accessibilityIdentifier("messageComposer")
                .textFieldStyle(.plain)
                .font(AppTypography.reading)
                .lineSpacing(AppTypography.readingLineSpacing)
                .lineLimit(1...(textSize.isAccessibilitySize ? 2 : ComposerMetrics.lines))
                .padding(.vertical, 11)
                .frame(minHeight: controlTarget)
                .focused($focused)
                .onSubmit { if canSend && hasContent && !importing { send(sendMode) } }
        #endif
    }

    private var showsSendMode: Bool { hasContent && client.isSending && client.health?.turnControlVersion == 1 }

    private func symbol(for mode: ComposerSendMode) -> String {
        mode == .queue ? "clock" : layoutDirection == .rightToLeft ? "arrow.turn.down.left" : "arrow.turn.down.right"
    }

    @ViewBuilder private var inputActions: some View {
        actions.animation(.spring(response: 0.3, dampingFraction: 0.75), value: hasContent || canStop)
    }

    @ViewBuilder private var actions: some View {
        HStack(spacing: 0) {
            if showsSendMode {
                Menu {
                    Picker(L("Отправка во время ответа"), selection: $sendMode) {
                        ForEach(ComposerSendMode.allCases, id: \.self) { Label($0.title, systemImage: symbol(for: $0)).tag($0) }
                    }.pickerStyle(.inline)
                } label: { controlGlyph(symbol(for: sendMode)) }
                    .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden)
                    .accessibilityLabel(sendMode.title).help(sendMode.title)
            }

            if importing {
                ProgressView().controlSize(.small).frame(width: controlTarget, height: controlTarget)
                    .accessibilityLabel(L("Добавляем файлы"))
            } else {
                Button {
                    focused = true
                    Task { await startDictation() }
                } label: { controlGlyph("mic") }
                    .buttonStyle(.borderless).accessibilityLabel(L("Голосовой ввод")).accessibilityIdentifier("voiceInput")
                // The ink circle arrives with something to send, or with an answer to stop.
                if hasContent || canStop { sendButton.transition(.scale(scale: 0.6).combined(with: .opacity)) }
            }
        }
    }

    private var canStop: Bool { !hasContent && client.activeMessage != nil && client.health?.turnControlVersion == 1 }

    private var sendButton: some View {
        Button {
            if !hasContent, let active = client.activeMessage, client.health?.turnControlVersion == 1 { Task { await client.cancelMessage(active) } }
            else { send(sendMode) }
        } label: {
            Image(systemName: canStop ? "stop.fill" : "arrow.up")
                .font(.system(size: canStop ? 11 : 14, weight: .bold))
        }
        .buttonStyle(SendButtonStyle())
        .disabled(!canSend || (!hasContent && !canStop))
        .accessibilityLabel(canStop ? L("Остановить ответ") : client.isSending ? sendMode.title : L("Отправить"))
        .accessibilityIdentifier("sendMessage")
        .help(canStop ? L("Остановить текущий ответ") : L("Отправить сообщение (⌘Return)"))
        .keyboardShortcut(hasContent ? KeyboardShortcut(.return, modifiers: .command) : nil)
    }

    private func attachVoice() {
        voice.attach(context: contextID) { text, sendNow in
            draft = draft.isEmpty ? text : draft + "\n" + text
            focused = true
            if sendNow && client.isConfigured && !client.connectionNeedsPairing && client.openAIAccount?.connected != false { send(sendMode) }
        }
        // A recovered draft resolves the selected Home's setting when retried.
        // A fresh recording captures its provider below before the microphone starts.
        let query = client.speechQuery
        voice.useRecognizer { file in
            if client.health?.speechVersion == 1 {
                let settings: SpeechSettings = try await client.management("/v1/settings/speech" + query)
                if settings.provider == "elevenlabs" { return try await client.transcribeRecording(file, query: query) }
            }
            return try await ParakeetTranscriber.shared.transcribe(file: file)
        }
    }

    private func startDictation() async {
        let context = contextID, query = client.speechQuery
        do {
            if client.health?.speechVersion == 1 {
                let settings: SpeechSettings = try await client.management("/v1/settings/speech" + query)
                guard context == contextID else { return }
                if settings.provider == "elevenlabs" {
                    guard settings.connected else { showDictation = true; return }
                    voice.useRecognizer({ file in try await client.transcribeRecording(file, query: query) }, detail: L("Распознаём в ElevenLabs…"))
                    voice.start(); return
                }
            }
            voice.useRecognizer(nil)
            await dictationAssets.check()
            guard context == contextID else { return }
            if dictationAssets.state == .ready && UserDefaults.standard.bool(forKey: "openstrudel.dictationIntroduced") { voice.start() }
            else { showDictation = true }
        } catch { dictationError = UserFacingError.text(error.localizedDescription) }
    }

    private func importProviders(_ providers: [NSItemProvider]) {
        guard !providers.isEmpty, !importing, voice.phase == .idle else { return }
        let (id, context) = beginImport()
        importTask = Task {
            defer { if importID == id { importing = false } }
            do { completeImport(try await AttachmentImport.providers(providers), id: id, context: context) }
            catch { reportImportError(error, id: id, context: context) }
        }
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
        files.append(contentsOf: selection)
    }

    private func reportImportError(_ error: Error, id: UUID, context: String) {
        guard importID == id, contextID == context, !AttachmentImport.isCancellation(error), !Task.isCancelled else { return }
        fileError = (error as? AttachmentImport.Failure)?.errorDescription ?? L("Не удалось открыть файл. Проверьте, что он доступен на устройстве, и выберите его ещё раз.")
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

/// The one filled control: an ink circle with a canvas-coloured glyph, and the system's
/// quiet fill and tertiary glyph while there is nothing to send. A custom style, because
/// AppKit greys prominent buttons out whenever the window is inactive.
private struct SendButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(isEnabled ? AnyShapeStyle(AppTheme.canvas) : AnyShapeStyle(.tertiary))
            .frame(width: ComposerMetrics.send, height: ComposerMetrics.send)
            .background(fill(pressed: configuration.isPressed), in: Circle())
            .frame(width: controlTarget, height: controlTarget)
            .contentShape(Rectangle())
    }

    private func fill(pressed: Bool) -> AnyShapeStyle {
        guard isEnabled else { return AnyShapeStyle(.quaternary) }
        // Pressing moves the ink a step toward the canvas in both appearances.
        return AnyShapeStyle(pressed ? AppTheme.accentText.mix(with: AppTheme.canvas, by: 0.25) : AppTheme.accentText)
    }
}

/// A borderless control's glyph: SecondaryText (ink for the plus), and the system's tertiary while disabled.
private struct ControlGlyph: View {
    @Environment(\.isEnabled) private var isEnabled
    let name: String
    let font: Font
    var ink = false

    var body: some View {
        Image(systemName: name).font(font)
            .foregroundStyle(isEnabled ? (ink ? AnyShapeStyle(.primary) : AnyShapeStyle(AppTheme.secondaryText)) : AnyShapeStyle(.tertiary))
            .frame(width: controlTarget, height: controlTarget).contentShape(Rectangle())
    }
}

/// Dictation takes the input row's place on the same grid: the waveform and status start on the
/// text edge, stop sits in the microphone's column and send in its own, so the glass stays 48 tall.
private struct VoiceRecordingRow: View {
    @ObservedObject var voice: VoiceCapture
    @Environment(\.dynamicTypeSize) private var textSize
    let canSend: Bool

    var body: some View {
        let layout = textSize.isAccessibilitySize && voice.phase != .recording
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: ComposerMetrics.spacing))
            : AnyLayout(HStackLayout(spacing: ComposerMetrics.spacing))
        layout {
            Button { voice.cancel() } label: { ControlGlyph(name: "xmark", font: ComposerMetrics.glyph) }
                .buttonStyle(.borderless).accessibilityLabel(L("Отменить запись"))
            if voice.phase == .recording {
                waveform
                Text(String(format: "%d:%02d", voice.seconds / 60, voice.seconds % 60))
                    .font(AppTypography.meta.monospacedDigit()).foregroundStyle(AppTheme.secondaryText)
                HStack(spacing: 0) {
                    Button { voice.finish(send: false) } label: { ControlGlyph(name: "stop.fill", font: ComposerMetrics.glyph) }
                        .buttonStyle(.borderless).accessibilityLabel(L("Остановить и проверить текст"))
                    Button { voice.finish(send: true) } label: { Image(systemName: "arrow.up").font(.system(size: 13, weight: .bold)) }
                        .buttonStyle(SendButtonStyle()).disabled(!canSend).accessibilityLabel(L("Распознать и отправить"))
                }
            } else {
                Text(L10n.serviceText(voice.detail)).font(AppTypography.meta).foregroundStyle(AppTheme.secondaryText)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if voice.phase == .saved {
                    Button { voice.finish(send: false) } label: {
                        Text(L("Распознать")).font(AppTypography.interface.weight(.medium)).foregroundStyle(AppTheme.accentText)
                            .padding(.horizontal, 8).frame(minHeight: controlTarget).contentShape(Rectangle())
                    }.buttonStyle(.plain)
                } else {
                    // Where the microphone stands, like the progress of an import.
                    ProgressView().controlSize(.small).frame(width: controlTarget, height: controlTarget)
                }
            }
        }
        .padding(ComposerMetrics.padding)
        .accessibilityElement(children: .contain).accessibilityLabel(voice.phase == .recording ? L("Идёт запись") : L("Голосовой ввод"))
    }

    private var waveform: some View {
        Canvas { context, size in
            let count = min(VoiceCapture.maximumLevels, max(1, Int(size.width / 6)))
            let samples = Array(voice.levels.suffix(count))
            for index in 0..<count {
                let sampleIndex = index - (count - samples.count)
                let level = sampleIndex < 0 ? 0 : samples[sampleIndex]
                let height = max(3, level * size.height)
                let rect = CGRect(x: CGFloat(index) * size.width / CGFloat(count), y: (size.height - height) / 2, width: 3, height: height)
                context.fill(Path(roundedRect: rect, cornerRadius: 2), with: .foreground)
            }
        }
        // As tall as the send circle.
        .frame(height: ComposerMetrics.send).accessibilityHidden(true)
    }
}

/// A picked photo or file, 48 tall with radius 12 so it nests in the glass.
private struct AttachmentTile: View {
    @Environment(\.colorSchemeContrast) private var contrast
    let file: PickedFile
    let remove: () -> Void
    private var shape: RoundedRectangle { RoundedRectangle(cornerRadius: Radius.card, style: .continuous) }

    var body: some View {
        content
            .frame(height: ComposerMetrics.tile)
            .clipShape(shape)
            .overlay { if contrast == .increased { shape.strokeBorder(AppTheme.separator, lineWidth: 1) } }
            .overlay(alignment: .topTrailing) {
                // The badge sits on the corner's curve: 4 pt in from each edge.
                Button(action: remove) {
                    Image(systemName: "xmark.circle.fill").font(.system(size: 16))
                        .symbolRenderingMode(.palette).foregroundStyle(AppTheme.canvas, AppTheme.secondaryText)
                        .background(Circle().fill(AppTheme.canvas).padding(-1.5))
                        .frame(width: controlTarget, height: controlTarget).contentShape(Circle())
                }
                .buttonStyle(.plain)
                .alignmentGuide(.top) { $0[VerticalAlignment.center] - 4 }
                .alignmentGuide(.trailing) { $0[HorizontalAlignment.center] + 4 }
                .accessibilityLabel(L("Remove \(file.name)"))
            }
    }

    @ViewBuilder private var content: some View {
        if file.mimeType.hasPrefix("image/"), let image = ChatMedia.thumbnail(file.data) {
            Image(decorative: image, scale: 1).resizable().scaledToFill()
                .frame(width: ComposerMetrics.tile, height: ComposerMetrics.tile)
                .accessibilityElement().accessibilityLabel(file.name)
        } else {
            let details = ChatAttachment(id: file.id.uuidString, conversationId: "", name: file.name, mimeType: file.mimeType, size: file.data.count)
            HStack(spacing: 8) {
                Image(systemName: details.icon).font(.system(size: 17)).foregroundStyle(AppTheme.secondaryText).frame(width: 20)
                VStack(alignment: .leading, spacing: 0) {
                    Text(file.name).font(AppTypography.interface.weight(.medium)).lineLimit(1).truncationMode(.middle)
                    Text(details.sizeLabel).font(AppTypography.meta).monospacedDigit().foregroundStyle(AppTheme.secondaryText)
                }
            }
            .padding(.leading, 12).padding(.trailing, 16)
            .frame(maxWidth: 220, maxHeight: .infinity, alignment: .leading)
            .fixedSize(horizontal: true, vertical: false)
            .background(AppTheme.surface)
            .accessibilityElement(children: .combine)
        }
    }
}

struct QueuedMessageEditor: View {
    @EnvironmentObject private var client: HomeClient
    @Environment(\.dismiss) private var dismiss
    let message: HomeMessage
    @State private var text: String
    @State private var saving = false
    @State private var error: String?
    @FocusState private var focused: Bool

    init(message: HomeMessage) { self.message = message; _text = State(initialValue: message.text) }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                #if os(macOS)
                // On the Mac a single-page sheet carries its title in its content, on the text's edge.
                Text(L("Изменить сообщение")).font(AppTypography.title)
                #endif
                TextEditor(text: $text)
                    .font(AppTypography.reading).lineSpacing(AppTypography.readingLineSpacing)
                    .scrollContentBackground(.hidden)
                    #if os(macOS)
                    // TextKit pads each line by 5 pt; give it back so the text shares the title's edge.
                    .padding(.horizontal, -5)
                    #endif
                    .focused($focused)
                    .frame(minHeight: 160)
                    .accessibilityLabel(L("Текст сообщения в очереди"))
                    .accessibilityIdentifier("queuedMessageText")
                if let files = message.attachments, !files.isEmpty {
                    // A fixed icon column, so every name starts on one edge.
                    ForEach(files) { file in
                        HStack(spacing: 8) {
                            Image(systemName: file.icon).frame(width: 20)
                            Text(file.name).lineLimit(1).truncationMode(.middle)
                        }
                        .font(AppTypography.interface).foregroundStyle(AppTheme.secondaryText)
                        .accessibilityElement(children: .combine)
                    }
                }
                if let error { Text(L10n.serviceText(error)).font(AppTypography.interface).foregroundStyle(AppTheme.warning).textSelection(.enabled) }
            }
            .padding(24)
            #if os(iOS)
            .navigationTitle(L("Изменить сообщение"))
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(L("Отмена")) { dismiss() }.disabled(saving).keyboardShortcut(.cancelAction) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? L("Сохраняем…") : L("Сохранить")) {
                        saving = true; error = nil
                        Task {
                            do { try await client.editQueuedMessage(message, text: text); dismiss() }
                            catch { self.error = error.localizedDescription }
                            saving = false
                        }
                    }.disabled(saving || text == message.text || (text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && (message.attachments ?? []).isEmpty))
                }
            }
        }
        #if os(macOS)
        .frame(idealWidth: 480, idealHeight: 280)
        .presentationSizing(.fitted)
        #endif
        .interactiveDismissDisabled(saving)
        .onAppear { focused = true }
    }
}
